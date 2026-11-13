import test from 'brittle'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'
import { existsSync, readFileSync, rmSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { Duplex } from 'streamx'
import c from 'compact-encoding'
import z32 from 'z32'
import { decodeId } from '@cero-base/core/blobs'
import { Invite } from '@cero-base/core/invite'
import { Identity } from '@cero-base/core/identity'

import {
  cero,
  put,
  set,
  get,
  del,
  watch,
  call,
  open,
  rotate,
  accept,
  deny,
  send,
  inbox
} from '../../src/index.js'
import { build } from '../../src/build/index.js'
import { serve, Server } from '../../src/rpc/server.js'
import { Client, connect, restore, link, supports } from '../../src/rpc/client.js'
import { bindCodec } from '@cero-base/core/rpc'
import { makeMockBluetooth } from 'ble-swarm/mock.js'
import { spec } from '../fixtures/spec/index.js'
import { spec as next } from '../fixtures/spec/next/index.js'
import {
  makeTestnet,
  observe,
  waitUntil,
  fetch,
  nextRequest,
  joinsOf,
  refusedAtClaim
} from '../helpers/index.js'

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

async function openPair(t, serverOpts = {}, clientOpts, built = spec) {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()

  const [serverStream, clientStream] = pair()
  const server = await serve(serverStream, built, {
    storage: dir,
    bootstrap: testnet.bootstrap,
    ...serverOpts
  })
  const client = await connect(clientStream, built, clientOpts)

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

  return { me: server.me, server, client, testnet }
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
    'hyperswarm',
    'hyperdht',
    'hyperdb',
    'hyperblobs',
    'hypercore-storage',
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
  t.absent(client.identity, 'init carries no identity, so no phrase')

  const phrase = await cero.phrase(client)
  t.ok(phrase && phrase.split(' ').length >= 12, 'the client asks the worker for it')
  t.is(phrase, await cero.phrase(me), 'matches the server identity phrase')
})

test('rpc: client exposes refs lifted from the spec', async (t) => {
  const { client } = await openPair(t)
  t.ok(client.messages, 'messages ref present')
  t.ok(client.profile, 'profile ref present')
  t.is(client.messages.kind, 'collection')
  t.is(client.profile.kind, 'single')
})

test('rpc: create envelope carries the name across the wire', (t) => {
  bindCodec(spec)
  const dec = spec.codec.decodeCreate(spec.codec.encodeCreate({ name: 'general' }))
  t.is(dec.name, 'general', 'name preserved')
})

test('rpc: a read or an update-only set that finds no row resolves as in the worker', async (t) => {
  const { me, client } = await openPair(t)
  const ghost = { id: 'ghost', text: 'x' }
  t.alike(
    await set(client.messages, ghost, { upsert: false }),
    await set(me.messages, ghost, { upsert: false })
  )
  t.is((await get(client.messages, 'ghost')).data, null, 'no row was created on the server')
  t.alike(await get(client.profile), await get(me.profile), 'a single with no row')
})

test('rpc: the worker writes only what the client sent', async (t) => {
  const { me, client } = await openPair(t)
  const start = Date.now()
  const { data: row } = await put(client.messages, { text: 'a', attachment: b4a.from([1, 2]) })
  const { data: stored } = await get(me.messages, row.id)
  t.ok(stored.createdAt >= start, 'createdAt is the time of the write')
  t.ok(stored.updatedAt >= start, 'updatedAt is the time of the write')

  await set(client.messages, { id: row.id, text: 'b' })
  const { data: merged } = await get(me.messages, row.id)
  t.is(merged.text, 'b')
  t.alike(merged.attachment, stored.attachment, 'a field the set left out is kept')
  t.is(merged.createdAt, stored.createdAt)

  await put(client.local.drafts, { text: 'x' })
  await put(client.local.drafts, { text: 'y' })
  t.is((await get(me.local.drafts)).data.length, 2, 'two puts with no id are two rows')

  await t.exception(put(client.messages, { txt: 'typo' }), /INVALID/, 'an unknown field')
})

test('rpc: a field the schema lacks or requires is held as in the worker', async (t) => {
  const { me, client } = await openPair(t)
  const writes = [
    [(ctx) => ctx.tasks, { done: true }],
    [(ctx) => ctx.local.drafts, { txt: 'x' }],
    [(ctx) => ctx.local.tasks, {}]
  ]
  for (const [ref, row] of writes) {
    for (const ctx of [client, me]) {
      const err = await put(ref(ctx), row).catch((e) => e)
      t.is(err.code, 'INVALID', err.message)
    }
  }
  const { data } = await put(client.tasks, { title: 'a' })
  await set(client.tasks, { id: data.id, done: true })
  const { data: row } = await get(me.tasks, data.id)
  t.is(row.title, 'a', 'a set may leave a required field out')
  t.is(row.done, true)
})

test('rpc: a query reaches the worker as the client wrote it', async (t) => {
  const { me, client } = await openPair(t)
  for (const text of ['a', 'b', 'c']) await put(client.messages, { text })
  const ids = (await get(me.messages)).data.map((r) => r.id).sort()
  for (const q of [
    { limit: 0 },
    { limit: 0, total: true },
    { reverse: false, limit: 1 },
    { gt: ids[0] },
    { gte: ids[1], lt: ids[2] },
    { lte: ids[1], reverse: true }
  ]) {
    t.alike(await get(client.messages, q), await get(me.messages, q), JSON.stringify(q))
  }
  const { key } = (await get(me.members)).data[0]
  t.alike(await get(client.members, { key }), await get(me.members, { key }), 'a bytes field')
})

test('rpc: get and watch take an id the way they do in the worker', async (t) => {
  const { me, client } = await openPair(t)
  const room = await open(client.team, { name: 'a' })
  const { data: row } = await put(client.messages, { text: 'hi' })
  const first = async (stream) => {
    for await (const snap of stream) return snap
  }
  t.alike(await get(client.team, room.id), await get(me.team, room.id), 'a room by id')
  t.alike(await first(watch(client.team, room.id)), await get(me.team, room.id))
  t.alike(await first(watch(client.messages, row.id)), await get(me.messages, row.id))
})

// ─── error propagation ─────────────────────────────────────────────────────

