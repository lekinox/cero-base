import test from 'brittle'
import b4a from 'b4a'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { Duplex } from 'streamx'

import { encode, createNotification } from 'blind-push'
import { Invite } from '@cero-base/core/invite'

import { cero, open, put, set, get, invite, receive, schema, t } from '../../src/index.js'
import { receive as cold } from '../../src/push/index.js'
import { build } from '../../src/build/index.js'
import { contract } from '../../src/build/schemas.js'
import { serve } from '../../src/rpc/server.js'
import { connect } from '../../src/rpc/client.js'
import { makeMirror, makeTestnet, waitUntil } from '../helpers/index.js'

test.configure({ timeout: 120000 })

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'fixtures')

// the same schema, declared with each release's own builders
const define = ({ schema, t }) =>
  schema({
    profile: t.single({ name: t.string }),
    members: t.extend({ alias: t.string }),
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
  t.alike(
    (await get(me.room)).data.map((row) => row.id),
    [theirs.id],
    'its rooms, in a list'
  )
  const room = await open(me.room, { id: theirs.id })
  t.is((await get(room.messages)).data.length, 1, 'a handle and its rows')
  await put(room.messages, { text: 'second' })
  t.is((await get(room.messages)).data.length, 2, 'and it takes a write')
  t.is((await get(room.status)).data.behind, 0, 'nothing skipped')
})

