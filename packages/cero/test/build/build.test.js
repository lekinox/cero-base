import test from 'brittle'
import process from 'process'
import { Duplex } from 'streamx'
import { promises as fs, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import { cero, put, set, get, open, schema, t } from '../../src/index.js'
import { build } from '../../src/build/index.js'
import { reserved as worker } from '../../src/handle/index.js'
import { Ref } from '../../src/lib/refs.js'
import { serve } from '../../src/rpc/server.js'
import { connect, reserved as ui } from '../../src/rpc/client.js'
import { bundled } from '../../src/extensions/index.js'
import { fields } from '../../src/build/internal.js'
import { rpc, contract } from '../../src/build/schemas.js'
import { makeTestnet } from '../helpers/index.js'

test.configure({ timeout: 60000 })

const here = dirname(fileURLToPath(import.meta.url))
const buildRoot = join(here, '..', 'fixtures', '.build-output')
process.on('exit', () => rmSync(buildRoot, { recursive: true, force: true }))

const fixture = schema({
  profile: t.single({ name: t.string, avatar: t.bytes }),
  messages: t.collection({ text: t.string }),
  team: {
    messages: t.collection({ text: t.string }),
    promote: t.action({ memberId: t.string, role: t.string })
  },
  local: {
    drafts: t.collection({ text: t.string })
  }
})

const extendFixture = schema({
  profile: t.single({ name: t.string }),
  members: t.extend({ alias: t.required(t.string) })
})
const takenSchema = schema({ team: { status: t.collection({ text: t.string }) } })
const collisionSchema = schema({ members: t.extend({ name: t.string }) })
const nonBuiltinSchema = schema({ widgets: t.extend({ x: t.string }) })
const idxSchema = schema({
  guests: t.collection({ name: t.string }, { indexes: { 'by-name': ['name'] } })
})

async function buildInto(t, sub, sch = fixture) {
  const specDir = join(buildRoot, sub)
  await fs.rm(specDir, { recursive: true, force: true })
  t.teardown(() => fs.rm(specDir, { recursive: true, force: true }))
  await build(specDir, sch)
  return specDir
}

function pair() {
  let a, b
  a = new Duplex({ write: (data, cb) => (b.push(data), cb(null)) })
  b = new Duplex({ write: (data, cb) => (a.push(data), cb(null)) })
  return [a, b]
}

async function importSpec(specDir) {
  const url = pathToFileURL(join(specDir, 'index.js')).href
  return import(url)
}

// ─── output structure ─────────────────────────────────────────────────────

test('build: emits the expected files', async (t) => {
  const specDir = await buildInto(t, 'structure')
  for (const p of [
    'index.js',
    'main/db/index.js',
    'main/dispatch/index.js',
    'main/schema/index.js',
    'main/rpc/index.js',
    'local/db/index.js',
    'local/schema/index.js',
    'handles/team/db/index.js',
    'handles/team/dispatch/index.js',
    'handles/team/schema/index.js'
  ]) {
    await fs.access(join(specDir, p))
    t.pass(p)
  }
})

// ─── meta shape ───────────────────────────────────────────────────────────

test('build: meta records user + builtin refs', async (t) => {
  const specDir = await buildInto(t, 'meta')
  const { meta } = await importSpec(specDir)
  t.is(meta.ns, 'cero')
  t.is(meta.refs.profile.kind, 'single')
  t.is(meta.refs.messages.kind, 'collection')
  t.is(meta.refs.team.kind, 'handle')
  t.is(meta.refs.members.internal, true)
  t.is(meta.local.refs.drafts.kind, 'collection')
  t.is(meta.handles.team.refs.messages.kind, 'collection')
  t.is(meta.handles.team.refs.promote.kind, 'action')
})

test('build: t.collection indexes register on the ref + in the hyperdb spec', async (t) => {
  const specDir = await buildInto(t, 'indexes', idxSchema)
  const { meta } = await importSpec(specDir)
  t.alike(meta.refs.guests.indexes, { 'by-name': ['name'] }, 'index recorded on the collection ref')
  const db = await fs.readFile(join(specDir, 'main/db/index.js'), 'utf-8')
  t.ok(db.includes('guests-by-name'), 'index registered in the generated hyperdb spec')
})

// ─── t.extend + t.required ─────────────────────────────────────────────────

test('build: t.extend merges a required field into a builtin', async (t) => {
  const specDir = await buildInto(t, 'extend', extendFixture)
  const { schema: types } = JSON.parse(
    await fs.readFile(join(specDir, 'main/schema/schema.json'), 'utf-8')
  )
  const member = types.find((x) => x.name === 'member')
  const alias = member.fields.find((f) => f.name === 'alias')
  t.ok(alias, 't.extend merged the field onto the member type')
  t.is(alias.type, 'string')
  t.is(alias.required, true, 't.required produced a required field')
})

test('build: t.extend cannot redeclare a base field', async (t) => {
  const dir = join(buildRoot, 'collision')
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await t.exception.all(() => build(dir, collisionSchema), /base field/)
})

test('build: status and joins are computed builtins an app cannot declare', async (t) => {
  const specDir = await buildInto(t, 'live')
  const { meta } = await importSpec(specDir)
  t.is(meta.refs.status.kind, 'single')
  t.is(meta.refs.joins.kind, 'collection', 'the root lists its joins')
  t.is(meta.handles.team.refs.status.kind, 'single')
  t.absent(meta.handles.team.refs.joins, 'a room has none')

  const dir = join(buildRoot, 'live-taken')
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await t.exception.all(() => build(dir, takenSchema), /'status' is a builtin/)
})

async function refused(t, sub, sch, message) {
  const dir = join(buildRoot, sub)
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await t.exception.all(() => build(dir, sch, { extensions: [] }), message)
}

test('build: a collection field named like one Cero writes on every row is refused', async (a) => {
  // a shipped app had updatedAt twice: the next build threw or moved a field
  const reports = t.collection({ score: t.uint, updatedAt: t.uint, by: t.string })
  await refused(a, 'base-handle', schema({ group: { reports } }), /'updatedAt' in 'reports'/)
  const notes = t.collection({ id: t.string, text: t.string })
  await refused(a, 'base-root', schema({ notes }), /'id' in 'notes'/)
  const drafts = t.collection({ index: t.string })
  await refused(a, 'base-local', schema({ local: { drafts } }), /'index' in 'drafts'/)
})

test('build: a single keeps any field name, it has none of Cero', async (a) => {
  const settings = t.single({ id: t.string, index: t.uint, updatedAt: t.int })
  const specDir = await buildInto(a, 'base-single', schema({ settings }))
  const { meta } = await importSpec(specDir)
  a.alike(meta.refs.settings.fields, ['id', 'index', 'updatedAt'])
})

test('build: an app ref named like a builtin ref of its scope is refused', async (a) => {
  const text = t.collection({ text: t.string })
  await refused(a, 'ref-root', schema({ members: text }), /'members' is a builtin ref/)
  await refused(a, 'ref-handle', schema({ room: { devices: text } }), /'devices' is a builtin/)
  await refused(a, 'ref-type', schema({ members: { notes: text } }), /'members' is a builtin/)
  await refused(a, 'ref-epochs', schema({ epochs: text }), /'epochs' is a builtin ref/)
  await refused(a, 'ref-local', schema({ local: { topics: text } }), /'topics' is a builtin/)
  const device = t.single({ theme: t.string })
  await refused(a, 'ref-local-single', schema({ local: { device } }), /'device' is a builtin/)
})

test('build: a name only the root computes is free in a handle type', async (a) => {
  const text = t.collection({ text: t.string })
  const specDir = await buildInto(a, 'ref-free', schema({ room: { topics: text, nearby: text } }))
  const { meta } = await importSpec(specDir)
  a.is(meta.handles.room.refs.topics.kind, 'collection')
  a.is(meta.handles.room.refs.nearby.kind, 'collection')
})

test('build: an app ref named like a builtin type is refused', async (a) => {
  const text = t.collection({ text: t.string })
  await refused(a, 'type-counter', schema({ counter: text }), /'counter' is a builtin type/)
  const peer = t.single({ name: t.string })
  await refused(a, 'type-peer', schema({ room: { peer } }), /'peer' is a builtin type/)
  await refused(a, 'type-rpc', schema({ 'res-data': text }), /'res-data' is a builtin type/)
  await refused(a, 'type-local', schema({ local: { mail: text } }), /'mail' is a builtin type/)
})

test('build: an app ref that makes one of Cero routes is refused', async (a) => {
  // the same fields as Cero's accept: it built, shared the route, and replaced its handler
  const accept = t.action({ id: t.required(t.string), role: t.string, proof: t.bytes })
  await refused(a, 'route-accept', schema({ accept }), /'accept' makes Cero's route 'accept'/)
  const join = t.action({ code: t.string })
  await refused(a, 'route-join', schema({ room: { join } }), /'join' makes Cero's route 'join'/)
  const refusal = t.collection({ text: t.string })
  await refused(
    a,
    'route-refusal',
    schema({ refusal }),
    /'refusal' makes Cero's route 'del-refusal'/
  )
  const rotate = t.action({ x: t.string })
  await refused(
    a,
    'route-rotate',
    schema({ 'rotate-key': rotate }),
    /makes Cero's route 'rotate-key'/
  )
})

test('build: an action named near a route of Cero builds', async (a) => {
  const specDir = await buildInto(a, 'route-free', schema({ accepted: t.action({ id: t.string }) }))
  const { meta } = await importSpec(specDir)
  a.is(meta.refs.accepted.kind, 'action')
})

test('build: a handle name that is not an identifier is refused', async (a) => {
  const room = { notes: t.collection({ text: t.string }) }
  await refused(
    a,
    'shape-hyphen',
    schema({ 'chat-room': room }),
    /'chat-room' is not a handle name/
  )
  await refused(a, 'shape-upper', schema({ Room: room }), /'Room' is not a handle name/)
})

test('build: a camel-case handle name builds and imports', async (a) => {
  const room = { notes: t.collection({ text: t.string }) }
  const specDir = await buildInto(a, 'shape-camel', schema({ chatRoom2: room }))
  const { spec } = await importSpec(specDir)
  a.ok(spec.handles.chatRoom2.database, 'the generated module imports')
})

test('build: a ref named like a member of the handle or the client is refused', async (a) => {
  const text = t.collection({ text: t.string })
  // the worker opened it and the UI threw on connect
  await refused(a, 'member-ui', schema({ watch: text }), /'watch' is taken by the handle/)
  await refused(a, 'member-worker', schema({ signal: text }), /'signal' is taken by the handle/)
  await refused(a, 'member-child', schema({ room: { name: text } }), /'name' is taken/)
  await refused(a, 'member-local', schema({ local: { schemaOf: text } }), /'schemaOf' is taken/)
  await refused(a, 'member-private', schema({ _pair: text }), /'_pair' is taken/)
  await refused(a, 'member-handle', schema({ store: { notes: text } }), /'store' is taken/)
})

test('build: the members the build refuses cover every field a handle and a client carry', async (a) => {
  const specDir = await buildInto(a, 'members')
  const { spec } = await importSpec(specDir)
  const testnet = await makeTestnet(a)
  const me = await cero(await a.tmp(), spec, { bootstrap: testnet.bootstrap })
  a.teardown(() => me.close().catch(() => {}), { order: 5 })
  const [up, down] = pair()
  const server = await serve(up, spec, { storage: await a.tmp(), bootstrap: testnet.bootstrap })
  a.teardown(() => server.close().catch(() => {}), { order: 4 })
  const client = await connect(down, spec)
  a.teardown(() => client.close().catch(() => {}), { order: 3 })

  // a private field is refused by its leading _, every other one by name
  const fields = (o) => Object.keys(o).filter((k) => !k.startsWith('_') && !(o[k] instanceof Ref))
  for (const o of [me, await open(me.team), me.local]) {
    a.alike(
      fields(o).filter((k) => !worker.includes(k)),
      [],
      `worker ${o.constructor.name}`
    )
  }
  for (const o of [client, await open(client.team), client.local]) {
    a.alike(
      fields(o).filter((k) => !ui.includes(k)),
      [],
      `client ${o.constructor.name}`
    )
  }
})

test('build: a schema with names near the reserved ones builds and opens', async (a) => {
  const near = schema({
    notes: t.collection({ title: t.string, memberIds: t.string, created: t.int }),
    watched: t.collection({ text: t.string }),
    acceptAll: t.action({ id: t.string }),
    room: { profile: t.single({ name: t.string }), files2: t.collection({ text: t.string }) },
    local: { devices: t.collection({ name: t.string }) }
  })
  const specDir = await buildInto(a, 'near', near)
  const { spec } = await importSpec(specDir)
  const testnet = await makeTestnet(a)
  const me = await cero(await a.tmp(), spec, { bootstrap: testnet.bootstrap })
  a.teardown(() => me.close().catch(() => {}), { order: 5 })
  const { data } = await put(me.notes, { title: 'a', memberIds: 'x', created: 1 })
  a.is(data.title, 'a')
  const room = await open(me.room)
  await put(room.files2, { text: 'b' })
  a.is((await get(room.files2)).data.length, 1)
})

test('build: t.extend on a non-builtin throws', async (t) => {
  const dir = join(buildRoot, 'not-builtin')
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await t.exception.all(() => build(dir, nonBuiltinSchema), /extendable builtin/)
})

// ─── usable with cero() ───────────────────────────────────────────────────

test('build: built spec is usable end-to-end with cero()', async (t) => {
  const specDir = await buildInto(t, 'usable')
  const { spec } = await importSpec(specDir)

  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })

  await set(me.profile, { name: 'jb' })
  const { data: prof } = await get(me.profile)
  t.is(prof.name, 'jb')

  const { data: row } = await put(me.messages, { text: 'built spec works' })
  t.ok(row.id)

  await put(me.local.drafts, { text: 'draft' })
  const { data: drafts } = await get(me.local.drafts)
  t.is(drafts.length, 1)
})

// ─── handles work on built spec ───────────────────────────────────────────

test('build: created public scope works against a freshly built spec', async (t) => {
  const specDir = await buildInto(t, 'handles')
  const { spec } = await importSpec(specDir)

  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })

  const team = await open(me.team)
  await put(team.messages, { text: 'hi team' })
  const { data: msgs } = await get(team.messages)
  t.is(msgs.length, 1)
  t.is(msgs[0].text, 'hi team')
})

