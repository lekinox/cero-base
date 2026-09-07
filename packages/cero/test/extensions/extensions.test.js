import test from 'brittle'
import AbortController from 'bare-abort-controller'
import process from 'process'
import { promises as fs, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import {
  cero,
  put,
  set,
  get,
  del,
  open,
  watch,
  before,
  after,
  restore,
  schema,
  t
} from '../../src/index.js'
import { build } from '../../src/build/index.js'
import { profileSync, handleSync } from '../../src/extensions/index.js'
import { makeTestnet, waitUntil, waitForConnection } from '../helpers/index.js'

test.configure({ timeout: 60000 })

const here = dirname(fileURLToPath(import.meta.url))
const buildRoot = join(here, '..', 'fixtures', '.build-extensions')
process.on('exit', () => rmSync(buildRoot, { recursive: true, force: true }))

const base = schema({
  profile: t.single({ name: t.string, avatar: t.string }),
  notes: t.collection({ text: t.string }),
  room: {
    messages: t.collection({ text: t.string }),
    audits: t.collection({ text: t.string }),
    banned: t.collection({ reason: t.string })
  }
})

// Defined at module level — inside a brittle `(t) =>` callback, `t` is the test
// object, not the schema DSL.
const tagExtension = { schema: { members: t.extend({ tag: t.string }) } }

const appExtendSchema = schema({
  profile: t.single({ name: t.string, avatar: t.string }),
  members: t.extend({ tag: t.string }),
  room: { messages: t.collection({ text: t.string }) }
})

const customSchema = schema({
  profile: t.single({ name: t.string, status: t.string }),
  room: { messages: t.collection({ text: t.string }) }
})
const statusSync = profileSync({ fields: { status: t.string } })

const noProfileSchema = schema({
  notes: t.collection({ text: t.string }),
  room: { messages: t.collection({ text: t.string }) }
})

const roomOnly = schema({ room: { messages: t.collection({ text: t.string }) } })

// a handle type that has its own profile — what handleSync mirrors
const handleSchema = schema({
  room: {
    messages: t.collection({ text: t.string }),
    profile: t.single({ name: t.string, avatar: t.string })
  }
})

const handleStatusSchema = schema({
  room: {
    messages: t.collection({ text: t.string }),
    profile: t.single({ name: t.string, status: t.string })
  }
})
const handleStatus = handleSync({ fields: { status: t.string } })

// a profile WIDER than the mirrored field set — reflect must not push the
// extra fields onto the handles row (they would fail its schema)
const handleWideSchema = schema({
  room: {
    messages: t.collection({ text: t.string }),
    profile: t.single({ name: t.string, status: t.string, motto: t.string })
  }
})

const reset = () => {
  cero._registry.length = 0
}

async function buildSpec(t, sub, sch = base) {
  const dir = join(buildRoot, sub)
  await fs.rm(dir, { recursive: true, force: true })
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await build(dir, sch)
  const { spec } = await import(pathToFileURL(join(dir, 'index.js')).href)
  return { spec, dir }
}

async function openCero(t, spec) {
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return me
}

async function openTwo(t, spec) {
  const testnet = await makeTestnet(t)
  const mk = async () => {
    const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
    t.teardown(() => me.close().catch(() => {}), { order: 5 })
    return me
  }
  return { host: await mk(), joiner: await mk() }
}

async function memberType(dir) {
  const { schema: types } = JSON.parse(
    await fs.readFile(join(dir, 'main/schema/schema.json'), 'utf-8')
  )
  return types.find((x) => x.name === 'member')
}

// ─── after(ref): write events ───────────────────────────────────────────────

test('after(ref): fires on a single set with ctx { op, name, row }', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'after-single')).spec)
  let ctx = null
  after(me.profile, (c) => (ctx = c))
  await set(me.profile, { name: 'a' })
  t.is(ctx?.op, 'set')
  t.is(ctx?.name, 'profile')
  t.is(ctx?.row.name, 'a')
})

// a hook runs twice on the writer: once in its dry run, once at apply
test('after(ref): fires on collection put / set / del', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'after-coll')).spec)
  const ops = []
  after(me.notes, (c) => ops.push(c.op))
  const { data } = await put(me.notes, { text: 'x' })
  await set(me.notes, { id: data.id, text: 'y' })
  await del(me.notes, data.id)
  // an upsert on a collection applies as an add, so a hook sees it as a put
  t.alike(ops, ['put', 'put', 'put', 'put', 'del', 'del'], 'fired on each write op')
})