test('rpc: a server handler error propagates to the client with its code', async (t) => {
  const { client } = await openPair(t)
  // a get on a ref the server doesn't know — the server throws
  // CeroError.UNKNOWN and the code crosses the wire on the rejection.
  await t.exception(client.rpc.get({ handle: client.id, ref: 'nopeRef', local: false }), /UNKNOWN/)
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

test('rpc: a wrong-typed query rejects the call and the worker lives', async (t) => {
  const errors = []
  const { server, client } = await openPair(t, {}, { onerror: (err) => errors.push(err) })
  await waitUntil(() => server._errors.size === 1)
  await put(client.messages, { text: 'hello' })
  await t.exception(get(client.messages, { search: 'hel', fields: 'text' }), /INVALID/)
  const garbled = client.rpc.watch({
    handle: client.id,
    ref: 'messages',
    query: b4a.from([0xff]),
    local: false
  })
  await t.exception(
    (async () => {
      for await (const _snap of garbled);
    })(),
    'a query that does not decode fails the watch'
  )
  t.is((await get(client.messages)).data.length, 1, 'the worker still answers')
  t.alike(errors, [], 'a refusal is not a bug')
})

test('rpc: a bug in a handler fails the call and reaches onerror', async (t) => {
  const errors = []
  const { me, server, client } = await openPair(t, {}, { onerror: (err) => errors.push(err) })
  await waitUntil(() => server._errors.size === 1)
  const read = me.store.get
  me.store.get = () => {
    throw new TypeError('boom')
  }
  const err = await get(client.messages).catch((e) => e)
  me.store.get = read
  t.is(err?.message, 'boom', 'the call rejects')
  await waitUntil(() => errors.length === 1)
  t.is(errors[0].message, 'boom', 'the worker reports it')
  t.is((await get(client.messages)).data.length, 0, 'the worker still answers')
})

test('rpc: a ref name that is a handle property is UNKNOWN', async (t) => {
  const errors = []
  const { server, client } = await openPair(t, {}, { onerror: (err) => errors.push(err) })
  await waitUntil(() => server._errors.size === 1)
  const room = await open(client.team, { name: 'a' })
  const data = b4a.alloc(0)
  for (const handle of [client.id, room.id]) {
    for (const ref of ['store', 'identity', 'parent']) {
      const req = { handle, ref, local: false }
      await t.exception(client.rpc.get(req), /UNKNOWN/, `get ${ref}`)
      await t.exception(client.rpc.addRow({ ...req, data }), /UNKNOWN/, `put ${ref}`)
      await t.exception(client.rpc.set({ ...req, data }), /UNKNOWN/, `set ${ref}`)
      await t.exception(client.rpc.del({ ...req, id: 'x' }), /UNKNOWN/, `del ${ref}`)
    }
  }
  t.alike(errors, [], 'a refusal is not a bug')
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

test('rpc: a watch the client destroys stops on the worker', async (t) => {
  const { me, server, client } = await openPair(t)
  const stream = watch(client.messages)
  await new Promise((resolve) => stream.once('data', resolve))
  stream.destroy()
  await waitUntil(() => !server._watchStreams.get(client.id)?.size)
  t.pass('the worker let go of the stream')

  let last = null
  const live = watch(me.messages)
  live.on('data', (snap) => (last = snap))
  await waitUntil(() => last)
  const db = me.store
  const read = db.get
  let reads = 0
  db.get = (...args) => (reads++, read.apply(db, args))
  await put(me.messages, { text: 'a' })
  await waitUntil(() => last.data.length === 1)
  db.get = read
  live.destroy()
  t.is(reads, 1, 'a write is read once, for the watch still open')
})

test('rpc: an errors stream the client drops leaves the worker', async (t) => {
  const { server, client } = await openPair(t)
  await waitUntil(() => server._errors.size === 1)
  const errors = client.rpc.errors({})
  await waitUntil(() => server._errors.size === 2)
  errors.destroy()
  await waitUntil(() => server._errors.size === 1)
  t.pass('only the client’s own stream is left')
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

test('rpc: a room reads as in over the bridge, and its state once it has one', async (t) => {
  const { me, client } = await openPair(t)
  const team = await open(client.team, { name: 'clinic' })
  t.is((await get(client.team, team.id)).data.state, 'in', 'by id')
  t.alike(
    (await get(client.team)).data.map((row) => row.state),
    ['in'],
    'and in a list'
  )
  await me.store.set('handles', { id: team.id, state: 'leaving' })
  t.is((await get(client.team, team.id)).data.state, 'leaving')
})

test('rpc: a list over the bridge is the rooms the identity is in, a state named lists the others, and an id reads any', async (t) => {
  const { me, client } = await openPair(t)
  const room = await open(client.team, { name: 'clinic' })
  for (const [i, state] of ['asking', 'left', 'denied'].entries()) {
    const key = b4a.alloc(32, i + 1)
    await me.store.set('handles', { id: state, type: 'team', key, state, invite: 'one' })
  }

  const ids = (res) => res.data.map((row) => row.id)
  t.alike(ids(await get(client.team)), [room.id], 'by type')
  t.alike(ids(await get(client.handles)), [room.id], 'among every handle')
  t.alike(ids(await get(client.team, { state: 'left' })), ['left'], 'a state named')
  t.is((await get(client.team, 'denied')).data.state, 'denied', 'an id whatever its state')

  const stream = watch(client.team)
  t.teardown(() => stream.destroy())
  const seen = await new Promise((resolve) => stream.once('data', resolve))
  t.alike(ids(seen), [room.id], 'and by a watch')
})

test('rpc: a rename over the bridge sends no state, and a list filtered on in returns a room stored in', async (t) => {
  const { me, client } = await openPair(t)
  const team = await open(client.team, { name: 'clinic' })
  const key = b4a.alloc(32, 1)
  await me.store.set('handles', {
    id: 'waiting',
    type: 'team',
    key,
    state: 'asking',
    invite: 'one'
  })

  const sent = []
  const write = me.store.write
  me.store.write = (ops) => (sent.push(...ops), write.call(me.store, ops))
  await set(client.handles, { id: 'waiting', name: 'renamed' })
  me.store.write = write
  t.absent(sent[0][1].state, 'the rename sends no state')
  const { data: row } = await get(client.team, 'waiting')
  t.alike([row.name, row.state], ['renamed', 'asking'], 'and the row stands where it stood')

  t.is((await me.store.get('handles', team.id)).data.state, 'in', 'the room is stored in')
  const listed = await get(client.team, { state: 'in' })
  t.alike(
    listed.data.map((row) => row.id),
    [team.id],
    'and listed as in'
  )
})

test('rpc: a row is deleted over the bridge once it is over, not while asking', async (t) => {
  const { me, client } = await openPair(t)
  const key = b4a.alloc(32, 1)
  await me.store.set('handles', {
    id: 'waiting',
    type: 'team',
    key,
    state: 'asking',
    invite: 'one'
  })
  const err = await del(client.handles, 'waiting').catch((err) => err)
  t.is(err?.code, 'REFUSED', 'refused while asking')
  await me.store.set('handles', { id: 'waiting', state: 'cancelled' })
  await del(client.handles, 'waiting')
  t.absent((await get(client.team, 'waiting')).data, 'gone once it is over')
})

test('rpc: an ended row is deleted over the bridge through its type, not while asking', async (t) => {
  const { me, client } = await openPair(t)
  const key = b4a.alloc(32, 1)
  await me.store.set('handles', {
    id: 'waiting',
    type: 'team',
    key,
    state: 'asking',
    invite: 'one'
  })
  const err = await del(client.team, 'waiting').catch((err) => err)
  t.is(err?.code, 'REFUSED', 'refused while asking')
  await me.store.set('handles', { id: 'waiting', state: 'denied' })
  await del(client.team, 'waiting')
  t.absent((await get(client.team, 'waiting')).data, 'gone once it is over')
})

test('rpc: a room created while the root closes rejects with CLOSED', async (t) => {
  const { me, client } = await openPair(t)
  const creating = open(client.team, { name: 'clinic' })
  const closing = cero.close(me)
  const err = await creating.catch((err) => err)
  t.is(err?.code, 'CLOSED', `rejected with ${err?.code}: ${err?.message}`)
  await closing
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

// a reloaded page never closes what the old one held: the worker lets go for it, one close per open the page made
const openOn = (server, id) => [...server.me.children].some((c) => c.id === id && !c.closing)

test('rpc: a reloaded UI lets go of every room the old page held, however many times it opened them', async (t) => {
  const { server, client } = await openPair(t, { keepOpen: 0 })
  const made = await open(client.team, { name: 'clinic' })
  await open(client.team, { id: made.id })
  await client.rpc.init({})
  t.absent(openOn(server, made.id), 'closed on the worker')
  t.absent(server.handles.has(made.id), 'and dropped from its handles')
})

test('rpc: a room the worker holds itself stays open through a page reload', async (t) => {
  const { server, client } = await openPair(t, { keepOpen: 0 })
  const made = await open(client.team, { name: 'clinic' })
  const mine = await open(server.me.team, { id: made.id })
  t.teardown(() => mine.close())
  await client.rpc.init({})
  t.ok(openOn(server, made.id), 'the worker’s own open keeps it')
  await put(mine.messages, { text: 'still here' })
  t.is((await get(mine.messages)).data.length, 1)
})

test('rpc: a room the old page already closed is not closed again on reload', async (t) => {
  const { server, client } = await openPair(t, { keepOpen: 0 })
  const made = await open(client.team, { name: 'clinic' })
  await made.close()
  const mine = await open(server.me.team, { id: made.id })
  t.teardown(() => mine.close())
  await client.rpc.init({})
  t.ok(openOn(server, made.id), 'the worker’s open is untouched')
})

test('rpc: the new page’s opens after a reload count from zero', async (t) => {
  const { server, client } = await openPair(t, { keepOpen: 0 })
  const made = await open(client.team, { name: 'clinic' })
  await client.rpc.init({})
  const again = await open(client.team, { id: made.id })
  await put(again.messages, { text: 'after reload' })
  await again.close()
  t.absent(openOn(server, made.id), 'one open, one close: closed')
})

// the room the worker serves under `id`, whoever holds it
const servedOn = (server, id) => [...server.me.children].find((c) => c.id === id)

// a worker that keeps `keepOpen` rooms nobody holds, and `count` rooms its page made and still holds
async function pageRooms(t, keepOpen, count) {
  const { server, client } = await openPair(t, { keepOpen })
  const made = []
  for (let i = 0; i < count; i++) made.push(await open(client.team, { name: `room ${i}` }))
  return { server, client, made }
}

test('rpc: past keepOpen, the worker closes the room the page let go longest ago', async (t) => {
  const { server, made } = await pageRooms(t, 2, 3)
  const [first, second, third] = made
  await first.close()
  await second.close()
  t.ok(openOn(server, first.id), 'two rooms nobody holds stay open on the worker')
  await third.close()
  await waitUntil(() => !openOn(server, first.id))
  t.pass('the third one closed the least recently used')
  t.ok(openOn(server, second.id), 'the second stays open')
  t.ok(openOn(server, third.id), 'and the third')
})

test('rpc: an idle room the page opens again is the same room on the worker, and the most recently used', async (t) => {
  const { server, client, made } = await pageRooms(t, 2, 3)
  const [first, second, third] = made
  const served = servedOn(server, first.id)
  await first.close()
  await second.close()
  const again = await open(client.team, { id: first.id })
  t.is(servedOn(server, first.id), served, 'a reopen gets the same room, never rebuilt')
  await put(again.messages, { text: 'still served' })
  await again.close()
  await third.close()
  await waitUntil(() => !openOn(server, second.id))
  t.pass('the one let go before it closed')
  t.ok(openOn(server, first.id), 'the reopened one stays open')
  t.ok(openOn(server, third.id))
})

test('rpc: a room the page holds is never closed by the count', async (t) => {
  const { server, client, made } = await pageRooms(t, 1, 3)
  const [held, second, third] = made
  const also = await open(client.team, { id: held.id })
  await also.close()
  await second.close()
  await third.close()
  await waitUntil(() => !openOn(server, second.id))
  t.pass('the idle one made room')
  t.ok(openOn(server, held.id), 'the held one stays, however long ago it was opened')
  await put(held.messages, { text: 'still here' })
  t.is((await get(held.messages)).data.length, 1)
})

test('rpc: the close that pushes a room out is answered before it closes, and its failure reaches the page', async (t) => {
  const errors = []
  const { server, client } = await openPair(
    t,
    { keepOpen: 1 },
    { onerror: (err) => errors.push(err) }
  )
  await waitUntil(() => server._errors.size === 1)
  const oldest = await open(client.team, { name: 'oldest' })
  const next = await open(client.team, { name: 'next' })
  const { store } = servedOn(server, oldest.id)
  const close = store.close.bind(store)
  let release
  const held = new Promise((resolve) => (release = resolve))
  store.close = async () => {
    await held
    await close()
    throw new Error('disk full')
  }
  await oldest.close()
  await next.close()
  t.absent(openOn(server, oldest.id), 'answered while the room it pushed out still closes')
  release()
  await waitUntil(() => errors.length)
  t.alike(
    errors.map((err) => err.message),
    ['disk full'],
    'the failure of that close reached the page'
  )
  t.ok(openOn(server, next.id), 'and the room that pushed it out stays open')
})

test('rpc: closing the worker closes its idle rooms with it', async (t) => {
  const { server, made } = await pageRooms(t, 2, 3)
  const [held, first, second] = made
  const all = made.map((room) => servedOn(server, room.id))
  await first.close()
  await second.close()
  t.ok(openOn(server, first.id) && openOn(server, second.id), 'idle')
  t.ok(openOn(server, held.id), 'held')
  await server.close()
  t.ok(
    all.every((room) => room.closed),
    'the idle rooms and the held one closed with the worker'
  )
})

// a restore or link that fails over the wire leaves the worker serving the identity it had
test('rpc: a restore no device answers keeps the worker serving this identity', async (t) => {
  const { client } = await openPair(t, { recoveryTimeout: 1000 })
  const id = client.id
  await put(client.messages, { text: 'mine' })
  const phrase = Identity.toPhrase(Identity.randomBytes(32))
  await t.exception(restore(client, phrase), /TIMEOUT/)
  t.is((await get(client.messages)).data[0]?.text, 'mine', 'still reads')
  await put(client.messages, { text: 'and writes' })
  t.is(client.id, id)
})

test('rpc: a mistyped link keeps the worker serving this identity', async (t) => {
  const { client } = await openPair(t)
  await put(client.messages, { text: 'mine' })
  await t.exception(link(client, 'nothing like a code'), /INVALID_INVITE/)
  t.is((await get(client.messages)).data[0]?.text, 'mine', 'still reads')
})

test('rpc: the root closing while a link waits ends it CLOSED on the client', async (t) => {
  const { me, client, testnet } = await openPair(t)
  const other = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => other.close().catch(() => {}), { order: 4 })
  let request = null
  const linking = link(client, await cero.invite(other), { onrequest: (r) => (request = r) })
  linking.catch(() => {})
  await waitUntil(() => request)
  await me.close()
  await t.exception(linking, /CLOSED/)
})

test('rpc: the root closing while a restore looks for a device ends it CLOSED on the client', async (t) => {
  const { me, client } = await openPair(t, { recoveryTimeout: 0 })
  const restoring = restore(client, Identity.toPhrase(Identity.randomBytes(32)))
  restoring.catch(() => {})
  await waitUntil(() => existsSync(`${me._dir}/main.next/main`))
  await me.close()
  await t.exception(restoring, /CLOSED/)
})

test('rpc: the server closing as a link takes the root’s place closes the linked root too', async (t) => {
  const { me, server, client, testnet } = await openPair(t)
  const other = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => other.close().catch(() => {}), { order: 4 })
  let closing = null
  // the root closing under the swap: the commit is under way
  me.own({ destroy: () => (closing = server.close()) })
  link(client, await cero.invite(other)).catch(() => {})
  await accept(other, await nextRequest(other))
  await waitUntil(() => closing !== null)
  await closing
  // an open root would still hold the directory
  const again = await cero(me._dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  t.is(again.id, other.id, 'the linked identity, its store let go')
})

test("rpc: the worker's background errors reach the client's onerror", async (t) => {
  let report
  const seen = new Promise((resolve) => (report = resolve))
  const { me, client } = await openPair(t, {}, { onerror: report })
  me.network.suspend = async () => {
    throw new Error('radio')
  }
  await cero.suspend(client)
  t.is((await seen).message, 'radio')
  await cero.resume(client)
})

test("rpc: deactivate takes a room off the swarm, activate brings it back; suspend is the app's", async (t) => {
  const { me, client } = await openPair(t, { presence: { active: 1, announced: 0, idle: 50 } })
  const team = await open(client.team, { name: 'engineering' })
  const serverTeam = [...me.children][0]
  const mode = () => me.network.presence.mode(serverTeam.store.bee.discoveryKey)
  t.is(mode(), 'active', 'creating the room ranked it')

  await cero.deactivate(team)
  await waitUntil(() => mode() === null)
  t.pass('off the swarm')
  await cero.activate(team)
  t.is(mode(), 'active', 'back on top once selected')
  await t.exception(cero.suspend(team), /the app's, on me/)

  await cero.suspend(client)
  t.ok((await get(client.status)).data.suspended, 'suspended on the server')
  await cero.resume(client)
  t.absent((await get(client.status)).data.suspended, 'resumed')
})

test('rpc: status.version and supports answer in the UI as in the worker, before and after a raise', async (t) => {
  const { me, client } = await openPair(t, {}, undefined, next)
  const version = async () => (await get(client.status)).data.version
  t.is(await version(), next.meta.target, 'the version crosses the wire')
  t.ok(await supports(client.messages, 'text'), 'a field it had')
  t.absent(await supports(client.messages, 'tag'), 'a field held back')
  t.absent(await supports(client.visits), 'a collection held back')

  await me.store.write([['upgrade', { version: next.meta.version }]])
  await waitUntil(async () => (await version()) === next.meta.version || null)
  t.ok(await supports(client.messages, 'tag'), 'the field is on')
  t.ok(await supports(client.visits), 'and the collection')
})

test('rpc: a write of what the version holds back is refused with UNSUPPORTED in the UI', async (t) => {
  const { client } = await openPair(t, {}, undefined, next)
  const field = await put(client.messages, { text: 'a', tag: 'b' }).catch((e) => e)
  t.is(field?.code, 'UNSUPPORTED', field?.message)
  const collection = await put(client.visits, { date: 'today' }).catch((e) => e)
  t.is(collection?.code, 'UNSUPPORTED', collection?.message)
})

test('rpc: a room whose root is behind reports it, does not write and does not leave, in the UI', async (t) => {
  const { me, client } = await openPair(t)
  const room = await open(client.team, { name: 'clinic' })
  const behind = me.store.version + 1
  await me.store.write([['upgrade', { version: behind }]])
  await waitUntil(async () => (await get(room.status)).data.behind === behind || null)
  const err = await put(room.messages, { text: 'stale' }).catch((e) => e)
  t.is(err?.code, 'BEHIND', err?.message)
  const left = await cero.leave(room).catch((e) => e)
  t.is(left?.code, 'BEHIND', 'nor leaves')
  t.ok((await get(room.members, me.id)).data, 'still a member')
  t.is((await get(client.team)).data.length, 1, 'still in the list')
})

test('rpc: removed reads in the worker, the answer back in the UI', async (t) => {
  const { me, client } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  t.is(await cero.removed(team, me.identity.id), null, 'a member')
  t.is(await cero.removed(team, Identity.randomBytes(32).toString('hex')), null, 'never one')
})

test('rpc: rotate on a room round-trips via the wire', async (t) => {
  const { me, client } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  await put(team.messages, { text: 'pre' })

  const { epoch } = await rotate(team)
  t.is(epoch, 1, 'rotated in the worker, the epoch back in the UI')
  t.is((await get(team.status)).data.epoch, 1)

  await put(team.messages, { text: 'post' })
  t.is((await get(team.messages)).data.length, 2, 'reads keep working across the rotation')
  t.is([...me.children][0].store.keyring.seq, 1, 'the worker keyring advanced')
})

test('rpc: a removal made from the UI rotates the room key as it resolves, and the removed device does not read the next write', async (t) => {
  const { me, client, testnet } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  const other = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => other.close().catch(() => {}), { order: 5 })
  const theirs = await open(other.team, await cero.invite(team))
  await put(team.messages, { text: 'pre' })
  await waitUntil(async () => (await get(theirs.messages)).data.length === 1 || null)

  await del(team.members, other.id)
  t.is((await get(team.status)).data.epoch, 1, 'the worker opened epoch 1')
  await put(team.messages, { text: 'post' })
  t.is((await get(team.messages)).data.length, 2, 'writes go on in the new epoch')

  await waitUntil(async () => !(await get(theirs.members, other.id)).data || null)
  const key = [...me.children][0].store.keyring.current
  t.absent(theirs.store.keyring.entropy(key), 'the removed device holds no key for it')
  const { data } = await get(theirs.messages)
  t.alike(
    data.map((r) => r.text),
    ['pre'],
    'and reads nothing written after'
  )
})

test('rpc: seat from the UI names the room both are in by its id, and she is let in with nothing called on her side', async (t) => {
  const { client, testnet } = await openPair(t)
  const general = await open(client.team, { name: 'general' })
  const other = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => other.close().catch(() => {}), { order: 5 })
  const theirs = await open(other.team, await cero.invite(general))
  const known = async () => (await get(general.devices)).data.some((d) => d.memberId === other.id)
  await waitUntil(async () => (await known()) || null)

  const plans = await open(client.team, { name: 'plans' })
  t.is(await cero.seat(plans, other.id, { from: general }), undefined, 'nothing back')
  t.is((await get(plans.invites)).data[0]?.to, other.id, 'an invite made to her')
  await waitUntil(async () => (await get(other.handles, plans.id)).data?.state === 'in' || null)
  await waitUntil(async () => (await get(plans.members)).data.length === 2 || null)
  t.pass('she is in')
  t.ok(theirs, 'by the room both are in')
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

  await rotate(team)
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

// a screen and a background task on one device hold the same room through the worker; one is done with it
test('rpc: a room opened twice and closed once still works for the other holder', async (t) => {
  const { client } = await openPair(t)
  const made = await open(client.team, { name: 'clinic' })
  const id = made.id
  const screen = await open(client.team, { id })
  await made.close()
  await put(screen.messages, { text: 'still here' })
  t.is((await get(screen.messages)).data.length, 1, 'the other holder still writes and reads')
  await screen.close()
  await t.exception(get(screen.messages), /UNKNOWN/, 'the last close closes it')
})

test('rpc: leave() over the wire drops the handle on the server', async (t) => {
  const { server, client } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  t.ok(server.handles.has(team.id), 'server tracks the open child handle')
  await cero.leave(team)
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
  await cero.leave(team)
  const how = await Promise.race([ended, new Promise((r) => setTimeout(() => r(false), 2000))])
  t.ok(how, 'watch stream ended when the handle left')
})

test('rpc: a verb the root cannot take fails the same way in the UI as in the worker', async (t) => {
  const { client } = await openPair(t)
  await t.exception(cero.leave(client), /the root cannot be left/)
  await t.exception(cero.accept(client, { id: 'x' }), /unknown request/)
  t.is(typeof (await cero.invite(client)), 'string', 'a device invite, minted in the worker')
})

test('rpc: a verb answers in the UI as in the worker, results and refusals', async (t) => {
  const { me, client } = await openPair(t)
  const room = await open(client.team, { name: 'a' })
  const served = [...me.children][0]
  const random = () => b4a.alloc(32, Math.floor(Math.random() * 255))
  const link = { key: random(), length: 1 }
  // a room nobody here has, at an address that can be sealed to: a random one cannot always
  const stray = Invite.create({ key: random(), address: served.store.address, link }).toString()
  const cases = {
    'phrase on the root': (root) => cero.phrase(root),
    'phrase on a room': (root, room) => cero.phrase(room),
    'activate a room': (root, room) => cero.activate(room),
    'revoke an invite never minted': (root, room) => cero.revoke(room, stray),
    'cancel a join never started': (root) => cero.cancel(root, stray),
    'cancel what is no invite': (root) => cero.cancel(root, 'nope'),
    'invite as no rank': (root, room) => cero.invite(room, { role: 'nope' }),
    'reuse above member': (root, room) => cero.invite(room, { role: 'admin', reuse: true }),
    'revoke on the root': (root) => cero.revoke(root, stray),
    'accept an unknown request': (root, room) => cero.accept(room, { id: 'x' }),
    'deny an unknown request': (root, room) => cero.deny(room, { id: 'x' }, 'no'),
    'suspend a room': (root, room) => cero.suspend(room),
    'resume a room': (root, room) => cero.resume(room),
    'invite with null for options': (root, room) => cero.invite(room, null),
    'invite with a string for options': (root, room) => cero.invite(room, '1d'),
    'invite with a number for options': (root, room) => cero.invite(room, 5),
    'invite with an array for options': (root, room) => cero.invite(room, [{ role: 'reader' }]),
    'invite with bytes for options': (root, room) => cero.invite(room, b4a.alloc(4)),
    'invite with an ArrayBuffer for options': (root, room) => cero.invite(room, new ArrayBuffer(4)),
    'invite with a function for options': (root, room) => cero.invite(room, () => {}),
    'device invite with null for options': (root) => cero.invite(root, null),
    'device invite with an array for options': (root) => cero.invite(root, []),
    'seat on the root': (root, room) => cero.seat(root, root.id, { from: room }),
    'seat with no options': (root, room) => cero.seat(room, root.id),
    'seat from a room nobody here has': (root, room) => cero.seat(room, root.id, { from: 'nope' }),
    'seat one who is in no room here': (root, room) => cero.seat(room, 'nobody', { from: room })
  }
  // a TypeError has no code, and none crosses as ''
  const outcome = (run) =>
    run().then(
      (value) => ({ value }),
      (err) => ({ code: err.code || null, message: err.message })
    )
  for (const [name, run] of Object.entries(cases)) {
    const there = await outcome(() => run(me, served))
    t.alike(await outcome(() => run(client, room)), there, `${name}: ${JSON.stringify(there)}`)
    if (name.includes('for options')) t.is(there.code, 'INVALID', `${name} is INVALID`)
  }
})

test('rpc: the worker runs a verb only by its name in the list', async (t) => {
  const { server, client } = await openPair(t)
  const args = c.encode(c.any, [])
  const unlisted = ['close', 'leave', 'open', 'put', 'tx', '_loadKeyPair', '_phrase', 'constructor']
  for (const verb of [...unlisted, '__proto__', 'toString']) {
    const err = await client.rpc.verb({ handle: client.id, verb, args }).catch((e) => e)
    t.is(err?.code, 'UNKNOWN', `${verb} is refused`)
  }
  const seat = await client.rpc.verb({ handle: client.id, verb: 'seat', args }).catch((e) => e)
  t.is(seat?.code, 'INVALID', 'seat is listed: it runs, and the root takes no seat')
  t.absent(server.me.closing, 'the root is still open')
})

test('rpc: an argument or option left undefined takes its default in the worker', async (t) => {
  const { client } = await openPair(t, { bluetooth: { on: true, backend: makeMockBluetooth() } })
  const room = await open(client.team, { name: 'a' })
  const code = await cero.invite(room, { role: undefined, ttl: undefined, data: undefined })
  t.is(Invite.parse(code).expires, 0, 'no ttl')
  t.is((await get(room.invites)).data[0].role, 'member', 'the default role')
  t.ok(await cero.invite(room, undefined), 'no options at all')
  await cero.nearby(client, false, { topic: undefined })
  t.is((await get(client.status)).data.nearby, 'off', 'the default topic')
})

test('rpc: cancel runs on the handle it is called with', async (t) => {
  const { me, client } = await openPair(t)
  const room = await open(client.team, { name: 'a' })
  const calls = []
  ;[...me.children][0]._cancel = async (code) => calls.push(code) > 0
  t.ok(await cero.cancel(room, 'code'))
  t.alike(calls, ['code'], "the room's cancel ran, not the root's")
})

test('rpc: an action called from the UI runs in the worker', async (t) => {
  const { client } = await openPair(t)
  const team = await open(client.team, { name: 'engineering' })
  // the worker's room has no after hook on `promote`, and says so: the call reached it
  await t.exception(call(team.promote, { memberId: 'x', role: 'read' }), /no after hook/)
})

test('rpc: the client names its device the way a local root does', async (t) => {
  const { me, client } = await openPair(t, { name: 'laptop' })
  t.is(client.device?.name, 'laptop')
  t.alike(client.device, me.device)
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

test('rpc: add-file with a type that is no printable text is INVALID, and no byte is stored', async (t) => {
  const { client, me } = await openPair(t)
  await me.blobs.ready()
  const length = me.blobs.core.length
  const err = await put(client.files, { data: b4a.from('x'), type: 'a\nb' }).catch((err) => err)
  t.is(err?.code, 'INVALID')
  t.is(me.blobs.core.length, length, 'the blob core did not grow')
})

// invite({ ttl, reuse }) must cross the wire, or a "1 hour" invite
// minted through a client never expires
test('rpc: invite carries ttl and data over the wire', async (t) => {
  const { client } = await openPair(t)
  const team = await open(client.team, { name: 'inviting' })

  const before = Date.now()
  const limited = await cero.invite(team, { role: 'member', ttl: 60_000 })
  const expires = Invite.parse(limited).expires
  t.ok(expires >= before + 60_000 && expires <= Date.now() + 60_000, 'expiry stamped from ttl')

  const forever = await cero.invite(team, { role: 'member' })
  t.is(Invite.parse(forever).expires, 0, 'no ttl still means never')

  const data = b4a.from('clinic')
  t.alike(Invite.parse(await cero.invite(team, { data })).data, data)
  t.is(Invite.parse(forever).data, null, 'no data unless given')
})

test('rpc: a store with an identity boots before the first init, so the network is up early', async (t) => {
  const testnet = await makeTestnet(t)
  const storage = await t.tmp()
  await (await cero(storage, spec, { bootstrap: testnet.bootstrap })).close()
  const [serverStream] = pair()
  const server = await serve(serverStream, spec, { storage, bootstrap: testnet.bootstrap })
  t.teardown(() => server.close().catch(() => {}))
  const me = await waitUntil(() => server.me || null)
  t.ok(me.network.opened, 'booted with no client attached')
})

test('rpc: a start at boot that fails reaches onerror, closes the root it opened, and the next init opens it again', async (t) => {
  const testnet = await makeTestnet(t)
  const storage = await t.tmp()
  const made = await cero(storage, spec, { bootstrap: testnet.bootstrap })
  const { id } = made
  await made.close()
  const [serverStream, clientStream] = pair()
  const errors = []
  const onerror = (err) => errors.push(err.message)
  const server = new Server(serverStream, spec, { storage, bootstrap: testnet.bootstrap, onerror })
  t.teardown(() => server.close().catch(() => {}), { order: 5 })
  let first = null
  server._wireVerbs = function () {
    delete this._wireVerbs
    first = this.me
    throw new Error('wiring failed')
  }
  await server.ready()
  await waitUntil(() => first && server._booting === null)
  t.ok(first.closed, 'the root of the failed start is closed')
  await waitUntil(() => errors.length > 0)
  t.alike(errors, ['wiring failed'], 'its error reaches onerror')
  const client = await connect(clientStream, spec)
  t.teardown(() => client.close().catch(() => {}), { order: 4 })
  t.is(client.id, id, 'the next init opens the same identity')
})

test('rpc: a start whose root fails to close rejects with its own error and keeps no root', async (t) => {
  const testnet = await makeTestnet(t)
  const errors = []
  const { server, open } = await fresh(t, testnet, { onerror: (err) => errors.push(err.message) })
  server._wireVerbs = function () {
    delete this._wireVerbs
    const close = this.me.close.bind(this.me)
    this.me.close = async () => {
      await close()
      throw new TypeError('close failed')
    }
    throw new Error('wiring failed')
  }
  await t.exception(open(), /wiring failed/)
  t.is(server.me, null, 'no root kept')
  t.alike(errors.sort(), ['close failed', 'wiring failed'], 'both reach onerror')
  t.ok((await open()).id, 'the next init opens a root')
})

test('rpc: a start at boot the worker closes under stays out of onerror', async (t) => {
  const testnet = await makeTestnet(t)
  const opts = { bootstrap: testnet.bootstrap }
  const storage = await t.tmp()
  const phrase = Identity.toPhrase(Identity.randomBytes(32))
  await t.exception(cero(storage, spec, { ...opts, phrase, recoveryTimeout: 500 }), /TIMEOUT/)
  const errors = []
  const [serverStream] = pair()
  const onerror = (err) => errors.push(err)
  const server = await serve(serverStream, spec, { storage, ...opts, recoveryTimeout: 0, onerror })
  t.ok(server._booting, 'the recovery goes on at boot')
  await server.close()
  t.alike(errors, [], 'nothing reached onerror')
})

test('rpc: a start at boot that fails while an init waits on it reaches onerror once', async (t) => {
  const testnet = await makeTestnet(t)
  const storage = await t.tmp()
  await (await cero(storage, spec, { bootstrap: testnet.bootstrap })).close()
  const [serverStream, clientStream] = pair()
  const errors = []
  const onerror = (err) => errors.push(err.message)
  const server = new Server(serverStream, spec, { storage, bootstrap: testnet.bootstrap, onerror })
  t.teardown(() => server.close().catch(() => {}), { order: 5 })
  server._wireVerbs = function () {
    delete this._wireVerbs
    throw new Error('wiring failed')
  }
  const client = new Client(clientStream, spec)
  t.teardown(() => client.close().catch(() => {}), { order: 4 })
  const opening = client.ready()
  server.ready()
  await t.exception(opening, /wiring failed/)
  t.alike(errors, ['wiring failed'], 'one failure, one report')
})

// a worker on a new store, and the client that says how it opens
async function fresh(t, testnet, opts = {}) {
  const [serverStream, clientStream] = pair()
  const server = await serve(serverStream, spec, {
    storage: await t.tmp(),
    bootstrap: testnet.bootstrap,
    ...opts
  })
  t.teardown(() => server.close().catch(() => {}), { order: 5 })
  const open = (how) => {
    const client = new Client(clientStream, spec, how)
    t.teardown(() => client.close().catch(() => {}), { order: 4 })
    return client.ready().then(() => client)
  }
  return { server, storage: server.storage, open, ipc: clientStream }
}

test('rpc: a new store opens nothing until the client says how, and a wrong phrase leaves no profile', async (t) => {
  const testnet = await makeTestnet(t)
  const { storage, open } = await fresh(t, testnet)
  t.is(await cero.peek(storage, spec), null, 'nothing before the client')
  const phrase = Identity.toPhrase(Identity.randomBytes(32)).split(' ').slice(1).join(' ')
  await t.exception(open({ phrase }), /BIP-39/)
  t.is(await cero.peek(storage, spec), null, 'no profile')
})

test('rpc: on a new store the client recovers with a phrase, links with an invite, or creates', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => owner.close().catch(() => {}), { order: 6 })

  const recovered = await (await fresh(t, testnet)).open({ phrase: await cero.phrase(owner) })
  t.is(recovered.id, owner.id, 'recovered')

  let request = null
  const invite = await cero.invite(owner)
  const linking = (await fresh(t, testnet)).open({ invite, onrequest: (id) => (request = id) })
  await accept(owner, await nextRequest(owner))
  t.is((await linking).id, owner.id, 'linked')
  t.ok(request, 'the request id reached the client')

  const created = await (await fresh(t, testnet)).open()
  t.not(created.id, owner.id, 'a new identity')
})

test('rpc: a recovery the worker closes on goes on at its next open and ends once a device of it is online', async (t) => {
  const testnet = await makeTestnet(t)
  const opts = { bootstrap: testnet.bootstrap }
  const ownerDir = await t.tmp()
  const owner = await cero(ownerDir, spec, opts)
  const { id } = owner
  const phrase = await cero.phrase(owner)
  await owner.close()

  const first = await fresh(t, testnet, { recoveryTimeout: 0 })
  first.open({ phrase }).catch(() => {})
  await waitUntil(() => first.server._booting !== null)
  await first.server.close()
  // the worker gone: its pipe goes with it
  first.ipc.destroy()
  t.is(await cero.peek(first.storage, spec), 'recovering', 'the recovery is kept')

  const [serverStream, clientStream] = pair()
  const storage = first.storage
  const server = await serve(serverStream, spec, { storage, ...opts, recoveryTimeout: 0 })
  t.teardown(() => server.close().catch(() => {}), { order: 5 })
  const resumed = connect(clientStream, spec)
  const again = await cero(ownerDir, spec, opts)
  t.teardown(() => again.close().catch(() => {}), { order: 6 })
  const client = await resumed
  t.teardown(() => client.close().catch(() => {}), { order: 4 })
  t.is(client.id, id, 'the identity of the phrase')
})

test('rpc: a join that lands after the caller stopped waiting shows up in handles', async (t) => {
  const { me, client, testnet } = await openPair(t)
  const owner = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => owner.close().catch(() => {}), { order: 5 })
  const room = await open(owner.team, { name: 'clinic' })
  const invite = await cero.invite(room)
  await cero.suspend(owner)

  // the server's join times out the way a client's open does, only sooner
  const err = await me._join(invite, 'team', { timeout: 500 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT')

  const arrived = (async () => {
    for await (const { data } of watch(client.handles)) {
      if (data.some((row) => row.id === room.id && row.state === 'in')) return true
    }
  })()
  t.is((await get(client.team, room.id)).data.state, 'asking', 'its row reads asking meanwhile')
  await cero.resume(owner)
  t.ok(await arrived, 'the client sees the room once a member answers')
  t.is((await open(client.team, { id: room.id })).id, room.id)
})

test("rpc: the UI sees a confirm invite's requests and answers them", async (t) => {
  const { client, testnet } = await openPair(t)
  const room = await open(client.team, { name: 'gated' })
  const invite = await cero.invite(room, { role: 'member', confirm: true, reuse: true })

  const ana = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => ana.close().catch(() => {}), { order: 5 })
  const joining = open(ana.team, invite)
  const request = await nextRequest(room)
  t.alike(request.identity, ana.identity.publicKey, 'who is asking')
  t.is(request.role, 'member', 'as what, over the wire too')
  await accept(room, request)
  t.is((await joining).id, room.id, 'accepted from the UI')

  const bob = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => bob.close().catch(() => {}), { order: 5 })
  const refused = open(bob.team, invite).catch((e) => e)
  await deny(room, await nextRequest(room, request), 'not now')
  t.is((await refused).code, 'DENIED', 'denied from the UI')
})

test('rpc: a promise withdrawn while the UI waits for its seat rejects DENIED, with the reason', async (t) => {
  const { me, client, testnet } = await openPair(t)
  const owner = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => owner.close().catch(() => {}), { order: 5 })
  const room = await open(owner.team, { name: 'clinic' })
  const promised = () =>
    waitUntil(async () => (await get(room.requests)).data.find((r) => r.promised) || null)
  const withdraw = async () => deny(room, await promised(), 'not you')

  const err = await refusedAtClaim(t, me, client.team, await cero.invite(room), withdraw)
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'not you')
  t.is((await get(client.team)).data.length, 0, 'in no room')
  const [row] = (await get(client.team, { state: 'denied' })).data
  t.alike([row.state, row.reason], ['denied', 'not you'], 'its row reads denied, with the reason')
})

test('rpc: a join denied to the UI rejects with the reason', async (t) => {
  const { client, testnet } = await openPair(t)
  const owner = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => owner.close().catch(() => {}), { order: 5 })
  const room = await open(owner.team, { name: 'gated' })
  const refused = open(client.team, await cero.invite(room, { confirm: true })).catch((e) => e)
  await deny(room, await nextRequest(room), 'full')
  const err = await refused
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'full')
})

test("rpc: what a room refuses at apply reaches the client's onerror", async (t) => {
  const errors = []
  const { me, server, client } = await openPair(t, {}, { onerror: (err) => errors.push(err) })
  await waitUntil(() => server._errors.size === 1)
  await open(client.team, { name: 'clinic' })
  const [room] = me.children
  // past genesis nobody adds a member: the room's own device appends one, as a modified app could
  const { wrap } = await import('../../../core/src/database/envelope.js')
  const key = Identity.randomBytes(32)
  const forged = { id: z32.encode(key), key, role: 'owner', createdAt: 1, updatedAt: 1 }
  const op = spec.handles.team.dispatch.encode('@cero/add-member', forged)
  await room.store.bee.append(wrap(room.store.version, op))
  const refused = await waitUntil(() => errors.find((err) => err.code === 'REFUSED'), 5000).catch(
    () => null
  )
  t.ok(refused, 'the room reports it to the app, as the root does its own')
})

test('rpc: a denial after the join stopped waiting reaches onerror with the reason', async (t) => {
  const errors = []
  const { me, testnet } = await openPair(t, {}, { onerror: (err) => errors.push(err) })
  const owner = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => owner.close().catch(() => {}), { order: 5 })
  const room = await open(owner.team, { name: 'gated' })
  const invite = await cero.invite(room, { confirm: true })
  t.is((await me._join(invite, 'team', { timeout: 500 }).catch((e) => e)).code, 'TIMEOUT')
  await deny(room, await nextRequest(room), 'full')
  const late = await waitUntil(() => errors.find((err) => err.code === 'DENIED'))
  t.is(late.reason, 'full')
})

test('rpc: pending joins are listed and cancelled over the wire', async (t) => {
  const { client } = await openPair(t)
  const random = () => Identity.randomBytes(32)
  const link = { key: random(), length: 1 }
  const invite = Invite.create({ key: random(), address: random(), link }).toString()
  const joining = open(client.team, invite).catch((e) => e)
  await waitUntil(async () => ((await joinsOf(client)).length ? true : null))
  t.alike(await joinsOf(client), [invite])
  const id = hid.encode(Invite.parse(invite).key)
  t.is((await get(client.team, id)).data.state, 'asking', 'the UI reads the join on its row')
  t.ok(await cero.cancel(client, invite))
  t.alike(await joinsOf(client), [])
  t.is((await joining).code, 'CANCELLED')
  t.is((await get(client.team, id)).data.state, 'cancelled')
})

// an invite nobody serves, so its join stays asking
function nowhere(opts) {
  const random = () => Identity.randomBytes(32)
  const link = { key: random(), length: 1 }
  return Invite.create({ key: random(), address: random(), link, ...opts }).toString()
}

test('rpc: a join whose invite expires rejects EXPIRED over the bridge, and its row reads expired', async (t) => {
  const { client } = await openPair(t)
  const invite = nowhere({ ttl: 1500 })
  t.is((await open(client.team, invite).catch((e) => e)).code, 'EXPIRED')
  const id = hid.encode(Invite.parse(invite).key)
  t.is((await get(client.team, id)).data.state, 'expired')
})

test('rpc: a cancel from a second device ends the join the UI waits on with CANCELLED', async (t) => {
  const { me, client, testnet } = await openPair(t)
  const other = await cero(await t.tmp(), spec, {
    bootstrap: testnet.bootstrap,
    phrase: await cero.phrase(me)
  })
  t.teardown(() => other.close().catch(() => {}), { order: 5 })
  const invite = nowhere()
  const joining = open(client.team, invite).catch((e) => e)
  const id = hid.encode(Invite.parse(invite).key)
  await waitUntil(async () => (await get(other.team, id)).data?.state === 'asking')
  t.ok(await cero.cancel(other, invite), 'no join of its own, the second device cancels it')
  t.is((await joining).code, 'CANCELLED')
  t.is((await get(client.team, id)).data.state, 'cancelled')
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
  t.is(row.url, got.url, 'the written row carries the same url')
  const res = await fetch(got.url)
  t.is(res.status, 200, 'url serves 200')
  const body = b4a.from(await res.arrayBuffer())
  t.alike(b4a.toBuffer(body), b4a.toBuffer(data), 'http body is byte-perfect')
})

test('rpc: a stored type a header cannot carry is left out of the url, and the file serves', async (t) => {
  const { client, me } = await openPair(t)
  const { data: file } = await put(client.files, { data: b4a.from('x'), type: 'text/plain' })
  const { coreKey, blobId } = decodeId(file.id)
  // as an earlier build could have stored it: the id's own layout, with a CR in its type
  const fields = [blobId.blockOffset, blobId.blockLength, blobId.byteOffset, blobId.byteLength]
  const raw = [coreKey, ...fields.map((n) => c.encode(c.uint, n)), c.encode(c.string, 'a\r\nb')]
  const id = z32.encode(b4a.concat(raw))
  await me.store.call('add-file', { id })
  const { data: row } = await get(client.files, id)
  t.absent(new URL(row.url).searchParams.get('type'), 'no type in the url')
  const res = await fetch(row.url)
  t.is(res.status, 200, 'the bytes are served')
})

test('rpc: a file with an empty type that another member wrote serves through the client', async (t) => {
  const { client, testnet } = await openPair(t)
  const owner = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => owner.close().catch(() => {}), { order: 5 })
  const room = await open(owner.team, { name: 'files' })
  const data = b4a.from('no type')
  const { data: file } = await put(room.files, { data, type: '' })
  const mine = await open(client.team, await cero.invite(room))
  const row = await waitUntil(async () => (await get(mine.files, file.id)).data)
  const body = await waitUntil(async () => {
    const res = await fetch(row.url)
    return res.ok ? b4a.from(await res.arrayBuffer()) : null
  })
  t.alike(b4a.toBuffer(body), b4a.toBuffer(data), 'the bytes the owner wrote')
})

test('rpc: a file field reads back as a file whose url serves the bytes', async (t) => {
  const { client } = await openPair(t)
  const data = b4a.from('an-avatar')
  const { data: file } = await put(client.files, { data, name: 'a.png', type: 'image/png' })
  await set(client.profile, { name: 'Ada', avatar: file.id })

  const { data: profile } = await get(client.profile)
  t.is(profile.avatar.id, file.id, 'the field carries the file')
  t.is(profile.avatar.type, 'image/png')
  const res = await fetch(profile.avatar.url)
  t.is(res.status, 200, 'its url serves the bytes')
  t.alike(b4a.toBuffer(b4a.from(await res.arrayBuffer())), b4a.toBuffer(data))

  const first = await new Promise((resolve) => watch(client.profile).once('data', resolve))
  t.is(first.data.avatar.id, file.id, 'a watch carries it the same way')
})

test('rpc: after a phrase restore, a new file url serves its bytes', async (t) => {
  const { client, testnet } = await openPair(t)
  const other = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => other.close().catch(() => {}), { order: 4 })

  await restore(client, await cero.phrase(other))
  t.is(client.id, other.id, 'the UI is the restored identity')
  const data = b4a.from('after-restore')
  const { data: file } = await put(client.files, { data, name: 'r.txt', type: 'text/plain' })
  const res = await fetch(file.url)
  t.is(res.status, 200, 'the new root serves it')
  t.alike(b4a.toBuffer(b4a.from(await res.arrayBuffer())), b4a.toBuffer(data))
})