// ─── files builtin + t.file encoding ─────────────────────────────────────

const fileSchema = schema({
  photos: t.collection({ shot: t.file })
})

test('build: files is a builtin collection ref with an add-file dispatch', async (t) => {
  const specDir = await buildInto(t, 'files', fileSchema)
  const { meta } = await importSpec(specDir)
  t.is(meta.refs.files.internal, true, 'files is an internal ref')
  t.is(meta.refs.files.kind, 'collection')

  const dispatch = await fs.readFile(join(specDir, 'main/dispatch/index.js'), 'utf-8')
  t.ok(dispatch.includes('add-file'), 'add-file dispatch generated')
})

test('build: the file row schema declares an optional name', async (t) => {
  const specDir = await buildInto(t, 'files-schema', fileSchema)
  const { schema: types } = JSON.parse(
    await fs.readFile(join(specDir, 'main/schema/schema.json'), 'utf-8')
  )
  const file = types.find((x) => x.name === 'file')
  t.ok(file, 'file type registered')
  const name = file.fields.find((f) => f.name === 'name')
  t.ok(name, 'file has a name field')
  t.is(name.required, false, 'name is optional')
})

test('build: t.file encodes as a string column', async (t) => {
  const specDir = await buildInto(t, 'file-cols', fileSchema)
  const { schema: types } = JSON.parse(
    await fs.readFile(join(specDir, 'main/schema/schema.json'), 'utf-8')
  )
  const photos = types.find((x) => x.name === 'photos')
  t.is(photos.fields.find((f) => f.name === 'shot').type, 'string', 'file → string column')
})

