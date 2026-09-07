import test from 'brittle'
import b4a from 'b4a'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { Duplex } from 'streamx'
import { decodeId } from '@cero-base/core/blobs'
import { Invite } from '@cero-base/core/invite'

import { cero, put, set, get, del, watch, changes, call, open, rotate } from '../../src/index.js'
import { serve } from '../../src/rpc/server.js'
import { connect } from '../../src/rpc/client.js'
import { bindCodec } from '@cero-base/core/rpc'
import { spec } from '../fixtures/spec/index.js'
import { makeTestnet, observe, waitUntil, fetch } from '../helpers/index.js'

test.configure({ timeout: 90000 })

function pair() {
  let a, b
  a = new Duplex({
    write(data, cb) {
      b.push(data)
      cb(null)
    }
  })
  b = new Duplex({
    write(data, cb) {
      a.push(data)
      cb(null)
    }
  })
  return [a, b]
}

async function openPair(t, serverOpts = {}, clientOpts) {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()

  const [serverStream, clientStream] = pair()
  const server = await serve(serverStream, spec, {
    storage: dir,
    bootstrap: testnet.bootstrap,
    ...serverOpts
  })
  const client = await connect(clientStream, spec, clientOpts)

  t.teardown(
    async () => {
      try {
        await client.close()
      } catch {}
      try {
        await server.close()
      } catch {}
    },
    { order: 5 }
  )

  return { me: server.me, server, client }
}

// ─── bundleability ────────────────────────────────────────────────────────

// The RPC client is bundled by Metro for React Native, where native addons
// cannot exist — the UI half only talks to the worker, it never does crypto.
// Server-only code entering the client's import graph breaks the mobile build
// while desktop keeps working (Node resolves the addon fine), so the failure
// shows up far from its cause. This walks the client's real static-import
// graph and fails the moment anything native is reachable.
test('client: the import graph stays free of native/server-only packages', (t) => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const exportsOf = (pkg) =>
    JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8')).exports
  const resolveCero = (spec) => {
    const parts = spec.split('/')
    const pkg = parts[1] === 'core' ? 'core' : 'cero'
    const entry = exportsOf(pkg)[parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.']
    return entry ? join(root, 'packages', pkg, entry.default || entry) : null
  }

  const seen = new Set()
  const external = new Map() // package → the chain that reached it
  const walk = (file, chain) => {
    if (seen.has(file)) return
    seen.add(file)
    let src
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      return
    }
    // `from '…'` (named/default) and bare side-effect `import '…'`
    const specs = [
      ...src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g),
      ...src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)
    ].map((m) => m[1])

    for (const spec of specs) {
      const next = [...chain, relative(root, file)]
      if (spec.startsWith('.')) {
        let p = resolve(dirname(file), spec)
        if (!existsSync(p) && existsSync(`${p}.js`)) p += '.js'
        walk(p, next)
      } else if (spec.startsWith('@cero-base/')) {
        const p = resolveCero(spec)
        if (p) walk(p, next)
      } else if (!external.has(spec)) {
        external.set(spec, [...next, spec])
      }
    }
  }
  walk(join(root, 'packages', 'cero', 'src', 'rpc', 'client.js'), [])

  t.ok(seen.size > 5, `walked a real graph (${seen.size} files)`)
  const NATIVE = [
    'sodium-native',
    'sodium-universal',
    'hypercore-crypto',
    'hypercore',
    'corestore',
    'autobee',
    'autobee-encryption',
    'hyperswarm',
    'hyperdht',
    'hyperdb',
    'hyperblobs',
    'hypercore-storage',
    'blind-pairing',
    'blind-peering'
  ]
  const leaked = [...external.keys()].filter((e) => NATIVE.includes(e.split('/')[0]))
  t.alike(
    leaked,
    [],
    leaked.length
      ? `server-only dep reachable from the client: ${external.get(leaked[0]).join(' → ')}`
      : 'no native package is reachable from the RPC client'
  )
})

// ─── identity ─────────────────────────────────────────────────────────────

test('rpc: client.id matches server identity', async (t) => {
  const { me, client } = await openPair(t)
  t.is(client.id, me.id)
})

