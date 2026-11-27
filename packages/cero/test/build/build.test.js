import test from 'brittle'
import process from 'process'
import b4a from 'b4a'
import { Duplex } from 'streamx'
import { promises as fs, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import { cero, put, set, get, open, schema, t } from '../../src/index.js'
import { build } from '../../src/build/index.js'
import { Ref } from '../../src/lib/refs.js'
import { serve } from '../../src/rpc/server.js'
import { connect } from '../../src/rpc/client.js'
import { reserved } from '../../src/lib/reserved.js'
import { bundled } from '../../src/extensions/index.js'
import { fields } from '../../src/build/internal.js'
import { rpc, contract, main } from '../../src/build/schemas.js'
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

test('build: status is a computed builtin an app cannot declare', async (t) => {
  const specDir = await buildInto(t, 'live')
  const { meta } = await importSpec(specDir)
  t.is(meta.refs.status.kind, 'single')
  t.is(meta.handles.team.refs.status.kind, 'single')

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
  const reports = t.collection({ score: t.uint, updatedAt: t.uint, by: t.string })
  await refused(a, 'base-handle', schema({ group: { reports } }), /'updatedAt' in 'reports'/)
  const notes = t.collection({ id: t.string, text: t.string })
  await refused(a, 'base-root', schema({ notes }), /'id' in 'notes'/)
  const drafts = t.collection({ index: t.string })
  await refused(a, 'base-local', schema({ local: { drafts } }), /'index' in 'drafts'/)
})

test('build: a single keeps the other names Cero writes on a collection row', async (a) => {
  const settings = t.single({ id: t.string, index: t.uint, updatedAt: t.int })
  const specDir = await buildInto(a, 'base-single', schema({ settings }))
  const { spec, meta } = await importSpec(specDir)
  a.alike(meta.refs.settings.fields, ['id', 'index', 'updatedAt'])
  const testnet = await makeTestnet(a)
  const me = await cero(await a.tmp(), spec, { bootstrap: testnet.bootstrap })
  a.teardown(() => me.close().catch(() => {}), { order: 5 })
  await set(me.settings, { id: 'mine', index: 7, updatedAt: 3 })
  const { data } = await get(me.settings)
  a.alike([data.id, data.index, data.updatedAt], ['mine', 7, 3], 'and reads them back as written')
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

test('build: passes is an app noun, free in the root and a handle type', async (a) => {
  const text = t.collection({ text: t.string })
  const specDir = await buildInto(a, 'ref-passes', schema({ passes: text, room: { passes: text } }))
  const { meta } = await importSpec(specDir)
  a.is(meta.refs.passes.kind, 'collection')
  a.is(meta.handles.room.refs.passes.kind, 'collection')
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
  // the same fields as Cero's accept
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
  await refused(a, 'shape-digit', schema({ '2room': room }), /'2room' is not a handle name/)
})

test('build: a handle name of letters, digits and _ builds and imports', async (a) => {
  const room = { notes: t.collection({ text: t.string }) }
  const named = schema({ chatRoom2: room, Room: room, room_2: room })
  const { spec } = await importSpec(await buildInto(a, 'shape-names', named))
  for (const name of ['chatRoom2', 'Room', 'room_2']) a.ok(spec.handles[name].database, name)
})

test('build: a ref named like a member of the handle or the client is refused', async (a) => {
  const text = t.collection({ text: t.string })
  // a name only the UI's client carries, and one only the worker's handle does
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

  // every name `in` finds on the object, its own and its prototypes'. A ref it attached is no member, and a
  // private one is refused by its leading _
  const members = (o) => {
    const names = new Set()
    for (let p = o; p; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) names.add(k)
    }
    const ref = (k) => Object.getOwnPropertyDescriptor(o, k)?.value instanceof Ref
    return [...names].filter((k) => !k.startsWith('_') && !ref(k))
  }
  const worker = [me, await open(me.team), me.local]
  const ui = [client, await open(client.team), client.local]
  for (const o of [...worker, ...ui]) {
    a.alike(
      members(o).filter((k) => !reserved.includes(k)),
      [],
      `${worker.includes(o) ? 'worker' : 'client'} ${o.constructor.name}`
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

// a row is stored by position: a field gone from a built type would hand its slot to the next one
const titled = schema({ notes: t.collection({ title: t.string, body: t.string }) })

test('build: a field removed while another is added is refused', async (a) => {
  const due = schema({ notes: t.collection({ body: t.string, due: t.string }) })
  await a.exception.all(
    () => rebuilt(a, 'remove-add', titled, due),
    /'title' was removed from 'notes': fields are stored by position/
  )
})

test('build: a renamed field is refused', async (a) => {
  const named = schema({ notes: t.collection({ name: t.string, body: t.string }) })
  await a.exception.all(
    () => rebuilt(a, 'rename', titled, named),
    /'title' was removed from 'notes'/
  )
})

test('build: a field an app added to a builtin cannot be removed', async (a) => {
  const pin = schema({ handles: t.extend({ pin: t.string }) })
  await a.exception.all(
    () => rebuilt(a, 'remove-extend', noted, pin),
    /'note' was removed from 'handle'/
  )
})

test('build: a field appended keeps every stored row', async (a) => {
  const due = schema({ notes: t.collection({ title: t.string, body: t.string, due: t.string }) })
  const { spec: before } = await importSpec(await rebuilt(a, 'append-v1', titled))
  const { spec: after } = await importSpec(await rebuilt(a, 'append-v2', titled, due))

  const testnet = await makeTestnet(a)
  const dir = await a.tmp()
  const me = await cero(dir, before, { bootstrap: testnet.bootstrap, extensions: [] })
  await put(me.notes, { id: 'n1', title: 'Groceries', body: 'milk' })
  await me.close()
  const again = await cero(dir, after, { bootstrap: testnet.bootstrap, extensions: [] })
  a.teardown(() => again.close().catch(() => {}), { order: 5 })
  const { data } = await get(again.notes, 'n1')
  a.alike([data.title, data.body, data.due], ['Groceries', 'milk', null])
})

// a built spec keeps its route numbers, so the routes cero registers ahead of the app's are
// frozen: one more there takes the id an app route shipped with
test('build: the app routes start at the id they shipped with', async (t) => {
  const specDir = await buildInto(t, 'route-ids')
  const json = await fs.readFile(join(specDir, 'main/dispatch/dispatch.json'), 'utf-8')
  const ids = Object.fromEntries(JSON.parse(json).schema.map((r) => [r.name, r.id]))
  t.is(ids['@cero/set-profile'], 25, 'the first app route')
})

test("build: a collection Cero added once apps shipped is numbered after the app's collections and indexes", async (t) => {
  const specDir = await buildInto(t, 'added-ids')
  const json = await fs.readFile(join(specDir, 'main/db/db.json'), 'utf-8')
  const rows = JSON.parse(json).schema
  t.ok(
    rows.some((row) => row.type === 2),
    'the app has an index'
  )
  const last = [...rows].sort((a, b) => a.id - b.id).slice(-2)
  t.alike(
    last.map((row) => row.name),
    ['owed', 'seats'],
    'so none of theirs moved'
  )
})

// a route's id is the wire format: one added later takes a free id, wherever its schema registers it,
// and never the id of a route registered after it, as the bundled extensions' are after an app's
test('build: a collection added to a shipped app builds a spec that loads, every route on its id', async (a) => {
  const dir = join(buildRoot, 'grown')
  await fs.rm(dir, { recursive: true, force: true })
  a.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  const routes = async (sub) =>
    JSON.parse(await fs.readFile(join(dir, sub, 'dispatch/dispatch.json'), 'utf-8')).schema
  const grown = schema({
    notes: t.collection({ text: t.string }),
    tasks: t.collection({ title: t.string }),
    room: { messages: t.collection({ text: t.string }), polls: t.collection({ title: t.string }) }
  })

  await build(dir, plain)
  const shipped = { main: await routes('main'), room: await routes('handles/room') }
  await build(dir, grown)
  for (const [sub, was] of [
    ['main', shipped.main],
    ['handles/room', shipped.room]
  ]) {
    const now = await routes(sub)
    const ids = new Map(now.map((r) => [r.name, r.id]))
    a.ok(now.length > was.length, `${sub}: the new routes are there`)
    a.is(new Set(ids.values()).size, now.length, `${sub}: no two routes share an id`)
    a.alike(
      was.map((r) => ids.get(r.name)),
      was.map((r) => r.id),
      `${sub}: every shipped route keeps its id`
    )
  }
  const { spec } = await importSpec(dir).catch((err) => ({ spec: null, err }))
  a.ok(spec, 'the spec loads')
  const task = { id: 't1', title: 'call back', createdAt: 1, updatedAt: 1 }
  const op = spec?.dispatch.decode(spec.dispatch.encode('@cero/add-tasks', task))
  a.is(op?.name, '@cero/add-tasks', 'and routes the new collection')
})

test('build: a route a Cero release adds takes a free id in a spec built before it', async (a) => {
  const dir = await rebuilt(a, 'route-added', plain)
  // the spec as a release without Cero's last route built it: every route after that one an id lower
  const file = join(dir, 'main/dispatch/dispatch.json')
  const json = JSON.parse(await fs.readFile(file, 'utf-8'))
  const at = json.schema.findIndex((route) => route.name === '@cero/del-refusal')
  const [dropped] = json.schema.splice(at, 1)
  for (const route of json.schema) if (route.id > dropped.id) route.id--
  await fs.writeFile(file, JSON.stringify(json, null, 2))
  const shipped = json.schema.map((route) => [route.name, route.id])

  await build(dir, plain, { extensions: [] })
  const now = JSON.parse(await fs.readFile(file, 'utf-8')).schema
  const ids = new Map(now.map((route) => [route.name, route.id]))
  a.is(new Set(ids.values()).size, now.length, 'no two routes share an id')
  a.alike(
    shipped.map(([name]) => ids.get(name)),
    shipped.map(([, id]) => id),
    'every route the spec had keeps its id'
  )
  a.ok(ids.get('@cero/del-refusal') > Math.max(...shipped.map(([, id]) => id)), 'the new one after')
  const { spec } = await importSpec(dir).catch(() => ({ spec: null }))
  a.ok(spec, 'and the spec loads')
})

// a required field is stored with no sign of its absence, so rows written before it would not decode
test('build: a required field added to a shipped collection is refused', async (a) => {
  const due = schema({
    notes: t.collection({ title: t.string, body: t.string, due: t.required(t.string) })
  })
  await rebuilt(a, 'required-late', titled)
  await refused(a, 'required-late', due, /'due' on 'notes' is required/)
  const again = build(join(buildRoot, 'required-late'), titled, { extensions: [] })
  await a.execution(again, 'and the schema that shipped builds again')
})

test('build: a required field added to a builtin of a shipped app is refused', async (a) => {
  const alias = schema({ members: t.extend({ alias: t.required(t.string) }) })
  await rebuilt(a, 'required-builtin', schema({}))
  await refused(a, 'required-builtin', alias, /'alias' on 'member' is required/)
})

test('build: a required field a Cero release adds to a type that is never stored builds', async (a) => {
  const dir = await rebuilt(a, 'required-unstored', plain)
  const verb = rpc['req-verb']
  rpc['req-verb'] = { ...verb, extra: t.required(t.string) }
  a.teardown(() => {
    rpc['req-verb'] = verb
  })
  await a.execution(build(dir, plain, { extensions: [] }))
})

test('build: a required field in a collection that is new builds', async (a) => {
  const fresh = schema({
    notes: t.collection({ title: t.string, body: t.string }),
    visits: t.collection({ date: t.required(t.string) })
  })
  const { spec } = await importSpec(await rebuilt(a, 'required-new', titled, fresh))
  a.ok(spec.meta.refs.visits, 'a collection that never stored a row may require a field')
})

// a route stays in a built spec, and one with nothing left to handle it fails every write
const whole = {
  notes: t.collection({ text: t.string }),
  prefs: t.single({ theme: t.string }),
  room: { messages: t.collection({ text: t.string }), archive: t.action({ until: t.int }) },
  local: { drafts: t.collection({ text: t.string }) }
}

test('build: a collection, a single or an action removed from a shipped schema, or declared as another kind, is refused', async (a) => {
  const { notes, prefs, room, local } = whole
  const { messages, archive } = room
  const dir = await rebuilt(a, 'removed', schema(whole))
  const lacks = (defs, route) =>
    refused(a, 'removed', schema(defs), new RegExp(`route '@cero/${route}' shipped and this`))
  await lacks({ prefs, room, local }, 'add-notes')
  await lacks({ notes, room, local }, 'set-prefs')
  await lacks({ notes, prefs, room: { messages }, local }, 'archive')
  await lacks({ notes, prefs, room: { archive }, local }, 'add-messages')
  await lacks({ ...whole, prefs: t.action({ theme: t.string }) }, 'set-prefs')
  await a.execution(build(dir, schema(whole), { extensions: [] }), 'the schema that shipped builds')
  const synced = schema({ notes, prefs, room })
  await a.execution(build(dir, synced, { extensions: [] }), 'and a local collection has no route')
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

// apply reads `own` from the reader's spec, so a shipped collection that changes it applies one log
// by two rules: a new rule needs a new collection
const loose = schema({
  notes: t.collection({ text: t.string }),
  room: { messages: t.collection({ text: t.string }) }
})
const ownNotes = schema({
  notes: t.collection({ text: t.string }, { own: true }),
  room: { messages: t.collection({ text: t.string }) }
})
const ownMessages = schema({
  notes: t.collection({ text: t.string }),
  room: { messages: t.collection({ text: t.string }, { own: true }) }
})
const ownAdded = schema({
  notes: t.collection({ text: t.string }),
  todos: t.collection({ text: t.string }, { own: true }),
  room: {
    messages: t.collection({ text: t.string }),
    pins: t.collection({ text: t.string }, { own: true })
  }
})

test('build: own added to a shipped collection fails the build', async (t) => {
  const dir = await rebuilt(t, 'own-on', loose)
  const err = await build(dir, ownNotes, { extensions: [] }).catch((e) => e)
  t.is(err?.code, 'INVALID', err?.message)
  t.ok(/'notes'/.test(err?.message), 'it names the collection')
  const kept = JSON.parse(await fs.readFile(join(dir, 'contract.json'), 'utf-8'))
  t.is(kept.own?.main?.notes, false, 'the shipped rule stays recorded')
})

test('build: own added to a shipped collection of a handle type fails the build', async (t) => {
  const dir = await rebuilt(t, 'own-on-handle', loose)
  const err = await build(dir, ownMessages, { extensions: [] }).catch((e) => e)
  t.is(err?.code, 'INVALID', err?.message)
  t.ok(/'messages'/.test(err?.message), 'it names the collection')
})

test('build: own taken off a shipped collection fails the build', async (t) => {
  const dir = await rebuilt(t, 'own-off', ownNotes)
  const err = await build(dir, loose, { extensions: [] }).catch((e) => e)
  t.is(err?.code, 'INVALID', err?.message)
})

test('build: own on a collection of a handle type dropped and declared again fails the build', async (a) => {
  const rootOnly = schema({ notes: t.collection({ text: t.string }) })
  const dir = await rebuilt(a, 'own-again', loose, rootOnly)
  const err = await build(dir, loose, { extensions: [] }).catch((e) => e)
  a.absent(err, 'declared again with the rule it shipped with')
  await build(dir, rootOnly, { extensions: [] })
  const again = await build(dir, ownMessages, { extensions: [] }).catch((e) => e)
  a.is(again?.code, 'INVALID', again?.message)
  a.ok(/'messages'/.test(again?.message), 'it names the collection')
})

test('build: own on a new collection builds', async (t) => {
  const dir = await rebuilt(t, 'own-new', loose, ownAdded)
  const { spec } = await importSpec(dir)
  t.is(spec.meta.refs.todos.own, true, 'at the root')
  t.is(spec.meta.handles.room.refs.pins.own, true, 'in a handle type')
  const kept = JSON.parse(await fs.readFile(join(dir, 'contract.json'), 'utf-8'))
  t.alike(kept.own?.main, { notes: false, todos: true })
  t.alike(kept.own?.[join('handles', 'room')], { messages: false, pins: true })
})

test('build: an unchanged rebuild with own is quiet', async (t) => {
  const dir = await rebuilt(t, 'own-keep', ownNotes, ownNotes)
  const { spec } = await importSpec(dir)
  t.is(spec.meta.refs.notes.own, true)
  t.is(spec.meta.version, 1, 'and the contract stays')
})

test('build: a refused build leaves the spec as it was, and what it held builds again', async (a) => {
  const dir = await rebuilt(a, 'refused-whole', loose)
  const file = join(dir, 'main/schema/schema.json')
  const before = await fs.readFile(file, 'utf-8')
  const more = schema({
    notes: t.collection({ text: t.string, due: t.int }, { own: true }),
    room: { messages: t.collection({ text: t.string }) }
  })
  await a.exception(build(dir, more, { extensions: [] }), /shipped without own/)
  a.is(await fs.readFile(file, 'utf-8'), before, 'nothing of the refused build is on disk')
  await a.execution(build(dir, loose, { extensions: [] }), 'the schema it held builds again')
})

test('build: a spec built before own was kept builds, and keeps it from then on', async (t) => {
  const dir = await rebuilt(t, 'own-unrecorded', loose)
  const file = join(dir, 'contract.json')
  const { own, ...old } = JSON.parse(await fs.readFile(file, 'utf-8'))
  t.ok(own, 'this release records it')
  await fs.writeFile(file, JSON.stringify(old))
  await build(dir, loose, { extensions: [] })
  const kept = JSON.parse(await fs.readFile(file, 'utf-8'))
  t.is(kept.own?.main?.notes, false, 'recorded on the first build that finds none')
  t.is(kept.version, old.version, 'and the contract holds')
})

// a type nothing stores is bound by hyperschema alone, which compares fields by position and type
test('build: a Cero release that renames the last field of an unstored type still builds', async (t) => {
  const dir = await rebuilt(t, 'unstored-rename', plain)
  const renamed = (type) => {
    const fields = Object.entries(type)
    return Object.fromEntries([...fields.slice(0, -1), ['renamed', fields.at(-1)[1]]])
  }
  const verb = rpc['req-verb']
  const status = main.status
  rpc['req-verb'] = renamed(verb)
  main.status = renamed(status)
  t.teardown(() => {
    rpc['req-verb'] = verb
    main.status = status
  })
  await t.execution(build(dir, plain, { extensions: [] }))
  t.is(await contractOf(dir), 1, 'and nothing stored changed')
})

test("build: memberId is Cero's in a single and in a field added to a builtin", async (a) => {
  const settings = t.single({ theme: t.string, memberId: t.string })
  await refused(a, 'member-single', schema({ settings }), /'memberId' in 'settings'/)
  const handles = t.extend({ memberId: t.string })
  await refused(a, 'member-extend', schema({ handles }), /'memberId'/)
})

async function contractOf(dir) {
  return JSON.parse(await fs.readFile(join(dir, 'contract.json'), 'utf-8')).version
}

async function typesOf(dir) {
  return JSON.parse(await fs.readFile(join(dir, 'main/schema/schema.json'), 'utf-8')).schema
}

test('build: a field a Cero release adds to a computed type keeps the contract', async (t) => {
  const dir = await rebuilt(t, 'contract-live', plain)
  main.status.battery = probe.note
  t.teardown(() => delete main.status.battery)
  await build(dir, plain, { extensions: [] })
  const status = (await typesOf(dir)).find((x) => x.name === 'status')
  t.ok(
    status.fields.some((f) => f.name === 'battery'),
    'the computed type gained it'
  )
  t.is(await contractOf(dir), 1, 'but not the contract: nothing stored changed')
})

test('build: an RPC type a Cero release drops keeps the contract', async (t) => {
  const dir = await rebuilt(t, 'contract-rpc-gone', plain)
  rpc['req-gone'] = probe
  t.teardown(() => delete rpc['req-gone'])
  await build(dir, plain, { extensions: [] })
  delete rpc['req-gone']
  await build(dir, plain, { extensions: [] })
  const kept = (await typesOf(dir)).some((x) => x.name === 'req-gone')
  t.ok(kept, 'the dropped type stays in schema.json')
  t.is(await contractOf(dir), 1, 'and the contract stays')
})

// the contract shapes the types the collections and routes name; one embedded in them would escape it
test('build: no stored type embeds another type', async (t) => {
  const specDir = await buildInto(t, 'embeds')
  const read = async (rel) => JSON.parse(await fs.readFile(join(specDir, rel), 'utf-8'))
  const dirs = [
    'main',
    ...(await fs.readdir(join(specDir, 'handles'))).map((n) => join('handles', n))
  ]
  for (const dir of dirs) {
    const types = (await read(join(dir, 'schema', 'schema.json'))).schema
    const db = await read(join(dir, 'db', 'db.json'))
    const routes = await read(join(dir, 'dispatch', 'dispatch.json'))
    const named = new Set([
      ...db.schema.map((x) => x.schema),
      ...routes.schema.map((x) => x.requestType)
    ])
    const embedded = types
      .filter((type) => named.has(`@${type.namespace}/${type.name}`))
      .flatMap((type) => type.fields.filter((f) => f.type.startsWith('@')).map((f) => f.type))
    t.alike(embedded, [], `${dir}: shape a type it embeds too, in shapeOf, before adding one`)
  }
})

test('build: a field appended to a stored type at the root raises the contract', async (a) => {
  const more = schema({ ...plain.defs, notes: t.collection({ text: t.string, tag: t.string }) })
  const dir = await rebuilt(a, 'contract-root', plain, more)
  a.is(await contractOf(dir), 2)
})

test('build: a field a Cero release adds to a stored builtin raises the contract', async (t) => {
  const dir = await rebuilt(t, 'contract-builtin', plain)
  main.member.probe = probe.note
  t.teardown(() => delete main.member.probe)
  await build(dir, plain, { extensions: [] })
  t.is(await contractOf(dir), 2)
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

// a spec keeps, for every contract from its start on, what each builder was at: from it the build
// dates every field, ref and route, and a device encodes an op as an older contract would
const dated = schema({ notes: t.collection({ title: t.string, body: t.string, due: t.string }) })
const tasked = schema({ ...dated.defs, tasks: t.collection({ title: t.string }) })

async function keptOf(dir) {
  return JSON.parse(await fs.readFile(join(dir, 'contract.json'), 'utf-8'))
}

test('build: the history keeps each contract, and a change to RPC alone moves nothing', async (a) => {
  const dir = await rebuilt(a, 'history', titled, dated, tasked)
  const kept = await keptOf(dir)
  a.alike(Object.keys(kept.history), ['1', '2', '3'], 'one entry per contract')
  a.alike([kept.version, kept.start, kept.floor, kept.target], [3, 1, 1, 3])
  const types = ['1', '2', '3'].map((c) => kept.history[c].main[0])
  a.ok(types[0] < types[1] && types[1] < types[2], 'each records the schema it was built with')
  const { spec } = await importSpec(dir)
  a.is(spec.meta.since.types['@cero/notes'].due, 2, 'the field came with contract 2')
  a.is(spec.meta.refs.tasks.since, 3, 'the collection with contract 3')

  rpc['req-probe'] = probe
  a.teardown(() => delete rpc['req-probe'])
  await build(dir, tasked, { extensions: [] })
  const again = await keptOf(dir)
  a.alike(Object.keys(again.history), ['1', '2', '3'], 'no contract added')
  a.alike([again.version, again.start, again.floor, again.target], [3, 1, 1, 3])
  const after = (await importSpec(dir)).spec
  a.alike(after.meta.since, spec.meta.since, 'no since moved')
  a.alike(after.meta.encoding, spec.meta.encoding, 'nor what a contract encodes with')
})

test('build: meta dates every field, collection, single, action, route and handle type', async (a) => {
  const grown = schema({
    notes: t.collection({ text: t.string, tag: t.string }),
    prefs: t.single({ theme: t.string }),
    ping: t.action({ x: t.string }),
    members: t.extend({ alias: t.string }),
    room: {
      messages: t.collection({ text: t.string, pin: t.string }),
      polls: t.collection({ title: t.string })
    },
    board: { cards: t.collection({ text: t.string }) }
  })
  const { spec } = await importSpec(await rebuilt(a, 'since', plain, grown))
  const { meta } = spec
  const room = meta.handles.room
  a.alike([meta.start, meta.target, room.start, room.target], [1, 2, 1, 2])
  a.is(meta.refs.notes.since, 0, 'a collection of the first build')
  a.is(meta.since.types['@cero/notes'].text, 0, 'and its field')
  a.is(meta.since.types['@cero/notes'].tag, 2, 'a field added')
  a.is(meta.refs.prefs.since, 2, 'a single added')
  a.is(meta.refs.ping.since, 2, 'an action added')
  a.is(meta.since.routes['@cero/add-notes'], 0, 'a route of the first build')
  a.is(meta.since.routes['@cero/set-prefs'], 2, 'a route added')
  a.is(meta.since.routes['@cero/rotate-key'], 0, 'a route of Cero')
  a.is(meta.refs.members.since, 0, 'a builtin')
  a.is(meta.since.types['@cero/member'].id, 0, 'its own field')
  a.is(meta.since.types['@cero/member'].alias, 2, 'a field t.extend added')
  a.is(room.since.types['@cero/member'].alias, 2, 'there in a handle type too')
  a.is(room.refs.messages.since, 0, 'a collection of a handle type')
  a.is(room.since.types['@cero/messages'].pin, 2, 'a field added to it')
  a.is(room.refs.polls.since, 2, 'a collection added to it')
  a.is(room.since.routes['@cero/add-polls'], 2, 'and its route')
  a.is(meta.refs.room.since, 0, 'a handle type of the first build')
  a.is(meta.refs.board.since, 2, 'a handle type added')
  a.is(meta.handles.board.refs.cards.since, 2, 'and its refs')
})

// contract.json as a build before the history wrote it
async function unrecorded(dir) {
  const { version, shape, own } = await keptOf(dir)
  await fs.writeFile(join(dir, 'contract.json'), JSON.stringify({ version, shape, own }))
}

test('build: what a spec had before it kept a history is since 0, the history starting at its contract', async (a) => {
  const dir = await rebuilt(a, 'pre-history', titled, dated)
  await unrecorded(dir)
  await build(dir, tasked, { extensions: [] })
  const kept = await keptOf(dir)
  a.alike(Object.keys(kept.history), ['2', '3'], 'it starts at the contract the spec had')
  a.is(kept.start, 2)
  a.is(kept.floor, 2, 'Cero rules did not change: the floor is the start')
  const { meta } = (await importSpec(dir)).spec
  a.is(meta.since.types['@cero/notes'].due, 0, 'a field the spec had')
  a.is(meta.refs.notes.since, 0, 'a collection it had')
  a.is(meta.refs.tasks.since, 3, 'one added after')
})

test('build: a row encoded as of an older contract is what the older spec writes, and it reads there', async (a) => {
  const { spec: before } = await importSpec(await rebuilt(a, 'encode-v1', plain))
  const { spec: after } = await importSpec(await rebuilt(a, 'encode-v2', plain, tagged))
  const row = { id: 'm1', text: 'hi', tag: 'urgent' }
  const route = '@cero/add-messages'
  const room = { before: before.handles.room, after: after.handles.room }
  const old = after.meta.handles.room.encoding[1]
  const bytes = room.after.dispatch.encode(route, row, { version: old })
  a.alike(bytes, room.before.dispatch.encode(route, row), 'what the older spec encodes')
  const { value } = room.before.dispatch.decode(bytes)
  a.alike([value.id, value.text], ['m1', 'hi'], 'and decodes')
  a.not(b4a.equals(room.after.dispatch.encode(route, row), bytes), 'the latest carries the tag')
  const note = { id: 'n1', text: 'a' }
  a.alike(
    after.dispatch.encode('@cero/add-notes', note, { version: after.meta.encoding[1] }),
    before.dispatch.encode('@cero/add-notes', note),
    'at the root too'
  )
})

test('build: t.later holds back a field, a collection, a single, an action or a field of a builtin', async (a) => {
  const held = {
    field: { notes: t.collection({ title: t.string, body: t.string, due: t.later(t.string) }) },
    collection: { visits: t.later(t.collection({ date: t.string })) },
    single: { prefs: t.later(t.single({ theme: t.string })) },
    action: { ping: t.later(t.action({ x: t.string })) },
    builtin: { members: t.extend({ alias: t.later(t.string) }) }
  }
  const room = { messages: t.collection({ text: t.string, tag: t.later(t.string) }) }
  const builds = [
    ...Object.entries(held).map(([kind, defs]) => [kind, titled, { ...titled.defs, ...defs }]),
    ['field in a handle type', plain, { ...plain.defs, room }]
  ]
  for (const [kind, base, defs] of builds) {
    const dir = await rebuilt(a, `later-${kind}`, base, schema(defs))
    const kept = await keptOf(dir)
    a.alike([kept.version, kept.target], [2, 1], `a ${kind}: the target stays below it`)
    a.is((await importSpec(dir)).spec.meta.target, 1, 'and meta carries it')
  }
  const dir = await rebuilt(
    a,
    'later-off',
    titled,
    schema({ ...titled.defs, ...held.field }),
    dated
  )
  a.alike([await contractOf(dir), (await keptOf(dir)).target], [2, 2], 'the mark removed, it is on')
})

test('build: t.later on something rooms use already is refused, naming it', async (a) => {
  const { notes } = titled.defs
  await rebuilt(a, 'later-used', titled)
  const title = t.collection({ title: t.later(t.string), body: t.string })
  await refused(a, 'later-used', schema({ notes: title }), /'title' in 'notes'.*in use already/)
  await refused(a, 'later-used', schema({ notes: t.later(notes) }), /'notes'.*in use already/)
  await refused(a, 'later-first', schema({ notes: t.later(notes) }), /'notes'.*in use already/)
})

test('build: something newer than a held thing and not held itself is refused, naming it', async (a) => {
  const due = { title: t.string, body: t.string, due: t.later(t.string) }
  await rebuilt(a, 'later-order', titled, schema({ notes: t.collection(due) }))
  const tag = schema({ notes: t.collection({ ...due, tag: t.string }) })
  await refused(a, 'later-order', tag, /'tag' in 'notes'.*mark it too/)
  const tasks = schema({ notes: t.collection(due), tasks: t.collection({ x: t.string }) })
  await refused(a, 'later-order', tasks, /'tasks'.*mark it too/)
  const both = schema({ notes: t.collection({ ...due, tag: t.later(t.string) }) })
  await build(join(buildRoot, 'later-order'), both, { extensions: [] })
  const kept = await keptOf(join(buildRoot, 'later-order'))
  a.alike([kept.version, kept.target], [3, 1], 'held too, it builds')
})

test('build: the target never goes down: a thing released cannot be held again', async (a) => {
  const held = schema({
    notes: t.collection({ title: t.string, body: t.string, due: t.later(t.string) })
  })
  const dir = await rebuilt(a, 'later-down', titled, held, dated)
  a.is((await keptOf(dir)).target, 2, 'released')
  await refused(a, 'later-down', held, /'due' in 'notes'.*in use already/)
  a.is((await keptOf(dir)).target, 2, 'and the target stays')
})

test('build: a Cero release that changes what a write means raises the floor, and nothing below it is held', async (a) => {
  const held = schema({
    notes: t.collection({ title: t.string, body: t.string, due: t.later(t.string) })
  })
  const dir = await rebuilt(a, 'floor', titled, held)
  a.alike([(await keptOf(dir)).floor, (await keptOf(dir)).target], [1, 1])
  const was = contract.version
  contract.version = was + 1
  a.teardown(() => {
    contract.version = was
  })
  await refused(a, 'floor', held, /'due' in 'notes'.*in use already/)
  await build(dir, dated, { extensions: [] })
  const kept = await keptOf(dir)
  a.alike([kept.version, kept.floor, kept.target], [3, 3, 3], 'the floor is the contract it raised')
  await build(dir, dated, { extensions: [] })
  a.is((await keptOf(dir)).floor, 3, 'and the next build keeps it')
})

test('build: a spec built before its history holds back what it adds, unless Cero rules changed', async (a) => {
  const held = schema({
    notes: t.collection({ title: t.string, body: t.string, due: t.later(t.string) })
  })
  const dir = await rebuilt(a, 'pre-history-later', titled)
  await unrecorded(dir)
  await build(dir, held, { extensions: [] })
  const kept = await keptOf(dir)
  a.alike([kept.version, kept.start, kept.floor, kept.target], [2, 1, 1, 1], 'it is held')

  await rebuilt(a, 'pre-history-rules', titled)
  await unrecorded(join(buildRoot, 'pre-history-rules'))
  const was = contract.version
  contract.version = was + 1
  a.teardown(() => {
    contract.version = was
  })
  await refused(a, 'pre-history-rules', held, /'due' in 'notes'.*in use already/)
})

test('build: a handle type added with a held thing in it is refused: it cannot be held on its own', async (a) => {
  await rebuilt(a, 'later-handle-new', titled)
  const board = { cards: t.later(t.collection({ x: t.string })) }
  const grown = schema({ ...titled.defs, board })
  await refused(a, 'later-handle-new', grown, /'board' shipped with or after 'cards'/)
})

test('build: t.later on a handle type, on t.extend or in local is refused, naming it', async (a) => {
  const cards = t.collection({ x: t.string })
  const marked = [
    [{ board: t.later({ cards }) }, /'board' is a handle type: t.later holds back a field/],
    [{ members: t.later(t.extend({ alias: t.string })) }, /'members' extends a builtin: t.later/],
    [{ local: { drafts: t.collection({ x: t.later(t.string) }) } }, /'x' in 'drafts' is local/],
    [{ local: { drafts: t.later(cards) } }, /'drafts' is local: t.later/]
  ]
  await rebuilt(a, 'later-where', titled)
  for (const [defs, message] of marked) {
    await refused(a, 'later-where', schema({ ...titled.defs, ...defs }), message)
  }
})

test('build: a refusal names a field t.extend adds by the builtin the app wrote', async (a) => {
  await rebuilt(a, 'later-extend-name', titled)
  const grown = schema({
    ...titled.defs,
    members: t.extend({ alias: t.later(t.string) }),
    tasks: t.collection({ x: t.string })
  })
  await refused(a, 'later-extend-name', grown, /'tasks' shipped with or after 'alias' in 'members'/)
})

test('build: a refused mark leaves the spec as it was', async (a) => {
  const dir = await rebuilt(a, 'later-whole', titled)
  const files = ['contract.json', 'main/schema/schema.json', 'index.js']
  const read = () => Promise.all(files.map((f) => fs.readFile(join(dir, f), 'utf-8')))
  const before = await read()
  const used = schema({
    notes: t.collection({ title: t.later(t.string), body: t.string, due: t.string })
  })
  await a.exception(build(dir, used, { extensions: [] }), /in use already/)
  a.alike(await read(), before, 'nothing of the refused build is on disk')
})