// hyperdispatch numbers routes positionally and persists them —
// rebuilding an existing spec dir (apps rebuild incrementally, no rm -rf)
// must not renumber or duplicate routes. rotate-key is registered after all
// app dispatches for exactly this reason.
test('build: incremental rebuild over an existing spec stays loadable', async (t) => {
  const specDir = await buildInto(t, 'incremental')
  await build(specDir, fixture) // second build over the same dir, no wipe
  const { spec } = await importSpec(specDir)
  const router = new spec.dispatch.Router()
  router.add('@cero/rotate-key', async () => {})
  t.pass('rebuild loads and rotate-key routes')
})

// a field keeps the slot a built spec gave it: one more on a builtin goes after the fields it
// already has, whichever schema adds it, so an app's stored rows still read
const noted = schema({ handles: t.extend({ note: t.string }) })
const pinned = { name: 'pin', schema: { handles: t.extend({ pin: t.string }) } }

test('build: a field added to a builtin goes after the ones a built spec has', async (a) => {
  const specDir = await buildInto(a, 'field-order', noted)
  await build(specDir, noted, { extensions: [...bundled, pinned] })
  const { schema: types } = JSON.parse(
    await fs.readFile(join(specDir, 'main/schema/schema.json'), 'utf-8')
  )
  const names = types.find((x) => x.name === 'handle').fields.map((f) => f.name)
  a.alike(names.slice(-2), ['note', 'pin'], 'the stored field first, the new one after')
  await importSpec(specDir)
})