test('after(ref): only the named ref, and unsubscribes', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'after-filter')).spec)
  let hits = 0
  const off = after(me.profile, () => hits++)
  await put(me.notes, { text: 'x' })
  t.is(hits, 0, 'a different ref does not fire')
  await set(me.profile, { name: 'a' })
  t.is(hits, 2, 'the named ref fires')
  off()
  await set(me.profile, { name: 'b' })
  t.is(hits, 2, 'stops after unsubscribe')
})

test('after(ref): multiple subscribers all fire', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'after-multi')).spec)
  let a = 0
  let b = 0
  after(me.profile, () => a++)
  after(me.profile, () => b++)
  await set(me.profile, { name: 'x' })
  t.is(a, 2)
  t.is(b, 2)
})

test('after(ref): a derived row written through ctx.put lands on every peer', async (t) => {
  const { spec } = await buildSpec(t, 'hook-tx')
  const { host, joiner } = await openTwo(t, spec)

  const room = await open(host.room)
  const invite = await room.invite({ role: 'member', expiresIn: 60_000 })
  const joined = await open(joiner.room, invite)
  await waitForConnection(host.network)
  await waitForConnection(joiner.network)
  await waitUntil(() => joined.store.writable)

  const audit = (c) =>
    c.op === 'del'
      ? c.set('audits', { id: `a-${c.id}`, text: 'deleted' })
      : c.put('audits', { id: `a-${c.row.id}`, text: c.row.text })
  after(room.messages, audit)
  after(joined.messages, audit)

  const { data: row } = await put(room.messages, { text: 'hello' })
  const onHost = await waitUntil(async () => (await get(room.audits, `a-${row.id}`)).data)
  const onJoiner = await waitUntil(async () => (await get(joined.audits, `a-${row.id}`)).data)
  t.is(onHost.text, 'hello', 'the hook wrote the derived row')
  t.alike(onJoiner, onHost, 'byte for byte the same row on both peers')

  await del(room.messages, row.id)
  const edited = await waitUntil(async () => {
    const { data } = await get(joined.audits, `a-${row.id}`)
    return data?.text === 'deleted' ? data : null
  })
  t.is(edited.createdAt, onHost.createdAt, 'ctx.set merged over the row it found')
})

test('before(ref): ctx.get reads the room as it stands at this op', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'hook-read')).spec)
  const room = await open(me.room)

  before(room.messages, async ({ memberId, get: read }) => {
    if ((await read(room.banned, memberId)).data) return false
  })

  await put(room.messages, { text: 'fine' })
  await put(room.banned, { id: me.identity.id, reason: 'spam' })

  const err = await put(room.messages, { text: 'blocked' }).catch((e) => e)
  t.is(err.code, 'REFUSED', 'the rule read the ban it was written under')
  t.is((await get(room.messages)).data.length, 1)
})

// ─── before(ref): write hooks ───────────────────────────────────────────────

test('before(ref): returning false refuses the write', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'before-cancel')).spec)
  before(me.notes, (c) => (c.row.text === 'no' ? false : undefined))
  const err = await put(me.notes, { text: 'no' }).catch((e) => e)
  t.is(err.code, 'REFUSED', 'the writer learns at its own dry run')
  await put(me.notes, { text: 'yes' })
  const { data } = await get(me.notes)
  t.is(data.length, 1, 'refused write not stored')
  t.is(data[0].text, 'yes')
})

test('before(ref): mutating ctx.row rewrites the stored row', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'before-mutate')).spec)
  before(me.notes, (c) => {
    c.row.text = c.row.text.toUpperCase()
  })
  const { data: submitted } = await put(me.notes, { text: 'hi' })
  t.is(submitted.text, 'hi', 'the call returns the row it submitted')
  const { data } = await get(me.notes, submitted.id)
  t.is(data.text, 'HI', 'the hook decides what lands')
})

test('before(ref): a mutated row lands identically on every peer', async (t) => {
  const { spec } = await buildSpec(t, 'hook-mutate-two')
  const { host, joiner } = await openTwo(t, spec)

  const room = await open(host.room)
  const invite = await room.invite({ role: 'member', expiresIn: 60_000 })
  const joined = await open(joiner.room, invite)
  await waitForConnection(host.network)
  await waitForConnection(joiner.network)
  await waitUntil(() => joined.store.writable)

  const shout = (c) => {
    c.row.text = c.row.text.toUpperCase()
  }
  before(room.messages, shout)
  before(joined.messages, shout)

  const { data: submitted } = await put(room.messages, { text: 'shout' })
  const onHost = await waitUntil(async () => (await get(room.messages, submitted.id)).data)
  const onJoiner = await waitUntil(async () => (await get(joined.messages, submitted.id)).data)
  t.is(onHost.text, 'SHOUT', 'the rewrite landed')
  t.alike(onJoiner, onHost, 'and every peer derived the same row')
})