test('rpc: recovery phrase is fetched on demand, not via init', async (t) => {
  const { me, client } = await openPair(t)

  // the phrase must never ride along on init — a client that wants it asks for
  // it, so an app that never shows it never pulls the account into its memory
  t.absent(client.identity.phrase, 'init carries no phrase')

  const phrase = await client.identity.toPhrase()
  t.ok(phrase && phrase.split(' ').length >= 12, 'client fetches the phrase via the seed RPC')
  t.is(phrase, me.identity.toPhrase(), 'matches the server identity phrase')
})

test('rpc: client exposes refs lifted from the spec', async (t) => {
  const { client } = await openPair(t)
  t.ok(client.messages, 'messages ref present')
  t.ok(client.profile, 'profile ref present')
  t.is(client.messages.kind, 'collection')
  t.is(client.profile.kind, 'single')
})

test('rpc: create envelope carries role + accept across the wire', (t) => {
  bindCodec(spec)
  const dec = spec.codec.decodeCreate(
    spec.codec.encodeCreate({ name: 'general', role: 'member', noAccept: true })
  )
  t.is(dec.name, 'general', 'name preserved')
  t.is(dec.role, 'member', 'role no longer dropped')
  t.is(dec.noAccept, true, 'accept:false (noAccept) crosses the wire')
})

test('rpc: set { upsert: false } is honored over the wire', async (t) => {
  const { client } = await openPair(t)
  const res = await set(client.messages, { id: 'ghost', text: 'x' }, { upsert: false })
  t.absent(res.data, 'update-only miss did not create a row over RPC')
  t.is((await get(client.messages, 'ghost')).data, null, 'no row was created on the server')
})

// ─── error propagation ─────────────────────────────────────────────────────

test('rpc: a server handler error propagates to the client with its code', async (t) => {
  const { client } = await openPair(t)
  // get-by-id on a ref the server doesn't know — the server throws
  // CeroError.UNKNOWN and the code crosses the wire on the rejection.
  await t.exception(
    client.rpc.getOne({ handle: client.id, ref: 'nopeRef', id: 'x', local: false }),
    /UNKNOWN/
  )
})

// ─── round-trip operators ─────────────────────────────────────────────────

test('rpc: put round-trips through the wire', async (t) => {
  const { me, client } = await openPair(t)
  const { data: row } = await put(client.messages, { text: 'hi' })
  t.ok(row.id)
  t.is(row.text, 'hi')
  const { data: list } = await get(me.messages)
  t.is(list.length, 1)
  t.is(list[0].text, 'hi')
})

test('rpc: set on a single round-trips', async (t) => {
  const { me, client } = await openPair(t)
  await set(client.profile, { name: 'jb' })
  const { data } = await get(me.profile)
  t.is(data.name, 'jb')
})

test('rpc: get by id over the wire', async (t) => {
  const { client } = await openPair(t)
  const { data: row } = await put(client.messages, { text: 'a' })
  const { data } = await get(client.messages, row.id)
  t.is(data.text, 'a')
})

test('rpc: get with query returns paginated rows', async (t) => {
  const { client } = await openPair(t)
  for (const text of ['a', 'b', 'c']) await put(client.messages, { text })
  const { data, total, size } = await get(client.messages, { limit: 2 })
  t.is(total, null, 'limited read skips the count — total: true crosses the wire to force it')
  t.is(size, 2)
  t.is(data.length, 2)
  t.is((await get(client.messages, { limit: 2, total: true })).total, 3, 'forced count over RPC')
})

test('rpc: search + fields filter rows over the wire', async (t) => {
  const { client } = await openPair(t)
  for (const text of ['hello', 'help', 'goodbye']) await put(client.messages, { text })
  const { data, total } = await get(client.messages, { search: 'hel', fields: ['text'] })
  t.is(total, 2, 'total counts the matches')
  t.alike(
    data.map((m) => m.text).sort(),
    ['hello', 'help'],
    'search + fields cross RPC and filter server-side'
  )
})

test('rpc: del removes a row over the wire', async (t) => {
  const { client } = await openPair(t)
  const { data: row } = await put(client.messages, { text: 'a' })
  await del(client.messages, row.id)
  const { data } = await get(client.messages)
  t.is(data.length, 0)
})