// a built spec keeps its route numbers, so the routes cero registers ahead of the app's are
// frozen: one more there takes the id an app route shipped with
test('build: the app routes start at the id they shipped with', async (t) => {
  const specDir = await buildInto(t, 'route-ids')
  const json = await fs.readFile(join(specDir, 'main/dispatch/dispatch.json'), 'utf-8')
  const ids = Object.fromEntries(JSON.parse(json).schema.map((r) => [r.name, r.id]))
  t.is(ids['@cero/set-profile'], 25, 'the first app route')
})

// one contract for the whole app, stamped by every database: a device on an older build skips newer
// writes in a handle as it does at the root, and only stored data moves the number
const plain = schema({
  notes: t.collection({ text: t.string }),
  room: { messages: t.collection({ text: t.string }) }
})
const tagged = schema({
  notes: t.collection({ text: t.string }),
  room: { messages: t.collection({ text: t.string, tag: t.string }) }
})
const probe = { note: t.string }

async function rebuilt(t, sub, ...schemas) {
  const dir = join(buildRoot, sub)
  await fs.rm(dir, { recursive: true, force: true })
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  for (const sch of schemas) await build(dir, sch, { extensions: [] })
  return dir
}

test('build: a change in a handle type raises the contract every database stamps', async (t) => {
  const dir = await rebuilt(t, 'contract-handle', plain, tagged)
  const { spec } = await importSpec(dir)
  t.is(spec.meta.version, 2, 'the change in room raises the contract')
  t.is(spec.handles.room.meta.version, 2, 'and a room carries it')

  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap, extensions: [] })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const room = await open(me.room, { name: 'r' })
  t.is(room.store.version, 2, 'a room stamps its ops with it')
})