test('before(ref): only the named ref, and unsubscribes', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'before-filter')).spec)
  let hits = 0
  const off = before(me.notes, () => {
    hits++
  })
  await set(me.profile, { name: 'a' })
  t.is(hits, 0, 'a different ref does not fire')
  await put(me.notes, { text: 'x' })
  t.is(hits, 2, 'the named ref fires')
  off()
  await put(me.notes, { text: 'y' })
  t.is(hits, 2, 'stops after unsubscribe')
})

test('before(ref): refusing a del keeps the row', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'before-del')).spec)
  const { data: row } = await put(me.notes, { text: 'keep' })
  before(me.notes, (c) => (c.op === 'del' ? false : undefined))
  const err = await del(me.notes, row.id).catch((e) => e)
  t.is(err.code, 'REFUSED')
  const { data } = await get(me.notes)
  t.is(data.length, 1, 'del refused — row survives')
  t.is(data[0].id, row.id)
})

test('before(ref): an operator called inside a hook throws INVALID', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'before-nested')).spec)
  let err = null
  before(me.notes, async () => {
    try {
      await put(me.notes, { text: 'nested' })
    } catch (e) {
      err = e
    }
  })
  await put(me.notes, { text: 'outer' })
  t.is(err?.code, 'INVALID')
  t.ok(/ctx\.put/.test(err.message), 'points at the ctx operators')
})

// ─── me.on('handle') ────────────────────────────────────────────────────────

test('me.on("handle"): fires on create and on re-open', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'handle-evt')).spec)
  const seen = []
  me.on('handle', (room) => seen.push(room))

  const room = await open(me.room)
  t.is(seen.length, 1, 'fired on create')
  t.is(seen[0], room)

  const id = room.id
  await room.close()
  const reopened = await open(me.room, { id })
  t.is(seen.length, 2, 'fired on re-open')
  t.is(seen[1], reopened)
})

test('me.on("handle"): re-loading an already-open handle is idempotent — no re-sync', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'handle-idempotent')).spec)
  let fired = 0
  me.on('handle', () => fired++)

  const room = await open(me.room)
  t.is(fired, 1, 'fired once on create')

  const { id } = room
  let cachedEvery = true
  for (let i = 0; i < 1000; i++) {
    if ((await open(me.room, { id })) !== room) cachedEvery = false
  }
  t.ok(cachedEvery, 'every re-load returned the same cached instance')
  t.is(fired, 1, 're-loading an open handle 1000x never re-fired — extensions sync once')
})

test('me.on("handle"): concurrent open() of the same id loads once', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'concurrent-open')).spec)
  const room = await open(me.room)
  const { id } = room
  await room.close() // drop it from me.children so the reopen goes through _load

  let fired = 0
  me.on('handle', () => fired++)
  const results = await Promise.all([
    open(me.room, { id }),
    open(me.room, { id }),
    open(me.room, { id })
  ])

  t.is(new Set(results).size, 1, 'concurrent opens resolve to the same instance')
  t.is(me.children.size, 1, 'one child registered — no leak')
  t.is(fired, 1, 'handle event fired exactly once')
})

test('me.on("handle"): carries the open opts (the create name)', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'handle-opts')).spec)
  let opts = null
  me.on('handle', (room, o) => (opts = o))
  await open(me.room, { name: 'general' })
  t.is(opts?.name, 'general', 'create name passed through the handle event')
})

// ─── cero.use(): registration forms ─────────────────────────────────────────

test('cero.use: object form runs setup with the ready handle', async (t) => {
  let captured = null
  cero.use({ setup: (me) => (captured = me) })
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'use-obj')).spec)
  t.is(captured, me)
})

test('cero.use: a bare function is shorthand for { setup }', async (t) => {
  let captured = null
  cero.use((me) => (captured = me))
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'use-fn')).spec)
  t.is(captured, me)
})

test('cero.use: multiple extensions all run', async (t) => {
  const ran = []
  cero.use(
    () => ran.push('a'),
    () => ran.push('b')
  )
  cero.use(() => ran.push('c'))
  t.teardown(reset)
  await openCero(t, (await buildSpec(t, 'use-multi')).spec)
  t.alike(ran.sort(), ['a', 'b', 'c'])
})

test('cero.use: accepts an array, and a mix of arrays and args', async (t) => {
  const ran = []
  cero.use([() => ran.push('a'), () => ran.push('b')])
  cero.use(() => ran.push('c'), [() => ran.push('d')])
  t.teardown(reset)
  await openCero(t, (await buildSpec(t, 'use-array')).spec)
  t.alike(ran.sort(), ['a', 'b', 'c', 'd'])
})