// ─── watch over the wire ──────────────────────────────────────────────────

test('rpc: watch emits initial snapshot then updates over the wire', async (t) => {
  const { me, client } = await openPair(t)

  const stream = watch(client.messages)
  const observed = observe(t, stream, [
    (snap) => t.alike(snap.data, [], 'initial snapshot is empty'),
    (snap) => t.is(snap.data[0]?.text, 'a', 'remote write reaches watch stream')
  ])

  await put(me.messages, { text: 'a' })
  await observed
  stream.destroy()
})

test('rpc: watch over the wire — destroy stops emissions', async (t) => {
  const { me, client } = await openPair(t)
  const stream = watch(client.messages)
  let emissions = 0
  stream.on('data', () => emissions++)
  await waitUntil(() => emissions >= 1) // initial snapshot delivered
  emissions = 0
  stream.destroy()
  await put(me.messages, { text: 'after-destroy' })
  await new Promise((r) => setTimeout(r, 100))
  t.is(emissions, 0, 'no emissions after destroy')
  t.ok(stream.destroyed, 'stream is destroyed')
})

test('rpc: client close ends live watch streams cleanly (no error)', async (t) => {
  const { client } = await openPair(t)
  const stream = watch(client.messages)
  let snapshots = 0
  const outcome = new Promise((resolve, reject) => {
    stream.on('data', () => snapshots++)
    stream.on('error', reject)
    stream.on('close', resolve)
  })
  await waitUntil(() => snapshots >= 1) // initial snapshot delivered
  await client.close()
  await t.execution(() => outcome, 'channel teardown ends the watch — not a failure')
})

test('rpc: client close ends live changes streams cleanly (no error)', async (t) => {
  const { client } = await openPair(t)
  const stream = changes(client.messages)
  let batches = 0
  const outcome = new Promise((resolve, reject) => {
    stream.on('data', () => batches++)
    stream.on('error', reject)
    stream.on('close', resolve)
  })
  await waitUntil(() => batches >= 1) // initial replay delivered
  await client.close()
  await t.execution(() => outcome, 'channel teardown ends the changes stream — not a failure')
})

test('rpc: watching an unknown ref destroys the stream with an error', async (t) => {
  const { client } = await openPair(t)
  // The server can't resolve the ref, so it destroys the response stream with
  // the error — which surfaces on the client stream rather than as a snapshot.
  const stream = client.watch('nopeRef')
  const drain = (async () => {
    for await (const _snap of stream);
  })()
  await t.exception(drain, /UNKNOWN/)
  t.ok(stream.destroyed, 'client stream is torn down')
})

// ─── child handles over RPC ───────────────────────────────────────────────

test('rpc: client.create(type) opens a child handle on the server', async (t) => {
  const { me, client } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  t.ok(team.id, 'remote team has id')
  t.is(team.type, 'team')
  t.ok(team.messages, 'team has messages ref')
  t.ok(team.notes, 'team has notes ref')
  // Server-side: the same team is open on me
  void me
})

test('rpc: put/get on a child handle round-trips via the wire', async (t) => {
  const { client } = await openPair(t)
  const team = await open(client.team)
  const { data: row } = await put(team.messages, { text: 'team msg' })
  t.is(row.text, 'team msg')
  const { data: list } = await get(team.messages)
  t.is(list.length, 1)
  t.is(list[0].text, 'team msg')
})

test('rpc: a reloaded UI re-attaches, init answers again and the old watches end', async (t) => {
  const { server, client } = await openPair(t)
  const stale = watch(client.messages)
  t.teardown(() => stale.destroy())
  await waitUntil(() => server._watchStreams.size > 0)
  const [served] = [...server._watchStreams.values()][0]

  const again = await client.rpc.init({})
  t.is(again.id, client.id, 'the same identity comes back')
  t.ok(served.destroyed, 'the previous page’s watch ended on the worker')
  t.is(server._watchStreams.size, 0)

  await put(client.messages, { text: 'still served' })
  t.is((await get(client.messages)).data[0].text, 'still served', 'the worker keeps serving')
})