test('rpc: put on a single is INVALID, as in process', async (t) => {
  const { client } = await openPair(t)
  await t.exception(put(client.profile, { name: 'Ada' }), /INVALID.*set/)
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

test('rpc: closing the root ends a live local watch without throwing', async (t) => {
  const { me, client } = await openPair(t)
  const stream = watch(client.local.drafts)
  let snapshots = 0
  let closed = false
  let error = null
  stream.on('data', () => snapshots++)
  stream.on('error', (err) => (error = err))
  stream.on('close', () => (closed = true))
  await waitUntil(() => snapshots >= 1)
  await cero.close(me)
  await waitUntil(() => closed, 5000)
  t.is(error, null, 'the watch ended with its root, without an error')
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

test('rpc: the UI turns the radio off and on, and reads it', async (t) => {
  const { client } = await openPair(t, { bluetooth: { on: true, backend: makeMockBluetooth() } })
  const radio = async () => (await get(client.status)).data.nearby
  t.is(await radio(), 'on')
  await cero.nearby(client, false)
  t.is(await radio(), 'off')
  await cero.nearby(client, true)
  t.is(await radio(), 'on')
  await cero.nearby(client, false)
  await t.exception(cero.nearby(client, 'yryinvite'), /INVALID/, 'an invite is not a mode')
  await t.exception(cero.nearby(client, { on: true }), /INVALID/, 'nor an object')
  await t.exception(cero.nearby(client, true, { topic: null }), /INVALID/, 'nor a null topic')
  t.is(await radio(), 'off', 'and none turned the radio on')
  await cero.nearby(client, false, { topic: 'hall-1' })
  t.is(await radio(), 'off', 'false with a topic stays off')
  await cero.nearby(client, true, { topic: 'hall-1' })
  t.is(await radio(), 'on', 'true with a topic comes on')
})

test('rpc: the UI reads who is nearby, with their name and device type', async (t) => {
  const radio = makeMockBluetooth()
  const { me, client } = await openPair(t, { bluetooth: { on: true, backend: radio } })
  const testnet = await makeTestnet(t)
  const opts = {
    bootstrap: testnet.bootstrap,
    isMobile: true,
    bluetooth: { on: true, backend: radio }
  }
  const other = await cero(await t.tmp(), spec, opts)
  t.teardown(() => other.close().catch(() => {}), { order: 5 })
  await set(other.profile, { name: 'bee' })

  const peer = await waitUntil(
    async () => (await get(client.nearby)).data.find((p) => p.name) ?? null
  )
  t.alike(
    peer,
    await waitUntil(async () => (await get(me.nearby)).data[0] ?? null),
    'as the worker sees it'
  )
  t.alike(
    { ...peer, device: typeof peer.device },
    { id: other.id, device: 'string', name: 'bee', isMobile: true }
  )
})

test('rpc: an app function runs the same in the worker and in the UI', async (t) => {
  const { me, client } = await openPair(t)
  const rename = (ctx, name) => set(ctx.profile, { name })
  await rename(client, 'Remote')
  t.is((await get(me.profile)).data.name, 'Remote', 'called with the UI root')
  await rename(me, 'Local')
  t.is((await get(client.profile)).data.name, 'Local', 'called with the worker root')
})

test('rpc: watch carries the same changes over the wire as locally', async (t) => {
  const { server, client } = await openPair(t)

  const remote = watch(client.messages, { changes: true })
  const local = watch(server.me.messages, { changes: true })
  t.teardown(() => {
    remote.destroy()
    local.destroy()
  })
  const remoteBatches = []
  const localBatches = []
  remote.on('data', (b) => remoteBatches.push(b))
  local.on('data', (b) => localBatches.push(b))

  await waitUntil(() => remoteBatches.length >= 1)
  t.is(remoteBatches[0].reset, true, 'the first item resets on the client too')

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

test('rpc: open by id refuses a handle of another type, as in process', async (t) => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '.build-rpc')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }), { order: 10 })
  const notes = { notes: cero.t.collection({ text: cero.t.string }) }
  await build(dir, cero.schema({ expo: notes, group: notes }), { extensions: [] })
  const { spec: two } = await import(pathToFileURL(join(dir, 'index.js')).href)
  const testnet = await makeTestnet(t)
  const [serverStream, clientStream] = pair()
  const storage = await t.tmp()
  const server = await serve(serverStream, two, {
    storage,
    bootstrap: testnet.bootstrap,
    extensions: []
  })
  const client = await connect(clientStream, two)
  t.teardown(
    async () => {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    },
    { order: 5 }
  )

  const expo = await open(client.expo, { name: 'fair' })
  await t.exception(open(client.group, { id: expo.id }), /INVALID/, 'another type is refused')
  t.is((await open(client.expo, { id: expo.id })).type, 'expo', 'its own type opens')
})

test('rpc: a client links the app to another identity by invite, the request id on both sides', async (t) => {
  const { client, testnet } = await openPair(t)
  const other = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => other.close().catch(() => {}), { order: 4 })

  let code = null
  const linking = link(client, await cero.invite(other), { onrequest: (id) => (code = id) })
  linking.catch(() => {})
  const request = await nextRequest(other)
  t.is(request.id, code, 'the same id on both screens')
  await cero.accept(other, request)
  await linking
  t.is(client.id, other.id, 'the UI is the linked identity')
  await t.exception(cero.phrase(client), /no phrase on this device/, 'no phrase on a linked device')
  const { data: file } = await put(client.files, {
    data: b4a.from('linked'),
    name: 'l.txt',
    type: 'text/plain'
  })
  t.is((await fetch(file.url)).status, 200, 'the new root serves files')
})

