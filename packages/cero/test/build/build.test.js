import test from 'brittle'
import process from 'process'
import { promises as fs, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import { cero, put, set, get, open, schema, t } from '../../src/index.js'
import { build } from '../../src/build/index.js'
import { fields } from '../../src/build/internal.js'
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