test('rpc: setActive ranks the server handle, suspend and resume reach the root', async (t) => {
  const { me, client } = await openPair(t, { presence: { active: 1, announced: 0, idle: 50 } })
  const team = await open(client.team, { name: 'engineering' })
  const serverTeam = [...me.children][0]
  const mode = () => me.network.presence.mode(serverTeam.store.bee.discoveryKey)
  t.is(mode(), 'active', 'creating the room ranked it')

  await team.setActive(false)
  await waitUntil(() => mode() === null)
  t.pass('off the swarm')
  await team.setActive(true)
  t.is(mode(), 'active', 'back on focus')

  await client.suspend()
  t.ok(me.suspended, 'suspended on the server')
  await client.resume()
  t.absent(me.suspended, 'resumed')
})

test('rpc: rotate on a child handle round-trips via the wire', async (t) => {
  const { me, client } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  await put(team.messages, { text: 'pre' })

  const { epoch } = await rotate(team)
  t.is(epoch, 1, 'rotation applied on the server and epoch returned')

  await put(team.messages, { text: 'post' })
  const { data: list } = await get(team.messages)
  t.is(list.length, 2, 'reads keep working across the rotation')

  const serverTeam = [...me.children][0]
  t.is(serverTeam.store.keyring.seq, 1, 'server keyring advanced')
})

test('rpc: a watch stream over the wire survives a rotation mid-stream', async (t) => {
  const { client } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  await put(team.messages, { text: 'pre' })

  const stream = watch(team.messages)
  const seen = []
  stream.on('data', ({ data }) => seen.push(data.map((r) => r.text).sort()))
  t.teardown(() => stream.destroy())
  await waitUntil(() => (seen.length > 0 ? true : null))

  const { epoch } = await rotate(team)
  t.is(epoch, 1)
  await put(team.messages, { text: 'post' })

  await waitUntil(() => (seen.some((s) => s.includes('post')) ? true : null))
  t.alike(seen[seen.length - 1], ['post', 'pre'], 'RPC watch delivered rows across the rotation')
})

test('rpc: child handle close is server-side teardown', async (t) => {
  const { client } = await openPair(t)
  const team = await open(client.team)
  await put(team.messages, { text: 'hi' })
  await team.close()
  t.pass('child close did not throw')
})

test('rpc: leave() over the wire drops the handle on the server', async (t) => {
  const { server, client } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  t.ok(server.handles.has(team.id), 'server tracks the open child handle')
  await team.leave()
  t.absent(server.handles.has(team.id), 'server no longer has the handle after leave()')
})

test('rpc: leaving a handle ends its watch streams (no dangling)', async (t) => {
  const { client } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  const stream = watch(team.messages)
  const ended = new Promise((resolve) => {
    stream.on('end', () => resolve(true))
    stream.on('close', () => resolve(true))
  })
  let started = false
  stream.on('data', () => {
    started = true
  })
  await waitUntil(() => started) // stream is live before we leave
  await team.leave()
  const how = await Promise.race([ended, new Promise((r) => setTimeout(() => r(false), 2000))])
  t.ok(how, 'watch stream ended when the handle left')
})

test('rpc: a custom action call over the wire routes to the server handler', async (t) => {
  const { client } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  // `promote` is a declared action ref, so the call crosses the wire and the
  // server resolves it on the live team handle. The fixture wires no route for
  // it (route fns can't cross the wire), so the server-side dispatch throws
  // INVALID 'has no route' — which proves the call reached the handler.
  await t.exception(call(team.promote, { memberId: 'x', role: 'read' }), /no route/)
})

test('rpc: buffer field round-trips byte-perfect', async (t) => {
  const { client } = await openPair(t)
  const attachment = b4a.from([1, 2, 3, 4, 5])
  const { data: row } = await put(client.messages, { text: 'hi', attachment })
  t.alike(b4a.toBuffer(row.attachment), b4a.toBuffer(attachment))
})

// ─── files over RPC ────────────────────────────────────────────────────────

