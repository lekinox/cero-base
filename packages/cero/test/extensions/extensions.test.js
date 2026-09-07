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
import { profileSync, handleSync, bind } from '../../src/extensions/index.js'
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

// the list a build names; tests hand it to the spec the way a named module would
async function buildSpec(t, sub, sch = base, exts = []) {
  const dir = join(buildRoot, sub)
  await fs.rm(dir, { recursive: true, force: true })
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await build(dir, sch, { extensions: exts })
  const { spec } = await import(pathToFileURL(join(dir, 'index.js')).href)
  spec.extensions = exts
  return { spec, dir }
}

async function openCero(t, spec, opts = {}) {
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap, ...opts })
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

// ─── extensions: the list a build names ─────────────────────────────────────

// an extension nests by handle type like the app schema; operators are their own map
const notes = {
  schema: { room: { todos: t.collection({ text: t.string }) } },
  setup: (me) => before(me.room.todos, ({ row }) => !!row.text.trim())
}
const noteOps = {
  room: {
    note: {
      add: (room, text) => put(room.todos, { text }),
      list: (room) => get(room.todos)
    }
  }
}

test('extensions: a nested schema folds into the handle type', async (t) => {
  const { spec } = await buildSpec(t, 'ext-scope', base, [notes])
  t.ok(spec.handles.room.meta.refs.todos, 'todos landed on room')
  t.absent(spec.meta.refs.todos, 'not on the root')
  t.ok(spec.handles.room.meta.refs.messages, 'the app refs on room survived')
})

test('operators: nested operators bind on the type, a type hook guards every room', async (t) => {
  const { spec } = await buildSpec(t, 'ext-feature', base, [notes])
  const me = await openCero(t, spec, { operators: noteOps })
  t.absent(me.note, 'nothing on the root')
  const room = await open(me.room, { name: 'r' })
  await room.note.add('kept')
  await t.exception(room.note.add('   '), /REFUSED/, 'the setup hook refused the blank one')
  t.alike(
    (await room.note.list()).data.map((r) => r.text),
    ['kept']
  )
})

test('hooks: a hook on a type ref covers rooms already open, and off() lifts it', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'type-hook-late', base, [notes])).spec)
  const room = await open(me.room, { name: 'early' })
  const off = before(me.room.messages, ({ row }) => row.text !== 'nope')
  await t.exception(put(room.messages, { text: 'nope' }), /REFUSED/, 'the open room got the hook')
  const later = await open(me.room, { name: 'later' })
  await t.exception(put(later.messages, { text: 'nope' }), /REFUSED/, 'so did the next one')
  off()
  t.ok((await put(room.messages, { text: 'nope' })).data, 'lifted on the open room')
  t.ok((await put(later.messages, { text: 'nope' })).data, 'and on the later one')
})

test('extensions: a module named at build time reaches the runtime through the spec', async (t) => {
  const dir = join(buildRoot, 'ext-module')
  await fs.rm(dir, { recursive: true, force: true })
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.mkdir(dir, { recursive: true })
  const src = pathToFileURL(join(here, '..', '..', 'src', 'extensions', 'index.js')).href
  await fs.writeFile(
    join(dir, 'ext.js'),
    `import { t } from '${src}'
export let ran = 0
export const extensions = [
  { schema: { room: { todos: t.collection({ text: t.string }) } }, setup() { ran++ } }
]
`
  )
  await fs.writeFile(
    join(dir, 'ops.js'),
    `import { put } from '${src}'
export const operators = {
  user: { hello: (h) => h.id },
  room: { note: { add: (room, text) => put(room.todos, { text }) } }
}
`
  )
  await build(join(dir, 'spec'), base, { extensions: '../ext.js', operators: '../ops.js' })
  const { spec } = await import(pathToFileURL(join(dir, 'spec', 'index.js')).href)
  const mod = await import(pathToFileURL(join(dir, 'ext.js')).href)
  const ops = await import(pathToFileURL(join(dir, 'ops.js')).href)
  t.is(spec.extensions, mod.extensions, 'the spec imports the extensions it was built from')
  t.is(spec.operators, ops.operators, 'and the operators it was told about')
  t.ok(spec.handles.room.meta.refs.todos, 'and folded its schema')
  const types = JSON.parse(await fs.readFile(join(dir, 'spec/main/schema/schema.json'), 'utf-8'))
  const handle = types.schema.find((x) => x.name === 'handle')
  t.absent(
    handle.fields.find((f) => f.name === 'avatar'),
    'a named list leaves the bundled two out'
  )

  const me = await openCero(t, spec)
  t.is(mod.ran, 1, 'setup ran with nothing registered')
  t.is(me.user.hello(), me.id, 'the operators export bound on the root')
  const room = await open(me.room, { name: 'r' })
  await room.note.add('through the spec')
  t.is((await get(room.todos)).data[0].text, 'through the spec')
})