test('cero.use: a schema-only extension merges and runs without a setup', async (t) => {
  cero.use(tagExtension)
  t.teardown(reset)
  const { spec, dir } = await buildSpec(t, 'use-schema-only')
  t.ok(
    (await memberType(dir)).fields.find((f) => f.name === 'tag'),
    'schema merged'
  )
  const me = await openCero(t, spec)
  t.ok(me.id, 'cero ran fine with no setup')
})

test('cero.use: a setup disposer runs on close', async (t) => {
  let disposed = false
  cero.use(() => () => (disposed = true))
  t.teardown(reset)
  const testnet = await makeTestnet(t)
  const { spec } = await buildSpec(t, 'use-dispose')
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  await me.close()
  t.ok(disposed, 'disposer called on me.close()')
})

test('cero.use: a throwing setup rejects cero() without leaking', async (t) => {
  cero.use(() => {
    throw new Error('boom')
  })
  t.teardown(reset)
  const testnet = await makeTestnet(t)
  const { spec } = await buildSpec(t, 'use-throw')
  await t.exception(cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap }), /boom/)
})

// ─── build: schema merge ────────────────────────────────────────────────────

test('build: app extend + extension extend combine on the same builtin', async (t) => {
  cero.use(profileSync()) // adds members.avatar
  t.teardown(reset)
  const { dir } = await buildSpec(t, 'combine', appExtendSchema)
  const member = await memberType(dir)
  t.ok(
    member.fields.find((f) => f.name === 'tag'),
    'app extend kept'
  )
  t.ok(
    member.fields.find((f) => f.name === 'avatar'),
    'extension extend kept'
  )
})

// ─── cero is schema-agnostic ────────────────────────────────────────────────

test('cero(): works with a spec that has no profile', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'no-profile', noProfileSchema)).spec)
  const room = await open(me.room)
  await put(room.messages, { text: 'ok' })
  const { data } = await get(room.messages)
  t.is(data.length, 1, 'create + write work without a profile')
})

// ─── profileSync ────────────────────────────────────────────────────────────

test('profileSync: declares its own profile when the app has none', async (t) => {
  cero.use(profileSync())
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'ps-byo', roomOnly)).spec)
  t.ok(me.profile, 'profile ref exists — declared by the extension')

  await set(me.profile, { name: 'jb', avatar: 'a.png' })
  const room = await open(me.room)
  const m = await waitUntil(async () => {
    const { data } = await get(room.members, me.identity.id)
    return data?.avatar === 'a.png' ? data : null
  })
  t.is(m.name, 'jb', 'synced from the extension-provided profile')
})

test('profileSync: mirrors profile onto your member row (open + edit)', async (t) => {
  cero.use(profileSync())
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'ps-solo')).spec)

  await set(me.profile, { name: 'jb', avatar: 'a.png' })
  const room = await open(me.room)
  const m1 = await waitUntil(async () => {
    const { data } = await get(room.members, me.identity.id)
    return data?.avatar === 'a.png' ? data : null
  })
  t.is(m1.name, 'jb', 'synced on room open')

  await set(me.profile, { name: 'jbb', avatar: 'b.png' })
  const m2 = await waitUntil(async () => {
    const { data } = await get(room.members, me.identity.id)
    return data?.name === 'jbb' ? data : null
  })
  t.is(m2.avatar, 'b.png', 'edit re-synced')
})

test('profileSync: syncs custom fields', async (t) => {
  cero.use(statusSync)
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'ps-custom', customSchema)).spec)

  await set(me.profile, { name: 'x', status: 'busy' })
  const room = await open(me.room)
  const m = await waitUntil(async () => {
    const { data } = await get(room.members, me.identity.id)
    return data?.status === 'busy' ? data : null
  })
  t.is(m.status, 'busy', 'custom field synced')
})

// an extension that writes on every open grows the log without bound and
// broadcasts to the whole room each time
test('extensions: reopening a handle with an unchanged profile writes zero new ops', async (t) => {
  cero.use(profileSync(), handleSync())
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'ext-noop')).spec)

  await set(me.profile, { name: 'jb', avatar: 'a.png' })
  const room = await open(me.room, { name: 'general' })
  await waitUntil(async () => {
    const { data } = await get(room.members, me.identity.id)
    return data?.avatar === 'a.png' ? data : null
  })
  await waitUntil(async () => {
    const { data } = await get(me.handles, room.id)
    return data?.name ? data : null
  })

  const rootLen = await settled(() => me.store.length)
  const roomLen = room.store.length
  const id = room.id
  await room.close()

  const again = await open(me.room, { id })
  await waitUntil(async () => (await get(again.members, me.identity.id)).data)
  t.is(await settled(() => me.store.length), rootLen, 'handle-sync skipped the unchanged row')
  t.is(again.store.length, roomLen, 'profile-sync skipped the unchanged member row')
})