test('build: a change to RPC alone keeps the contract', async (t) => {
  const dir = await rebuilt(t, 'contract-rpc', plain)
  rpc['req-probe'] = probe
  t.teardown(() => delete rpc['req-probe'])
  await build(dir, plain, { extensions: [] })
  const { version } = JSON.parse(await fs.readFile(join(dir, 'main/schema/schema.json'), 'utf-8'))
  t.is(version, 2, 'the RPC type raised the schema')
  const { spec } = await importSpec(dir)
  t.is(spec.meta.version, 1, 'but not the contract: nothing stored changed')
})

const quiet = schema({
  notes: t.collection({ text: t.string }),
  team: { messages: t.collection({ text: t.string }), ping: t.action({ x: t.string }) }
})
const pushed = schema({
  notes: t.collection({ text: t.string }, { push: true }),
  team: {
    messages: t.collection({ text: t.string }, { push: true }),
    ping: t.action({ x: t.string }, { push: true })
  }
})

test('build: push on a ref lands in its meta and keeps the contract', async (t) => {
  const dir = await rebuilt(t, 'contract-push', quiet)
  await build(dir, pushed, { extensions: [] })
  const { spec } = await importSpec(dir)
  t.is(spec.meta.refs.notes.push, true, 'a root collection')
  t.is(spec.meta.handles.team.refs.messages.push, true, 'a collection in a handle type')
  t.is(spec.meta.handles.team.refs.ping.push, true, 'an action')
  t.is(spec.meta.version, 1, 'the contract is unchanged: nothing stored changed')
})