test('rpc: add-file uploads bytes and returns a file row with an id', async (t) => {
  const { client } = await openPair(t)
  const data = b4a.from('hello-avatar')
  const { data: row } = await put(client.files, { data, name: 'a.txt', type: 'text/plain' })
  t.ok(row.id, 'server returned a string file id')
  t.is(row.name, 'a.txt', 'name round-trips')
})

// invite({ expiresIn, reuse }) must cross the wire, or a "1 hour" invite
// minted through a client never expires
test('rpc: invite carries expiresIn over the wire', async (t) => {
  const { client } = await openPair(t)
  const team = await open(client.team, { name: 'inviting' })

  const before = Date.now()
  const limited = await team.invite({ role: 'member', expiresIn: 60_000 })
  const expires = Invite.parse(limited).expires
  t.ok(
    expires >= before + 60_000 && expires <= Date.now() + 60_000,
    'expiry stamped from expiresIn'
  )

  const forever = await team.invite({ role: 'member' })
  t.is(Invite.parse(forever).expires, 0, 'no expiresIn still means never')
})

// only the files ref uploads: a user collection with its own `data` column
// must stay a row insert over RPC
test('rpc: put on a non-file ref with a data field stays a row insert', async (t) => {
  const { me, client } = await openPair(t)
  const { data: row } = await put(client.clips, { data: 'just-a-string-column' })
  t.is(row.data, 'just-a-string-column', 'stored as a plain row')
  const { data: local } = await get(me.clips, row.id)
  t.is(local?.data, 'just-a-string-column', 'visible as a row on the server side')
})

test('rpc: client.put(files, { data }) routes through add-file', async (t) => {
  const { me, client } = await openPair(t)
  const data = b4a.from([1, 2, 3, 4, 5])
  const { data: row } = await put(client.files, {
    data,
    name: 'b.bin',
    type: 'application/octet-stream'
  })
  t.ok(row.id, 'file id assigned')
  const { coreKey, blobId } = decodeId(row.id)
  t.alike(
    b4a.toBuffer(coreKey),
    b4a.toBuffer(me.files.handle.blobs.key),
    'id carries the blob core key'
  )
  const bytes = await me.files.handle.blobs.get(blobId)
  t.alike(b4a.toBuffer(bytes), b4a.toBuffer(data), 'server stored the exact bytes')
})

test('rpc: file read resolves a url that serves the bytes over http', async (t) => {
  const { client } = await openPair(t)
  const data = b4a.from('the-quick-brown-fox')
  const { data: row } = await put(client.files, { data, name: 'c.txt', type: 'text/plain' })
  const { data: got } = await get(client.files, row.id)
  t.ok(got.url, 'read resolved a url')
  const res = await fetch(got.url)
  t.is(res.status, 200, 'url serves 200')
  const body = b4a.from(await res.arrayBuffer())
  t.alike(b4a.toBuffer(body), b4a.toBuffer(data), 'http body is byte-perfect')
})

// ─── local (per-device) refs over RPC ─────────────────────────────────────

test('rpc: client.local exposes app local refs, hides builtins', async (t) => {
  const { client } = await openPair(t)
  t.ok(client.local, 'client.local present')
  t.ok(client.local.drafts, 'drafts ref present')
  t.ok(client.local.settings, 'settings ref present')
  t.absent(client.local.master, 'builtin master not exposed')
  t.absent(client.local.keypair, 'builtin keypair not exposed')
})

test('rpc: local put/get round-trips and stays in the per-device store', async (t) => {
  const { me, client } = await openPair(t)
  const { data: row } = await put(client.local.drafts, { text: 'draft' })
  t.is(row.text, 'draft')
  const { data: list } = await get(client.local.drafts)
  t.is(list.length, 1)
  t.is(list[0].text, 'draft')
  const { data: serverList } = await get(me.local.drafts)
  t.is(serverList.length, 1, 'lives in the server-side local store')
})

test('rpc: local single set/get round-trips bytes', async (t) => {
  const { client } = await openPair(t)
  const entropy = b4a.from([9, 8, 7, 6])
  await set(client.local.settings, { entropy })
  const { data } = await get(client.local.settings)
  t.alike(b4a.toBuffer(data.entropy), b4a.toBuffer(entropy))
})