// wait until a counter stops moving — asserting the ABSENCE of a write needs a
// bounded settle, not a fixed sleep
async function settled(fn, ms = 150) {
  let prev = await fn()
  for (;;) {
    await new Promise((r) => setTimeout(r, ms))
    const next = await fn()
    if (next === prev) return next
    prev = next
  }
}

test('bundled extensions: double registration builds the identical spec', async (t) => {
  const saved = [...cero._registry]
  t.teardown(() => {
    cero._registry.length = 0
    cero._registry.push(...saved)
  })
  cero._registry.length = 0
  cero._registry.push(profileSync(), handleSync())

  const readSchema = async (dir) =>
    JSON.parse(await fs.readFile(join(dir, 'main/schema/schema.json'), 'utf-8'))

  const a = await t.tmp()
  await build(a, base)
  cero.use(profileSync(), handleSync()) // app registers the defaults again
  t.is(cero._registry.length, 2, 'use() replaced by name, no doubling')
  const b = await t.tmp()
  await build(b, base)
  t.alike(await readSchema(a), await readSchema(b), 'spec unchanged by the double use()')

  const c = await t.tmp()
  await build(c, base, { extensions: false })
  const handle = (await readSchema(c)).schema.find((x) => x.name === 'handle')
  t.absent(
    handle.fields.find((f) => f.name === 'avatar'),
    'extensions:false leaves the builtins unextended'
  )
})

test('profileSync: a joiner profile is visible on the host member list', async (t) => {
  cero.use(profileSync())
  t.teardown(reset)
  const { spec } = await buildSpec(t, 'ps-two')
  const { host, joiner } = await openTwo(t, spec)

  const room = await open(host.room)
  const invite = await room.invite({ role: 'member', expiresIn: 60_000 })

  await set(joiner.profile, { name: 'guest', avatar: 'g.png' })
  const joined = await open(joiner.room, invite)
  await waitForConnection(host.network)
  await waitForConnection(joiner.network)
  await waitUntil(() => joined.store.writable)

  const m = await waitUntil(async () => {
    const { data } = await get(room.members, joiner.identity.id)
    return data?.avatar === 'g.png' ? data : null
  })
  t.is(m.name, 'guest', 'joiner name visible to host')
  t.is(m.avatar, 'g.png', 'joiner avatar visible to host')
})

test('profileSync: a room opened before the profile syncs once it is set', async (t) => {
  cero.use(profileSync())
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'ps-late')).spec)

  const room = await open(me.room)
  const { data: before } = await get(room.members, me.identity.id)
  t.absent(before?.avatar, 'no profile yet — member row not populated')

  await set(me.profile, { name: 'jb', avatar: 'a.png' })
  const m = await waitUntil(async () => {
    const { data } = await get(room.members, me.identity.id)
    return data?.avatar === 'a.png' ? data : null
  })
  t.is(m.name, 'jb', 'an already-open room syncs when the profile appears')
})

test('profileSync: a profile set on another device republishes here', async (t) => {
  cero.use(profileSync())
  t.teardown(reset)
  const testnet = await makeTestnet(t)
  const { spec } = await buildSpec(t, 'ps-device')

  const a = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => a.close().catch(() => {}), { order: 5 })
  const room = await open(a.room)

  let b = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  b = await restore(b, a.identity.toPhrase())
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  // the row arrives on a by replication, not through a's own write path
  await set(b.profile, { name: 'jb', avatar: 'b.png' })

  const m = await waitUntil(async () => {
    const { data } = await get(room.members, a.identity.id)
    return data?.avatar === 'b.png' ? data : null
  })
  t.is(m.name, 'jb', "the other device's profile reached this device's rooms")
})

test('profileSync: a profile edit propagates to every open room', async (t) => {
  cero.use(profileSync())
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'ps-multi')).spec)

  const avatarOf = (room, want) =>
    waitUntil(async () => {
      const { data } = await get(room.members, me.identity.id)
      return data?.avatar === want ? data : null
    })

  await set(me.profile, { name: 'jb', avatar: 'a.png' })
  const roomA = await open(me.room)
  const roomB = await open(me.room)
  await avatarOf(roomA, 'a.png')
  await avatarOf(roomB, 'a.png')

  await set(me.profile, { name: 'jb', avatar: 'b.png' })
  const a = await avatarOf(roomA, 'b.png')
  const b = await avatarOf(roomB, 'b.png')
  t.is(a.avatar, 'b.png', 'first room re-synced')
  t.is(b.avatar, 'b.png', 'second room re-synced')
})