test('build: a rebuild with no change keeps the contract, and it never goes down', async (t) => {
  const dir = await rebuilt(t, 'contract-keep', plain, tagged, tagged)
  t.is(JSON.parse(await fs.readFile(join(dir, 'contract.json'), 'utf-8')).version, 2, 'kept')
  // a spec built before the contract was kept: the first build carries its number forward
  await fs.rm(join(dir, 'contract.json'), { force: true })
  await build(dir, tagged, { extensions: [] })
  const { spec } = await importSpec(dir)
  t.is(spec.meta.version, 2, 'carried forward, never reset')
})

test('fields: bytes is a buffer column, file an id string, the rest map to themselves', (t) => {
  t.alike(
    fields({
      raw: { prim: 'bytes' },
      avatar: { prim: 'file' },
      n: { prim: 'uint', required: true }
    }),
    [
      { name: 'raw', type: 'buffer', required: false },
      { name: 'avatar', type: 'string', required: false },
      { name: 'n', type: 'uint', required: true }
    ]
  )
})

test('build: a Cero release that changes what a write means raises the contract', async (t) => {
  const dir = await rebuilt(t, 'contract-cero', plain)
  const was = contract.version
  contract.version = was + 1
  t.teardown(() => {
    contract.version = was
  })
  await build(dir, plain, { extensions: [] })
  const { spec } = await importSpec(dir)
  t.is(spec.meta.version, 2, 'nothing stored changed, the release did')
  await build(dir, plain, { extensions: [] })
  const kept = JSON.parse(await fs.readFile(join(dir, 'contract.json'), 'utf-8'))
  t.is(kept.version, 2, 'and the next build holds it')
})

// an index added by a rebuild: the rows written before it must be found through it, so a reopen
// over a store the old build wrote fills the index
const flat = schema({ notes: t.collection({ text: t.string, done: t.bool }) })
const byDone = schema({
  notes: t.collection({ text: t.string, done: t.bool }, { indexes: { 'by-done': ['done'] } })
})

test('build: an index added by a rebuild finds the rows written before it', async (t) => {
  const v1 = await rebuilt(t, 'replay-v1', flat)
  const v2 = await rebuilt(t, 'replay-v2', flat, byDone)
  const { spec: before } = await importSpec(v1)
  const { spec: after } = await importSpec(v2)
  t.is(after.meta.version, 2, 'the index raised the contract')

  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const me = await cero(dir, before, { bootstrap: testnet.bootstrap, extensions: [] })
  await put(me.notes, { text: 'open', done: false })
  await put(me.notes, { text: 'closed', done: true })
  await me.close()

  const again = await cero(dir, after, { bootstrap: testnet.bootstrap, extensions: [] })
  t.teardown(() => again.close().catch(() => {}), { order: 5 })
  const { data } = await get(again.notes, { done: true })
  t.is(data.length, 1, 'the old row is found through the new index')
  t.is(data[0]?.text, 'closed')
  const { data: written } = await put(again.notes, { text: 'later', done: true })
  const { data: both } = await get(again.notes, { done: true })
  t.alike(
    both.map((r) => r.id).sort(),
    [data[0]?.id, written.id].sort(),
    'and a row written after it too'
  )
})