test('rpc: a denied link rejects DENIED on the client', async (t) => {
  const { client, testnet } = await openPair(t)
  const other = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => other.close().catch(() => {}), { order: 4 })
  const linking = link(client, await cero.invite(other))
  await cero.deny(other, await nextRequest(other), 'not mine')
  await t.exception(linking, /DENIED/)
})

test('rpc: a client gets BEHIND on a write while the worker is behind, and still reads', async (t) => {
  const { me, client } = await openPair(t)
  const { data: mine } = await put(client.messages, { text: 'mine' })
  // its owner moves the root to a newer app's version
  await me.store.write([['upgrade', { version: me.store.version + 1 }]])
  await waitUntil(async () => (await get(client.status)).data.behind === me.store.version + 1)

  const err = await put(client.messages, { text: 'stale' }).catch((e) => e)
  t.is(err?.code, 'BEHIND', 'the code crosses the wire')
  t.is((await get(client.messages, mine.id)).data?.text, 'mine', 'reads go on')
})

test('rpc: send from a client reaches an inbox, signed by the worker identity', async (t) => {
  const { me, client, testnet } = await openPair(t)
  const dir = await t.tmp()
  const other = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => other.close(), { order: 4 })
  const secret = Identity.randomBytes(32)
  const got = []
  t.teardown(inbox(other, secret, (data, sender) => got.push({ data, sender })))

  await send(client, cero.address(secret), { kind: 'pass', unit: 5 })

  await waitUntil(() => got.length > 0)
  t.alike(got[0].data, { kind: 'pass', unit: 5 })
  t.is(got[0].sender.from, me.identity.id)
})