// ─── handleSync ─────────────────────────────────────────────────────────

test('handleSync: extends the handle builtin with avatar', async (t) => {
  cero.use(handleSync())
  t.teardown(reset)
  const { dir } = await buildSpec(t, 'his-schema', handleSchema)
  const { schema: types } = JSON.parse(
    await fs.readFile(join(dir, 'main/schema/schema.json'), 'utf-8')
  )
  const handle = types.find((x) => x.name === 'handle')
  t.ok(
    handle.fields.find((f) => f.name === 'avatar'),
    'avatar added to the handle builtin'
  )
})

test('handleSync: mirrors a handle profile onto its handles row', async (t) => {
  cero.use(handleSync())
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'his-solo', handleSchema)).spec)

  const room = await open(me.room)
  await set(room.profile, { name: 'general', avatar: 'pic.png' })

  const row = await waitUntil(async () => {
    const { data } = await get(me.room)
    const r = data.find((h) => h.id === room.id)
    return r?.avatar === 'pic.png' ? r : null
  })
  t.is(row.name, 'general', 'name on the handles row')
  t.is(row.avatar, 'pic.png', 'avatar on the handles row')
})

test('handleSync: a joiner handles row gets named from the handle profile', async (t) => {
  cero.use(handleSync())
  t.teardown(reset)
  const { spec } = await buildSpec(t, 'his-join', handleSchema)
  const { host, joiner } = await openTwo(t, spec)

  const room = await open(host.room)
  await set(room.profile, { name: 'general' })
  const invite = await room.invite({ role: 'member', expiresIn: 60_000 })
  await open(joiner.room, invite)
  await waitForConnection(host.network)
  await waitForConnection(joiner.network)

  const row = await waitUntil(async () => {
    const { data } = await get(joiner.room)
    return data[0]?.name === 'general' ? data[0] : null
  })
  t.is(row.name, 'general', 'joiner sees the handle named — no core waitForProfileName')
})

test('handleSync: a profile wider than the mirrored set still mirrors', async (t) => {
  cero.use(handleStatus)
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'his-wide', handleWideSchema)).spec)

  const room = await open(me.room)
  await set(room.profile, { name: 'general', status: 'open', motto: 'be kind' })

  const row = await waitUntil(async () => {
    const { data } = await get(me.room)
    const r = data.find((h) => h.id === room.id)
    return r?.status === 'open' ? r : null
  })
  t.is(row.name, 'general', 'name mirrored')
  t.is(row.status, 'open', 'declared field mirrored')
  t.absent(row.motto, 'undeclared field not pushed onto the row')
})

test('handleSync: a handle without a profile is left untouched', async (t) => {
  cero.use(handleSync())
  t.teardown(reset)
  // `base.room` declares no profile — there is nothing to mirror.
  const me = await openCero(t, (await buildSpec(t, 'his-no-profile')).spec)

  const room = await open(me.room, { name: 'general' })
  await put(room.messages, { text: 'ok' })

  const row = await waitUntil(async () => {
    const { data } = await get(me.room)
    return data.find((h) => h.id === room.id) || null
  })
  t.absent(row.avatar, 'extension never wrote — handle has no profile')
})

test('handleSync: seeds the handle name from the open name', async (t) => {
  cero.use(handleSync())
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'his-seed', handleSchema)).spec)

  const room = await open(me.room, { name: 'general' })
  const row = await waitUntil(async () => {
    const { data } = await get(me.room)
    const r = data.find((h) => h.id === room.id)
    return r?.name === 'general' ? r : null
  })
  t.is(row.name, 'general', 'handles row seeded from the open name')
  t.is(room.name, 'general', 'in-memory handle name set too')
})

test('handleSync: an avatar edit re-syncs onto the handles row', async (t) => {
  cero.use(handleSync())
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'his-avatar', handleSchema)).spec)

  const room = await open(me.room)
  const avatarOf = (want) =>
    waitUntil(async () => {
      const { data } = await get(me.room)
      const r = data.find((h) => h.id === room.id)
      return r?.avatar === want ? r : null
    })

  await set(room.profile, { name: 'general', avatar: 'a.png' })
  await avatarOf('a.png')

  await set(room.profile, { name: 'general', avatar: 'b.png' })
  const row = await avatarOf('b.png')
  t.is(row.avatar, 'b.png', 'edit re-synced to the handles row')
})

