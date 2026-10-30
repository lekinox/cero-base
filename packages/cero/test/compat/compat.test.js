import test from 'brittle'
import b4a from 'b4a'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import { cero, open, put, set, get, schema, t } from '../../src/index.js'
import { build } from '../../src/build/index.js'
import { makeMirror, makeTestnet, waitUntil } from '../helpers/index.js'

test.configure({ timeout: 120000 })

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'fixtures')

// the same schema, declared with each release's own builders
const define = ({ schema, t }) =>
  schema({
    profile: t.single({ name: t.string }),
    notes: t.collection({ text: t.string }),
    room: { messages: t.collection({ text: t.string }) }
  })

// a spec resolves @cero-base/cero from where it is built: the old one inside the old install
let loaded = null
async function previous() {
  if (loaded) return loaded
  const { version, root } = JSON.parse(
    await fs.readFile(join(fixtures, '.compat', 'previous.json'), 'utf-8')
  )
  const pkg = join(root, 'node_modules', '@cero-base', 'cero')
  const old = await import(pathToFileURL(join(pkg, 'src', 'index.js')).href)
  const { build: oldBuild } = await import(
    pathToFileURL(join(pkg, 'src', 'build', 'index.js')).href
  )
  const oldSpec = join(root, 'spec')
  const newSpec = join(fixtures, '.build-compat')
  for (const dir of [oldSpec, newSpec]) await fs.rm(dir, { recursive: true, force: true })
  await oldBuild(oldSpec, define(old))
  await build(newSpec, define({ schema, t }))
  const { spec: before } = await import(pathToFileURL(join(oldSpec, 'index.js')).href)
  const { spec: now } = await import(pathToFileURL(join(newSpec, 'index.js')).href)
  loaded = { version, old, before, now }
  return loaded
}

test('compat: a store the previous release wrote opens, reads and writes on this one', async (t) => {
  const { version, old, before, now } = await previous()
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()

  const was = await old.cero(dir, before, { bootstrap: testnet.bootstrap })
  await old.set(was.profile, { name: 'from ' + version })
  await old.put(was.notes, { text: 'kept' })
  const theirs = await old.open(was.room, { name: 'r' })
  await old.put(theirs.messages, { text: 'first' })
  await was.close()

  const me = await cero(dir, now, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.is((await get(me.profile)).data.name, 'from ' + version, 'the profile')
  t.is((await get(me.notes)).data.length, 1, 'a root collection')
  const room = await open(me.room, { id: theirs.id })
  t.is((await get(room.messages)).data.length, 1, 'a handle and its rows')
  await put(room.messages, { text: 'second' })
  t.is((await get(room.messages)).data.length, 2, 'and it takes a write')
  t.is((await get(room.status)).data.behind, 0, 'nothing skipped')
})

test('compat: a store the previous release wrote moves onto current cores once its mirror serves it', async (t) => {
  const { version, old, before, now } = await previous()
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const opts = { bootstrap: testnet.bootstrap, mirrors: [b4a.toHex(mirror.publicKey)] }
  const dir = await t.tmp()

  const was = await old.cero(dir, before, opts)
  await old.set(was.profile, { name: 'from ' + version })
  await was.close()

  const me = await cero(dir, now, opts)
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  await waitUntil(() => !me.store.bee.remapping, 60000)
  t.pass('the mirror served it')
  t.is((await get(me.profile)).data.name, 'from ' + version, 'and it reads the same')
})

test('compat: this release and the previous one write to one room, then one upgrades', async (t) => {
  const { old, before, now } = await previous()
  const testnet = await makeTestnet(t)
  const theirDir = await t.tmp()

  const them = await old.cero(theirDir, before, { bootstrap: testnet.bootstrap })
  const me = await cero(await t.tmp(), now, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const theirs = await old.open(them.room, { name: 'shared' })
  const mine = await open(me.room, await old.invite(theirs))

  await old.put(theirs.messages, { text: 'from before' })
  await put(mine.messages, { text: 'from now' })
  await waitUntil(async () => (await get(mine.messages)).data.length === 2)
  await waitUntil(async () => (await old.get(theirs.messages)).data.length === 2)
  t.is((await get(mine.status)).data.behind, 0, 'this release skips nothing')
  t.is((await old.get(theirs.status)).data.behind, 0, 'the previous one neither')

  await them.close()
  const upgraded = await cero(theirDir, now, { bootstrap: testnet.bootstrap })
  t.teardown(() => upgraded.close().catch(() => {}), { order: 5 })
  const room = await open(upgraded.room, { id: theirs.id })
  t.is((await get(room.messages)).data.length, 2, 'the upgraded device keeps the room')
  await put(room.messages, { text: 'after' })
  await waitUntil(async () => (await get(mine.messages)).data.length === 3)
  t.pass('and still syncs')
})