test('rpc: send passes keep on to the worker', async (t) => {
  const { me, client } = await openPair(t)
  const seen = []
  const post = me.mailbox.send.bind(me.mailbox)
  me.mailbox.send = (to, m, opts) => seen.push(opts.keep) && post(to, m, opts)

  await send(client, cero.address(Identity.randomBytes(32)), 'x', { keep: false })
  t.alike(seen, [false])
})

test("rpc: inbox is the worker's, INVALID on a client", async (t) => {
  const { client } = await openPair(t)
  t.exception(() => inbox(client, Identity.randomBytes(32), () => {}), /INVALID/)
})

// a host's room the UI's identity is in
async function hostedRoom(t) {
  const { me, client, testnet } = await openPair(t)
  const host = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => host.close().catch(() => {}), { order: 5 })
  const room = await open(host.team, { name: 'clinic' })
  const joined = await open(client.team, await cero.invite(room))
  await waitUntil(async () => (await get(room.members, me.identity.id)).data)
  return { me, client, host, room, joined }
}

test('rpc: leave reads leaving, then the row is gone in the UI once the room holds the removal', async (t) => {
  const { me, client, room, joined } = await hostedRoom(t)
  await cero.leave(joined)
  t.ok([undefined, 'leaving'].includes((await get(client.team, room.id)).data?.state), 'leaving')
  await waitUntil(async () => !(await get(client.team, room.id)).data)
  t.is(await room.store.removed(me.identity.id), 'left', 'the room holds her leaving')
})