test('compat: a room the previous release left stays gone on this one', async (t) => {
  const { old, before, now } = await previous()
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()

  const was = await old.cero(dir, before, { bootstrap: testnet.bootstrap })
  const kept = await old.open(was.room, { name: 'kept' })
  const gone = await old.open(was.room, { name: 'gone' })
  await old.leave(gone)
  await was.close()

  const me = await cero(dir, now, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.alike(
    (await get(me.room)).data.map((row) => row.id),
    [kept.id],
    'only the room it kept'
  )
  t.absent((await get(me.room, gone.id)).data, 'the one it left has no row')
})

test('compat: a push to a store the previous release wrote is refused until its handle opens on this one', async (t) => {
  const { old, before, now } = await previous()
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()

  const was = await old.cero(dir, before, { bootstrap: testnet.bootstrap })
  const theirs = await old.open(was.room, { name: 'r' })
  await old.put(theirs.messages, { text: 'first' })
  const notification = await createNotification(theirs.store.bee.local, {
    roomKey: theirs.store.key,
    extra: b4a.from('messages')
  })
  const payload = encode(notification)
  await was.close()

  t.is(await cold(dir, now, payload), null, 'its topics row names no writer')
  const me = await cero(dir, now, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.is(await receive(me, payload), null, 'nor once the app opened')
  const room = await open(me.room, { id: theirs.id })
  await waitUntil(async () => (await receive(me, payload))?.id === room.id)
  t.pass('the handle opened here: its writers are kept')
  await me.close()
  t.is((await cold(dir, now, payload))?.row?.text, 'first', 'and read cold')
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

test('compat: the previous release refuses an invite with an address of its own at once', async (t) => {
  const { now } = await previous()
  const { root } = JSON.parse(
    await fs.readFile(join(fixtures, '.compat', 'previous.json'), 'utf-8')
  )
  const core = join(root, 'node_modules', '@cero-base', 'core', 'src', 'pairing', 'invite.js')
  const { Invite: Previous } = await import(pathToFileURL(core).href)
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), now, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })

  const code = await invite(await open(me.room, { name: 'shared' }))
  t.ok(Invite.parse(code).own, 'an invite with an address of its own')
  t.exception(
    () => Previous.parse(code),
    /unknown invite version/,
    'instead of waiting on a join nobody opens'
  )
})

test('compat: an invite this release mints admits a device on the previous one', async (t) => {
  const { old, before } = await previous()
  // the app as it shipped and upgraded, in a room the previous release keeps at its version
  const shipped = await shippedSpec()
  const testnet = await makeTestnet(t)
  const owner = await old.cero(await t.tmp(), before, { bootstrap: testnet.bootstrap })
  t.teardown(() => owner.close().catch(() => {}), { order: 5 })
  const me = await cero(await t.tmp(), shipped, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const them = await old.cero(await t.tmp(), before, { bootstrap: testnet.bootstrap })
  t.teardown(() => them.close().catch(() => {}), { order: 5 })

  const room = await old.open(owner.room, { name: 'shared' })
  const mine = await open(me.room, await old.invite(room))
  const code = await invite(mine)
  t.absent(Invite.parse(code).own, "today's invite: the room's version keeps no secret")
  const theirs = await old.open(them.room, code)
  await put(mine.messages, { text: 'from now' })
  await waitUntil(async () => (await old.get(theirs.messages)).data.length === 1)
  t.pass('it joins and reads the room')
})

// a release that changes what a write means (leaving is no removal) raises a shipped app's contract on its next build:
// devices still on the previous release skip its writes until they update, as the database gate does
// the previous release's spec, contract.json and all, rebuilt by this one: an app that shipped and upgraded Cero
async function shippedSpec() {
  const { root } = JSON.parse(
    await fs.readFile(join(fixtures, '.compat', 'previous.json'), 'utf-8')
  )
  const dir = join(fixtures, '.build-compat-shipped')
  await fs.rm(dir, { recursive: true, force: true })
  await fs.cp(join(root, 'spec'), dir, { recursive: true })
  await build(dir, define({ schema, t }))
  return (await import(pathToFileURL(join(dir, 'index.js')).href)).spec
}

test('compat: a shipped app rebuilt on this release raises its contract when what a write means changed', async (t) => {
  const { before } = await previous()
  const { root } = JSON.parse(
    await fs.readFile(join(fixtures, '.compat', 'previous.json'), 'utf-8')
  )
  const schemas = join(root, 'node_modules', '@cero-base', 'cero', 'src', 'build', 'schemas.js')
  const { contract: was } = await import(pathToFileURL(schemas).href)
  const shipped = await shippedSpec()
  const rose = contract.version > (was?.version ?? 1)
  t.ok(
    rose ? shipped.meta.version > before.meta.version : shipped.meta.version >= before.meta.version
  )
})

test('compat: an invite to a room past the start is refused by the previous release at once', async (t) => {
  const { old, before } = await previous()
  const shipped = await shippedSpec()
  const { version, start } = shipped.meta
  if (version <= start) return t.pass('no raise between the two releases')
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), shipped, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const them = await old.cero(await t.tmp(), before, { bootstrap: testnet.bootstrap })
  t.teardown(() => them.close().catch(() => {}), { order: 5 })

  const mine = await open(me.room, { name: 'shared' })
  const err = await old.open(them.room, await invite(mine)).catch((e) => e)
  t.is(err?.code, 'INVALID_INVITE', 'it refuses the invite instead of waiting on a join')
})

test('compat: a join cancelled in a room the previous release hosts leaves every peer with the same members once the previous release accepts it', async (t) => {
  const { old, before } = await previous()
  // the app as it shipped and upgraded: the cancel is newer than the room, which stays at its version
  const shipped = await shippedSpec()
  const testnet = await makeTestnet(t)
  const opts = { bootstrap: testnet.bootstrap }
  const owner = await old.cero(await t.tmp(), before, opts)
  t.teardown(() => owner.close().catch(() => {}), { order: 5 })
  const skipped = []
  const me = await cero(await t.tmp(), shipped, {
    ...opts,
    onerror: (err) => skipped.push(err.message)
  })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const joiner = await cero(await t.tmp(), shipped, opts)
  t.teardown(() => joiner.close().catch(() => {}), { order: 5 })

  const theirs = await old.open(owner.room, { name: 'shared' })
  const mine = await open(me.room, await old.invite(theirs))
  const code = await old.invite(theirs, { confirm: true })
  const joining = open(joiner.room, code).catch((e) => e)
  const waiting = async (rows) => rows.data.find((r) => !r.admitted) || null
  const request = await waitUntil(async () => waiting(await old.get(theirs.requests)))
  await waitUntil(async () => waiting(await get(mine.requests)))
  t.ok(await cero.cancel(joiner, code), 'the joiner cancels')
  t.is((await joining).code, 'CANCELLED')
  await waitUntil(() => skipped.some((m) => m.includes('cancel-join is newer')))
  t.ok(
    await waiting(await get(mine.requests)),
    'this release keeps the request, as the previous one does'
  )

  await old.accept(theirs, request)
  await old.put(theirs.messages, { text: 'after the accept' })
  await waitUntil(async () => (await get(mine.messages)).data.length === 1)
  const ids = ({ data }) => data.map((row) => row.id).sort()
  t.alike(
    ids(await get(mine.members)),
    ids(await old.get(theirs.members)),
    'both releases list the same members'
  )
})

test('compat: a reader on this release writes no row of hers in a room the previous release hosts, and both releases hold the same member row', async (t) => {
  const { old, before } = await previous()
  // the app as it shipped and upgraded: the room stays at the version the previous release hosts
  const shipped = await shippedSpec()
  const testnet = await makeTestnet(t)
  const opts = { bootstrap: testnet.bootstrap }
  const owner = await old.cero(await t.tmp(), before, opts)
  t.teardown(() => owner.close().catch(() => {}), { order: 5 })
  const me = await cero(await t.tmp(), shipped, opts)
  t.teardown(() => me.close().catch(() => {}), { order: 5 })

  const theirs = await old.open(owner.room, { name: 'shared' })
  const mine = await open(me.room, await old.invite(theirs, { role: 'reader' }))
  const { length } = mine.store
  const err = await set(mine.members, { id: me.id, name: 'Ana', alias: 'A' }).catch((e) => e)
  t.is(err?.code, 'REFUSED', 'the previous release would take every field of it')
  t.is(mine.store.length, length, 'nothing goes in the log')
  await old.put(theirs.messages, { text: 'after' })
  await waitUntil(async () => (await get(mine.messages)).data.length === 1)
  t.alike(
    (await get(mine.members, me.id)).data,
    (await old.get(theirs.members, me.id)).data,
    'the same row on both'
  )
})

test('compat: a reader on this release with a profile opens a room the previous release hosts and the app hears no error of it', async (t) => {
  const { old, before } = await previous()
  const shipped = await shippedSpec()
  const testnet = await makeTestnet(t)
  const opts = { bootstrap: testnet.bootstrap }
  const owner = await old.cero(await t.tmp(), before, opts)
  t.teardown(() => owner.close().catch(() => {}), { order: 5 })
  const errors = []
  const me = await cero(await t.tmp(), shipped, { ...opts, onerror: (err) => errors.push(err) })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  await set(me.profile, { name: 'Ana' })

  const theirs = await old.open(owner.room, { name: 'shared' })
  const mine = await open(me.room, await old.invite(theirs, { role: 'reader' }))
  await old.put(theirs.messages, { text: 'after' })
  await waitUntil(async () => (await get(mine.messages)).data.length === 1)
  await set(me.profile, { name: 'Ana B' })
  await waitUntil(() => errors.length > 0, 3000).catch(() => {})
  t.alike(
    errors.map((err) => err.code),
    [],
    'the profile the bundled sync mirrors raises nothing'
  )
})

test('compat: a store the previous release wrote joins a room as soon as this release opens it', async (t) => {
  const { old, before } = await previous()
  const shipped = await shippedSpec()
  const testnet = await makeTestnet(t)
  const opts = { bootstrap: testnet.bootstrap }
  const host = await cero(await t.tmp(), shipped, opts)
  t.teardown(() => host.close().catch(() => {}), { order: 5 })
  const dir = await t.tmp()
  const was = await old.cero(dir, before, opts)
  await was.close()

  const code = await invite(await open(host.room, { name: 'shared' }))
  const me = await cero(dir, shipped, opts)
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const err = await open(me.room, code).then(
    () => null,
    (e) => e
  )
  t.is(err?.message ?? null, null, 'the join is asked under the version the root is at')
})

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

test('compat: a store the previous release wrote joins a room as soon as a worker on this release opens it, asked from its UI', async (t) => {
  const { old, before } = await previous()
  const shipped = await shippedSpec()
  const testnet = await makeTestnet(t)
  const opts = { bootstrap: testnet.bootstrap }
  const host = await cero(await t.tmp(), shipped, opts)
  t.teardown(() => host.close().catch(() => {}), { order: 5 })
  const storage = await t.tmp()
  await (await old.cero(storage, before, opts)).close()

  const code = await invite(await open(host.room, { name: 'shared' }))
  const [worker, ui] = pair()
  const server = await serve(worker, shipped, { storage, ...opts })
  t.teardown(() => server.close().catch(() => {}), { order: 5 })
  const client = await connect(ui, shipped)
  t.teardown(() => client.close().catch(() => {}), { order: 4 })
  const err = await open(client.room, code).then(
    () => null,
    (e) => e
  )
  t.is(err?.message ?? null, null, 'the join is asked under the version the root is at')
})