test('rpc: local watch emits over the wire', async (t) => {
  const { client } = await openPair(t)
  const stream = watch(client.local.drafts)
  const observed = observe(t, stream, [
    (snap) => t.alike(snap.data, [], 'initial snapshot empty'),
    (snap) => t.is(snap.data[0]?.text, 'd')
  ])
  await put(client.local.drafts, { text: 'd' })
  await observed
  stream.destroy()
})

test('rpc: local del removes a row', async (t) => {
  const { client } = await openPair(t)
  const { data: row } = await put(client.local.drafts, { text: 'x' })
  await del(client.local.drafts, row.id)
  const { data } = await get(client.local.drafts)
  t.is(data.length, 0)
})

test('rpc: server rejects local ops on builtin refs', async (t) => {
  const { client } = await openPair(t)
  await t.exception(
    client.rpc.addRow({ handle: client.id, ref: 'master', data: b4a.alloc(0), local: true })
  )
})

test('rpc: operators are symmetric over the wire', async (t) => {
  const operators = {
    user: { rename: (h, name) => set(h.profile, { name }) },
    team: { note: { add: (h, text) => put(h.notes, { text }) } }
  }
  const { client } = await openPair(t, { operators }, { operators })

  await client.user.rename('Remote')
  t.is((await get(client.profile)).data.name, 'Remote')

  const team = await open(client.team, { name: 'squad' })
  await team.note.add('via-rpc')
  t.is((await get(team.notes)).data[0].text, 'via-rpc')
})

test('rpc: connect() binds the operators it is given', async (t) => {
  const operators = { team: { note: { add: (h, text) => put(h.notes, { text }) } } }
  const testnet = await makeTestnet(t)
  const [serverStream, clientStream] = pair()
  const server = await serve(serverStream, spec, {
    storage: await t.tmp(),
    bootstrap: testnet.bootstrap
  })
  const client = await connect(clientStream, spec, { operators })
  t.teardown(
    async () => {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    },
    { order: 5 }
  )

  const team = await open(client.team, { name: 'squad' })
  await team.note.add('instance')
  t.is((await get(team.notes)).data[0].text, 'instance')
})

test('rpc: changes streams deltas over the wire, symmetric with local', async (t) => {
  const { server, client } = await openPair(t)
  const { changes } = await import('../../src/lib/operators.js')

  const remote = changes(client.messages)
  const local = server.me.store.changes('messages')
  t.teardown(() => {
    remote.destroy()
    local.destroy()
  })
  const remoteBatches = []
  const localBatches = []
  remote.on('data', (b) => remoteBatches.push(b))
  local.on('data', (b) => localBatches.push(b))

  await waitUntil(() => remoteBatches.length >= 1)
  t.is(remoteBatches[0].reset, true, 'initial reset batch crosses the wire')

  const { data: row } = await put(client.messages, { text: 'delta' })
  await waitUntil(() => remoteBatches.some((b) => b.changes.some((c) => c.next?.id === row.id)))
  const over = remoteBatches.flatMap((b) => b.changes).find((c) => c.next?.id === row.id)
  t.is(over.prev, null, 'insert shape over the wire')
  t.is(over.next.text, 'delta')

  await set(client.messages, { id: row.id, text: 'delta2' })
  await waitUntil(() => remoteBatches.some((b) => b.changes.some((c) => c.next?.text === 'delta2')))
  const upd = remoteBatches.flatMap((b) => b.changes).find((c) => c.next?.text === 'delta2')
  t.is(upd.prev.text, 'delta', 'prev side crosses the wire')

  await waitUntil(() => localBatches.some((b) => b.changes.some((c) => c.next?.text === 'delta2')))
  const replayPairs = (batches) => {
    const map = new Map()
    for (const { changes: cs, reset } of batches) {
      if (reset) map.clear()
      for (const { prev, next } of cs) {
        const id = (next || prev).id
        if (next) map.set(id, next.text)
        else map.delete(id)
      }
    }
    return [...map.entries()].sort()
  }
  t.alike(
    replayPairs(remoteBatches),
    replayPairs(localBatches),
    'wire and local replay identically'
  )
})