test('rpc: a removal by an admin reads removed in the UI, with her id in by', async (t) => {
  const { me, client, host, room } = await hostedRoom(t)
  await del(room.members, me.identity.id)
  const row = await waitUntil(async () => {
    const { data } = await get(client.team, room.id)
    return data.state === 'removed' ? data : null
  })
  t.is(row.by, host.identity.id, 'by the admin')
})

test('rpc: status.owed reads in the UI as in the worker, true while its device waits for keys and false after', async (t) => {
  const { client, testnet } = await openPair(t)
  const other = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => other.close().catch(() => {}), { order: 5 })
  const room = await open(other.team, { name: 'keys' })
  const mine = await open(client.team, await cero.invite(room))
  await waitUntil(async () => (await get(room.members)).data.length === 2 || null)
  t.is((await get(mine.status)).data.owed, false)
  const seen = []
  cero.watch(mine.status).on('data', ({ data }) => seen.push(data.owed))

  // the next key sealed to the other's device alone, and a write under it
  const { data: devices } = await room.store.get('devices')
  const own = devices.filter((d) => d.memberId === other.identity.id)
  await room.store.rotation._rotate(false, own)
  await put(room.messages, { text: 'under' })
  await waitUntil(async () => seen.includes(true) || null)
  t.pass('owed in the UI once its device asked')
  await waitUntil(async () => (await get(mine.messages)).data.length === 1 || null)
  await waitUntil(async () => (await get(mine.status)).data.owed === false || null)
  t.pass('and not once it was sent them')
})

test('rpc: a wrong phrase on a new store leaves the worker able to create', async (t) => {
  const testnet = await makeTestnet(t)
  const { open } = await fresh(t, testnet)
  const phrase = Identity.toPhrase(Identity.randomBytes(32)).split(' ').slice(1).join(' ')
  await t.exception(open({ phrase }), /BIP-39/)
  const created = await open().catch((err) => err)
  t.ok(created?.id, `created after the wrong phrase: ${created?.message ?? ''}`)
})

test('rpc: a link denied on a new store leaves the worker able to create', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => owner.close().catch(() => {}), { order: 6 })
  const { open } = await fresh(t, testnet)
  const linking = open({ invite: await cero.invite(owner) })
  linking.catch(() => {})
  await deny(owner, await nextRequest(owner))
  await t.exception(linking, /DENIED/)
  const created = await open()
  t.not(created.id, owner.id, 'a new identity')
})

test('rpc: a link that expires on a new store leaves the worker able to create', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => owner.close().catch(() => {}), { order: 6 })
  const { open } = await fresh(t, testnet)
  await t.exception(open({ invite: await cero.invite(owner, { ttl: 1000 }) }), /EXPIRED/)
  const created = await open()
  t.not(created.id, owner.id, 'a new identity')
})