// SKIP: blocked by an upstream autobee 1.0.9 bug. Two handles syncing their
// profile names fire two concurrent local appends to `me.handles`, which under a
// live swarm strands one in autobee's apply pipeline (the view never converges).
// Minimal repro filed against autobee (test/concurrent-append-crash.js). Re-enable
// once autobee ships a fix.
test.skip('handleSync: multiple handles are named independently', async (t) => {
  cero.use(handleSync())
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'his-many', handleSchema)).spec)

  const roomA = await open(me.room)
  const roomB = await open(me.room)
  await set(roomA.profile, { name: 'alpha' })
  await set(roomB.profile, { name: 'beta' })

  const named = await waitUntil(async () => {
    const { data } = await get(me.room)
    const a = data.find((h) => h.id === roomA.id)
    const b = data.find((h) => h.id === roomB.id)
    return a?.name === 'alpha' && b?.name === 'beta' ? { a, b } : null
  })
  t.is(named.a.name, 'alpha')
  t.is(named.b.name, 'beta')
})

test('handleSync: syncs custom fields', async (t) => {
  cero.use(handleStatus)
  t.teardown(reset)
  const me = await openCero(t, (await buildSpec(t, 'his-custom', handleStatusSchema)).spec)

  const room = await open(me.room)
  await set(room.profile, { name: 'general', status: 'open' })

  const row = await waitUntil(async () => {
    const { data } = await get(me.room)
    const r = data.find((h) => h.id === room.id)
    return r?.status === 'open' ? r : null
  })
  t.is(row.name, 'general', 'name still synced')
  t.is(row.status, 'open', 'custom field synced to the handles row')
})

// ─── disposers ──────────────────────────────────────────────────────────────

async function openManual(t, spec) {
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return me
}

test('profileSync: detaches its handle listener on close', async (t) => {
  cero.use(profileSync())
  t.teardown(reset)
  const me = await openManual(t, (await buildSpec(t, 'ps-dispose')).spec)
  t.is(me.listenerCount('handle'), 1, 'extension registered its handle listener')
  await me.close()
  t.is(me.listenerCount('handle'), 0, 'listener detached on close (via me.signal)')
})

test('handleSync: detaches its handle listener on close', async (t) => {
  cero.use(handleSync())
  t.teardown(reset)
  const me = await openManual(t, (await buildSpec(t, 'his-dispose', handleSchema)).spec)
  t.is(me.listenerCount('handle'), 1, 'extension registered its handle listener')
  await me.close()
  t.is(me.listenerCount('handle'), 0, 'listener detached on close (via me.signal)')
})

// ─── watch ownership: auto-cleanup on close ──────────────────────────────────

test('watch: a data-ref stream is destroyed when its handle closes', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'own-data')).spec)
  const stream = watch(me.notes)
  t.absent(stream.destroyed, 'live before close')
  await me.close()
  t.ok(await waitUntil(() => stream.destroyed), 'destroyed on close — no manual cleanup')
})

test('watch: a handle-ref stream is destroyed when its handle closes', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'own-handle')).spec)
  const stream = watch(me.room)
  t.absent(stream.destroyed)
  await me.close()
  t.ok(await waitUntil(() => stream.destroyed), 'handle-list watch cleaned on close')
})

test('watch: a child stream dies with the child, not the root', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'own-child')).spec)
  const room = await open(me.room)
  const stream = watch(room.messages)
  t.absent(stream.destroyed)
  await room.close()
  t.ok(await waitUntil(() => stream.destroyed), 'child watch destroyed on child close')
})

test('watch: closing the root cascades and destroys child streams', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'own-cascade')).spec)
  const room = await open(me.room)
  const stream = watch(room.messages)
  await me.close()
  t.ok(await waitUntil(() => stream.destroyed), 'root close → child close → watch destroyed')
})

test('watch: destroying manually de-registers — close does not double-destroy', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'own-manual')).spec)
  const stream = watch(me.notes)
  stream.destroy()
  await waitUntil(() => stream.destroyed)
  t.is(me._owned.size, 0, 'manual destroy removed it from the owned set')
  await me.close()
  t.pass('manual destroy then close is safe')
})

test('watch: open/close churn does not accumulate owned streams', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'own-churn')).spec)
  const streams = []
  for (let i = 0; i < 20; i++) {
    const room = await open(me.room)
    streams.push(watch(room.messages))
    await room.close()
  }
  t.ok(
    await waitUntil(() => streams.every((s) => s.destroyed)),
    'every child watch destroyed on its own close'
  )
  t.is(me._owned.size, 0, 'root owns nothing — no per-room leak')
})