test('operators: naming operators alone keeps the bundled two', async (t) => {
  const dir = join(buildRoot, 'ops-only')
  await fs.rm(dir, { recursive: true, force: true })
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'ops.js'), 'export const operators = { user: { hi: () => 1 } }\n')
  await build(join(dir, 'spec'), base, { operators: '../ops.js' })
  const schema = JSON.parse(await fs.readFile(join(dir, 'spec/main/schema/schema.json'), 'utf-8'))
  const handle = schema.schema.find((x) => x.name === 'handle')
  t.ok(
    handle.fields.find((f) => f.name === 'avatar'),
    'handleSync still folded'
  )
  const { spec } = await import(pathToFileURL(join(dir, 'spec', 'index.js')).href)
  const me = await openCero(t, spec)
  t.is(me.user.hi(), 1)
})

test('operators: keyed by namespace, a handle-type key holds its namespaces', (t) => {
  const calls = []
  const operators = {
    user: { rename: (h, name) => calls.push(['user.rename', h.tag, name]) },
    team: { note: { add: (h, text) => calls.push(['team.note.add', h.tag, text]) } }
  }
  const root = { tag: 'root', spec: { meta: { handles: { team: {} } } } }
  bind(root, null, operators)
  t.is(typeof root.user.rename, 'function')
  t.absent(root.team, 'a handle-type key is not a root namespace')
  const child = { tag: 'child' }
  bind(child, 'team', operators)
  t.is(typeof child.note.add, 'function')
  root.user.rename('Z')
  child.note.add('hi')
  t.alike(calls, [
    ['user.rename', 'root', 'Z'],
    ['team.note.add', 'child', 'hi']
  ])
})

test('bind: curries the handle as arg 0, returns it, skips non-functions', (t) => {
  const handle = { tag: 'h' }
  const seen = []
  const out = bind(handle, null, { guest: { create: (h, d) => seen.push([h.tag, d]), NOPE: 5 } })
  t.is(out, handle)
  t.is(handle.guest.NOPE, undefined)
  handle.guest.create({ x: 1 })
  t.alike(seen, [['h', { x: 1 }]])
})

test('extensions: an object runs its setup with the ready handle', async (t) => {
  let captured = null
  const exts = [{ setup: (me) => (captured = me) }]
  const me = await openCero(t, (await buildSpec(t, 'ext-obj', base, exts)).spec)
  t.is(captured, me)
})

test('extensions: a bare function is shorthand for { setup }', async (t) => {
  let captured = null
  const exts = [(me) => (captured = me)]
  const me = await openCero(t, (await buildSpec(t, 'ext-fn', base, exts)).spec)
  t.is(captured, me)
})

test('extensions: every setup in the list runs', async (t) => {
  const ran = []
  const exts = [() => ran.push('a'), () => ran.push('b'), () => ran.push('c')]
  await openCero(t, (await buildSpec(t, 'ext-multi', base, exts)).spec)
  t.alike(ran.sort(), ['a', 'b', 'c'])
})

test('extensions: the instance list replaces the one the spec carries', async (t) => {
  const ran = []
  const { spec } = await buildSpec(t, 'ext-override', base, [() => ran.push('spec')])
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), spec, {
    bootstrap: testnet.bootstrap,
    extensions: [() => ran.push('instance')]
  })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.alike(ran, ['instance'])
})

test('extensions: a schema-only extension merges and runs without a setup', async (t) => {
  const { spec, dir } = await buildSpec(t, 'ext-schema-only', base, [tagExtension])
  t.ok(
    (await memberType(dir)).fields.find((f) => f.name === 'tag'),
    'schema merged'
  )
  const me = await openCero(t, spec)
  t.ok(me.id, 'cero ran fine with no setup')
})

test('extensions: a setup disposer runs on close', async (t) => {
  let disposed = false
  const exts = [() => () => (disposed = true)]
  const testnet = await makeTestnet(t)
  const { spec } = await buildSpec(t, 'ext-dispose', base, exts)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  await me.close()
  t.ok(disposed, 'disposer called on me.close()')
})

test('extensions: a throwing setup rejects cero() without leaking', async (t) => {
  const exts = [
    () => {
      throw new Error('boom')
    }
  ]
  const testnet = await makeTestnet(t)
  const { spec } = await buildSpec(t, 'ext-throw', base, exts)
  await t.exception(cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap }), /boom/)
})