test('own(): ties an arbitrary destroyable to the handle close', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'own-custom')).spec)
  let destroyed = false
  me.own({ destroy: () => (destroyed = true) })
  await me.close()
  t.ok(destroyed, 'own() destroyed the resource on close')
})

test('own(): destroys immediately when the handle is already closed', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'own-late')).spec)
  await me.close()
  let destroyed = false
  me.own({ destroy: () => (destroyed = true) })
  t.ok(destroyed, 'own() after close destroys right away')
})

// ─── signal: scope-bound cleanup ─────────────────────────────────────────────

test('signal: me.signal aborts when the handle closes', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'sig-close')).spec)
  const { signal } = me
  t.absent(signal.aborted, 'live before close')
  await me.close()
  t.ok(signal.aborted, 'aborted on close')
})

test('signal: me.signal works without a global AbortController (Bare)', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'sig-bare')).spec)
  const saved = globalThis.AbortController
  delete globalThis.AbortController
  let signal
  try {
    signal = me.signal // a ReferenceError here before cero imported bare-abort-controller
  } finally {
    globalThis.AbortController = saved
  }
  t.ok(signal && typeof signal.addEventListener === 'function', 'built without the global')
  t.absent(signal.aborted, 'live before close')
  await me.close()
  t.ok(signal.aborted, 'aborts on close')
})

test('signal: on(event, fn, { signal }) removes the listener on abort', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'sig-on')).spec)
  const ctrl = new AbortController()
  let hits = 0
  me.on('handle', () => hits++, { signal: ctrl.signal })

  await open(me.room)
  t.is(hits, 1, 'fires while subscribed')
  ctrl.abort()
  await open(me.room)
  t.is(hits, 1, 'no longer fires after abort')
})

test('signal: on(event, fn, { signal: me.signal }) is removed on close', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'sig-on-close')).spec)
  me.on('handle', () => {}, { signal: me.signal })
  t.is(me.listenerCount('handle'), 1)
  await me.close()
  t.is(me.listenerCount('handle'), 0, 'removed when me closes')
})

test('signal: after(ref, fn, { signal }) stops firing on abort', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'sig-after')).spec)
  const ctrl = new AbortController()
  let hits = 0
  after(me.profile, () => hits++, { signal: ctrl.signal })

  await set(me.profile, { name: 'a' })
  t.is(hits, 2)
  ctrl.abort()
  await set(me.profile, { name: 'b' })
  t.is(hits, 2, 'unsubscribed on abort')
})

test('signal: before(ref, fn, { signal }) stops refusing on abort', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'sig-before')).spec)
  const ctrl = new AbortController()
  before(me.notes, (c) => (c.row.text === 'no' ? false : undefined), { signal: ctrl.signal })

  await t.exception(() => put(me.notes, { text: 'no' }), /refused by hook/)
  let { data } = await get(me.notes)
  t.is(data.length, 0, 'rule active')

  ctrl.abort()
  await put(me.notes, { text: 'no' })
  ;({ data } = await get(me.notes))
  t.is(data.length, 1, 'rule removed on abort')
})

test('signal: watch(ref, q, { signal }) destroys on abort without closing the handle', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'sig-watch')).spec)
  const ctrl = new AbortController()
  const stream = watch(me.notes, null, { signal: ctrl.signal })
  t.absent(stream.destroyed)

  ctrl.abort()
  t.ok(
    await waitUntil(() => stream.destroyed),
    'destroyed on abort — the long-lived handle stays open'
  )
  t.absent(me.closed, 'handle stayed open')
})

test('signal: an already-aborted signal cleans up immediately', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'sig-pre')).spec)
  const ctrl = new AbortController()
  ctrl.abort()
  const stream = watch(me.notes, null, { signal: ctrl.signal })
  t.ok(await waitUntil(() => stream.destroyed), 'destroyed right away')
})

test('signal: a pre-aborted signal tears down on/after/before immediately', async (t) => {
  const me = await openManual(t, (await buildSpec(t, 'sig-pre-ops')).spec)
  const ctrl = new AbortController()
  ctrl.abort()

  me.on('handle', () => t.fail('on listener fired'), { signal: ctrl.signal })
  t.is(me.listenerCount('handle'), 0, 'on() detached immediately')
  await open(me.room)
  t.is(me.listenerCount('handle'), 0, 'still detached after an event')

  after(me.profile, () => t.fail('after fired'), { signal: ctrl.signal })
  await set(me.profile, { name: 'x' })
  t.pass('after never fired')

  before(me.notes, () => false, { signal: ctrl.signal })
  await put(me.notes, { text: 'kept' })
  const { data } = await get(me.notes)
  t.is(data.length, 1, 'before rule never applied')
})