// ─── build: schema merge ────────────────────────────────────────────────────

test('build: app extend + extension extend combine on the same builtin', async (t) => {
  const exts = [profileSync()]
  const { dir } = await buildSpec(t, 'combine', appExtendSchema, exts)
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
  const exts = [profileSync()]
  const me = await openCero(t, (await buildSpec(t, 'ps-byo', roomOnly, exts)).spec)
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
  const exts = [profileSync()]
  const me = await openCero(t, (await buildSpec(t, 'ps-solo', base, exts)).spec)

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
  const exts = [statusSync]
  const me = await openCero(t, (await buildSpec(t, 'ps-custom', customSchema, exts)).spec)

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
  const exts = [profileSync(), handleSync()]
  const me = await openCero(t, (await buildSpec(t, 'ext-noop', base, exts)).spec)

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

test('bundled extensions: the default build equals naming the two by hand', async (t) => {
  const readSchema = async (dir) =>
    JSON.parse(await fs.readFile(join(dir, 'main/schema/schema.json'), 'utf-8'))

  const a = await t.tmp()
  await build(a, base)
  const b = await t.tmp()
  await build(b, base, { extensions: [profileSync(), handleSync()] })
  t.alike(await readSchema(a), await readSchema(b), 'same spec')

  const c = await t.tmp()
  await build(c, base, { extensions: [] })
  const handle = (await readSchema(c)).schema.find((x) => x.name === 'handle')
  t.absent(
    handle.fields.find((f) => f.name === 'avatar'),
    'an empty list leaves the builtins unextended'
  )
})

test('profileSync: a joiner profile is visible on the host member list', async (t) => {
  const exts = [profileSync()]
  const { spec } = await buildSpec(t, 'ps-two', base, exts)
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
  const exts = [profileSync()]
  const me = await openCero(t, (await buildSpec(t, 'ps-late', base, exts)).spec)

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
  const exts = [profileSync()]
  const testnet = await makeTestnet(t)
  const { spec } = await buildSpec(t, 'ps-device', base, exts)

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
  const exts = [profileSync()]
  const me = await openCero(t, (await buildSpec(t, 'ps-multi', base, exts)).spec)

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
  const exts = [handleSync()]
  const { dir } = await buildSpec(t, 'his-schema', handleSchema, exts)
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
  const exts = [handleSync()]
  const me = await openCero(t, (await buildSpec(t, 'his-solo', handleSchema, exts)).spec)

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
  const exts = [handleSync()]
  const { spec } = await buildSpec(t, 'his-join', handleSchema, exts)
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
  const exts = [handleStatus]
  const me = await openCero(t, (await buildSpec(t, 'his-wide', handleWideSchema, exts)).spec)

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
  const exts = [handleSync()]
  // `base.room` declares no profile — there is nothing to mirror.
  const me = await openCero(t, (await buildSpec(t, 'his-no-profile', base, exts)).spec)

  const room = await open(me.room, { name: 'general' })
  await put(room.messages, { text: 'ok' })

  const row = await waitUntil(async () => {
    const { data } = await get(me.room)
    return data.find((h) => h.id === room.id) || null
  })
  t.absent(row.avatar, 'extension never wrote — handle has no profile')
})

test('handleSync: seeds the handle name from the open name', async (t) => {
  const exts = [handleSync()]
  const me = await openCero(t, (await buildSpec(t, 'his-seed', handleSchema, exts)).spec)

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
  const exts = [handleSync()]
  const me = await openCero(t, (await buildSpec(t, 'his-avatar', handleSchema, exts)).spec)

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
  const exts = [handleSync()]
  const me = await openCero(t, (await buildSpec(t, 'his-many', handleSchema, exts)).spec)

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
  const exts = [handleStatus]
  const me = await openCero(t, (await buildSpec(t, 'his-custom', handleStatusSchema, exts)).spec)

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
  const exts = [profileSync()]
  const me = await openManual(t, (await buildSpec(t, 'ps-dispose', base, exts)).spec)
  t.is(me.listenerCount('handle'), 1, 'extension registered its handle listener')
  await me.close()
  t.is(me.listenerCount('handle'), 0, 'listener detached on close (via me.signal)')
})

test('handleSync: detaches its handle listener on close', async (t) => {
  const exts = [handleSync()]
  const me = await openManual(t, (await buildSpec(t, 'his-dispose', handleSchema, exts)).spec)
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
