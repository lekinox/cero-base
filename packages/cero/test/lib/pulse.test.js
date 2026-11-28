import test from 'brittle'
import process from 'process'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import HyperDHT from 'hyperdht'
import PulseClient from 'hypertracker/client'
import { spawn } from 'child_process'

import { cero, put, get, open, close, leave } from '../../src/index.js'
import { pulse } from '../../src/extensions/index.js'
import { spec } from '../fixtures/spec/pulse/index.js'
import { spec as plain } from '../fixtures/spec/index.js'
import { makeTestnet, makePulse, makeMirror, waitUntil } from '../helpers/index.js'

test.configure({ timeout: 90000 })

const CLOSE = new URL('../fixtures/pulse-close.js', import.meta.url).pathname
// how a member signs for a room on the service, as anyone reading the source can
const [NS] = crypto.namespace('cero/bump', 1)

// a device of its own identity, running pulse alone: a handle it lets go of closes at once
async function device(t, testnet, service, { dir, ...opts } = {}) {
  dir ??= await t.tmp()
  const me = await cero(dir, spec, {
    bootstrap: testnet.bootstrap,
    extensions: [pulse(service.key)],
    keepOpen: 0,
    ...opts
  })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const pulses = []
  me.on('pulse', (id, heard) => pulses.push({ id, heard }))
  // every handle opened, by a wake or the app
  const loads = []
  const load = me._load.bind(me)
  me._load = (type, id) => (loads.push(id), load(type, id))
  return { me, dir, pulses, loads }
}

// a write from another device landed in `id` at `after` or later
function pulsed(peer, id, after) {
  return waitUntil(() => peer.pulses.find((p) => p.id === id && p.heard >= after))
}

async function row(peer, room) {
  return (await get(peer.me.local.pulses, room.id)).data
}

// as many devices follow one handle on the service
function followed(service, count) {
  return waitUntil(() => [...service.server.subs.values()].some((subs) => subs.size >= count))
}

async function join(b, room) {
  const joined = await open(b.me.team, await cero.invite(room))
  await waitUntil(async () => (await get(joined.status)).data.writable)
  return joined
}

// `b` follows the room, holds all `a` wrote in it and heard of it before it closes the room
async function settle(b, room, joined) {
  await waitUntil(async () => (await get(b.me.local.pulses, room.id)).data)
  const after = Date.now()
  await put(room.messages, { text: 'hello' })
  await waitUntil(async () => (await get(joined.messages)).data.length === 1)
  await pulsed(b, room.id, after)
  await close(joined)
}

async function scene(t, opts) {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  const a = await device(t, testnet, service)
  const b = await device(t, testnet, service, opts)
  const room = await open(a.me.team, { name: 'clinic' })
  const joined = await join(b, room)
  await followed(service, 2)
  await settle(b, room, joined)
  return { testnet, service, a, b, room }
}

// `a` holds `n` rooms `b` joined, holds all of and closed, and a client signs as a member
async function many(t, n) {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  const a = await device(t, testnet, service)
  const b = await device(t, testnet, service)
  const rooms = []
  const joins = []
  for (let i = 0; i < n; i++) {
    rooms.push(await open(a.me.team, { name: `room ${i}` }))
    joins.push(await join(b, rooms[i]))
  }
  const subs = () => [...service.server.subs.values()]
  await waitUntil(() => subs().length === n && subs().every((s) => s.size === 2))
  for (let i = 0; i < n; i++) await settle(b, rooms[i], joins[i])
  return { testnet, service, a, b, rooms, member: await client(t, testnet, service) }
}

async function client(t, testnet, service) {
  const dht = new HyperDHT({ bootstrap: testnet.bootstrap })
  const member = new PulseClient(service.key, { dht })
  t.teardown(async () => {
    await member.close()
    await dht.destroy()
  })
  return member
}

// the key a member signs a room's times with, before any rotation
function signer(room) {
  return crypto.keyPair(crypto.hash([NS, room.store.encryptionKey]))
}

// the window of the last write a device told has closed, with room for a late timer
function quiet(peer, room) {
  return waitUntil(
    async () => Date.now() > (await get(peer.me.local.pulses, room.id)).data.told + 300
  )
}

// a's announces are held, as if they had not reached the service yet
function hold(service) {
  const { server } = service
  const announce = server.announce.bind(server)
  const held = []
  server.announce = (m, channel) => held.push({ m, channel }) && Promise.resolve(false)
  return {
    held,
    // the one telling of `room`'s time from `a`, once told
    told: (peer, room, after) =>
      waitUntil(async () => {
        const { told } = await row(peer, room)
        return told >= after && held.find((h) => h.m.announce.bump === told)
      }),
    release: async (...some) => {
      server.announce = announce
      for (const { m, channel } of some) await announce(m, channel)
    }
  }
}

// as many devices follow a key
function following(service, { publicKey }) {
  return service.server.subs.get(b4a.toHex(publicKey))?.size ?? 0
}

// the key a member signs a room's times with at an epoch
function epochKey(room, epoch) {
  const entry = room.store.keyring.all().find((e) => e.epoch === epoch)
  return crypto.keyPair(crypto.hash([NS, entry.entropy]))
}

// what a device holds of a room once no other device can serve it
async function texts(peer, id) {
  const room = await open(peer.me.team, { id })
  const { data } = await get(room.messages)
  await close(room)
  return data.map((m) => m.text)
}

test('a room closed here is brought up to date when another device writes in it', async (t) => {
  const { a, b, room } = await scene(t)
  const after = Date.now()
  await put(room.messages, { text: 'dinner at 8?' })
  await pulsed(b, room.id, after)
  await a.me.close()
  t.alike(await texts(b, room.id), ['hello', 'dinner at 8?'])
})

test('a write missed while the device was off reaches it when it starts again', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  await b.me.close()
  const after = Date.now()
  await put(room.messages, { text: 'while you were out' })
  const again = await device(t, testnet, service, { dir: b.dir })
  await pulsed(again, room.id, after)
  await a.me.close()
  t.alike(await texts(again, room.id), ['hello', 'while you were out'])
})

test('a room followed since a start that heard nothing in it hears of a write made while the device was off', async (t) => {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  const a = await device(t, testnet, service)
  const room = await open(a.me.team, { name: 'clinic' })
  // joined while this device ran without pulse
  const dir = await t.tmp()
  const opts = { bootstrap: testnet.bootstrap, extensions: [], keepOpen: 0 }
  const before = await cero(dir, spec, opts)
  const joined = await open(before.team, await cero.invite(room))
  await put(room.messages, { text: 'hello' })
  await waitUntil(async () => (await get(joined.messages)).data.length === 1)
  await before.close()
  const b = await device(t, testnet, service, { dir })
  await waitUntil(async () => (await get(b.me.local.pulses, room.id)).data)
  await b.me.close()
  const after = Date.now()
  await put(room.messages, { text: 'while you were out' })
  const again = await device(t, testnet, service, { dir })
  await pulsed(again, room.id, after)
  await a.me.close()
  t.alike(await texts(again, room.id), ['hello', 'while you were out'])
})

test('writes in a room made here, before its row was read, are told', async (t) => {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  const { me } = await device(t, testnet, service)
  const after = Date.now()
  const room = await open(me.team, { name: 'clinic' })
  const { publicKey } = crypto.keyPair(crypto.hash([NS, room.store.encryptionKey]))
  await waitUntil(async () => (await service.server.lookup(publicKey))?.bumped >= after)
  t.pass('the service holds them')
})

test('writes, opens and closes go on while the service is down, and it catches up once back', async (t) => {
  const { service, a, b, room } = await scene(t)
  await service.stop()
  await close(room)
  const reopened = await open(a.me.team, { id: room.id })
  const after = Date.now()
  await put(reopened.messages, { text: 'down' })
  await service.start()
  await pulsed(b, room.id, after)
  await a.me.close()
  t.alike(await texts(b, room.id), ['hello', 'down'])
})

test('a write told as the connection went down is told again on the next one', async (t) => {
  const { service, a, b, room } = await scene(t)
  const { stats } = service.server
  const closed = async () => Date.now() > (await get(a.me.local.pulses, room.id)).data.told + 300
  await waitUntil(closed)
  // b counts all a told so far as brought up to date: only the time told again can wake it
  const { told: last } = (await get(a.me.local.pulses, room.id)).data
  await waitUntil(async () => (await get(b.me.local.pulses, room.id)).data.since >= last)
  const before = stats.onannounceCount
  // the service drops it, as a connection that died unnoticed does
  service.server.announce = async () => false
  const after = Date.now()
  await put(room.messages, { text: 'lost on the way' })
  await waitUntil(() => stats.onannounceCount > before)
  // and no later one tells of it
  await waitUntil(closed)
  await service.stop()
  await service.start()
  await pulsed(b, room.id, after)
  await a.me.close()
  t.alike(await texts(b, room.id), ['hello', 'lost on the way'])
})

test("a write told the same ms as another device's is told again", async (t) => {
  const { testnet, service, a, room } = await scene(t)
  const keyPair = crypto.keyPair(crypto.hash([NS, room.store.encryptionKey]))
  const dht = new HyperDHT({ bootstrap: testnet.bootstrap })
  const other = new PulseClient(service.key, { dht })
  t.teardown(async () => {
    await other.close()
    await dht.destroy()
  })
  const { server } = service
  const announce = server.announce.bind(server)
  const held = []
  let mine = 0
  server.announce = (m, channel) => {
    if (mine && m.announce.bump === mine && !held.some((h) => h.channel === channel)) {
      return announce(m, channel)
    }
    held.push({ m, channel })
    return Promise.resolve(false)
  }
  const after = Date.now()
  await put(room.messages, { text: 'mine' })
  mine = await waitUntil(async () => {
    const { told } = (await get(a.me.local.pulses, room.id)).data
    return told >= after && held.some((h) => h.m.announce.bump === told) && told
  })
  const { channel } = held.find((h) => h.m.announce.bump === mine)
  // the other device's lands first, at the same time: this one's is dropped
  other.announce(keyPair, { bump: mine })
  const stored = async () => (await server.lookup(keyPair.publicKey))?.bumped
  await waitUntil(async () => (await stored()) === mine)
  await waitUntil(() => held.some((h) => h.channel === channel && h.m.announce.bump > mine))
  for (const h of held) if (h.channel === channel) await announce(h.m, h.channel)
  t.ok((await stored()) > mine, 'told again, past it')
})

test('writes in a row are told at most once in 100 ms, the last once the window closes', async (t) => {
  const { service, a, b, room } = await scene(t)
  // the window of the last write told has closed
  await waitUntil(async () => Date.now() > (await get(a.me.local.pulses, room.id)).data.told + 300)
  const { server } = service
  const announce = server.announce.bind(server)
  let dropped = 0
  // the first is lost: only the one after the window tells of the last writes
  server.announce = (m, channel) => (dropped++ ? announce(m, channel) : Promise.resolve(false))
  const after = Date.now()
  for (let i = 0; i < 10; i++) await put(room.messages, { text: `#${i}` })
  const took = Date.now() - after
  await pulsed(b, room.id, after)
  t.ok(dropped <= Math.ceil(took / 100) + 1, `${dropped} told for 10 writes in ${took} ms`)
})

test('a device not in the room cannot wake it', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  const dht = new HyperDHT({ bootstrap: testnet.bootstrap })
  const stranger = new PulseClient(service.key, { dht })
  t.teardown(async () => {
    await stranger.close()
    await dht.destroy()
  })
  // all a stranger can know of the room: its id, which is its key, and its topic
  const bump = Date.now() + 30000
  const keys = [room.store.key, room.store.discoveryKey].map((k) =>
    crypto.keyPair(crypto.hash([NS, k]))
  )
  for (const keyPair of keys) stranger.announce(keyPair, { bump })
  const kept = async ({ publicKey }) => (await service.server.lookup(publicKey))?.bumped === bump
  await waitUntil(async () => (await kept(keys[0])) && (await kept(keys[1])))
  const after = Date.now()
  await put(room.messages, { text: 'from a member' })
  await pulsed(b, room.id, after)
  t.ok((await row(b, room)).since < bump, 'woken by the member, never by the stranger')
  t.ok((await row(a, room)).since < bump)
})

test("the device's own time, kept by the service, wakes nothing after a restart", async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  const after = Date.now()
  await put(room.messages, { text: 'mine' })
  await pulsed(b, room.id, after)
  await close(room)
  await a.me.close()
  const again = await device(t, testnet, service, { dir: a.dir })
  await followed(service, 2)
  // the service answers a later subscription after this one's
  const probe = await client(t, testnet, service)
  let back = false
  probe.on('announce', () => (back = true))
  probe.subscribe(signer(room).publicKey, { since: 0 })
  await waitUntil(() => back)
  t.alike(again.loads, [], 'no wake for it')
})

test('heard never moves on a write made here', async (t) => {
  const { a, room } = await scene(t)
  const { heard } = await row(a, room)
  await put(room.messages, { text: 'mine' })
  await waitUntil(async () => (await row(a, room)).told > heard)
  t.is((await row(a, room)).heard, heard)
  t.absent(a.pulses.find((p) => p.heard > heard))
})

test('a write that lands before its time arrives moves heard and wakes nothing', async (t) => {
  const { service, a, b, room } = await scene(t)
  const there = await open(b.me.team, { id: room.id })
  const holding = hold(service)
  const after = Date.now()
  await put(room.messages, { text: 'direct' })
  const told = await holding.told(a, room, after)
  await waitUntil(async () => (await get(there.messages)).data.some((m) => m.text === 'direct'))
  await pulsed(b, room.id, after)
  const loads = b.loads.length
  await holding.release(told)
  await waitUntil(async () => (await row(b, room)).since >= told.m.announce.bump)
  t.is(b.loads.length, loads, 'its time counts as brought up to date, no wake')
})

test('a room followed for the first time wakes nothing and tells nothing', async (t) => {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  const a = await device(t, testnet, service)
  const room = await open(a.me.team, { name: 'clinic' })
  const dir = await t.tmp()
  const opts = { bootstrap: testnet.bootstrap, extensions: [], keepOpen: 0 }
  const before = await cero(dir, spec, opts)
  const joined = await open(before.team, await cero.invite(room))
  await put(room.messages, { text: 'hello' })
  await waitUntil(async () => (await get(joined.messages)).data.length === 1)
  await before.close()
  const b = await device(t, testnet, service, { dir })
  await followed(service, 2)
  const probe = await client(t, testnet, service)
  let back = false
  probe.on('announce', () => (back = true))
  probe.subscribe(signer(room).publicKey, { since: 0 })
  await waitUntil(() => back)
  t.alike(b.loads, [], 'no wake for what the service kept')
  t.is((await row(b, room)).told, 0, 'nothing told')
  const after = Date.now()
  await put(room.messages, { text: 'next' })
  await pulsed(b, room.id, after)
})

test('a room only a mirror holds the write of is brought up to date', async (t) => {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  const mirror = await makeMirror(t, testnet)
  const opts = { mirrors: [mirror.publicKey] }
  const a = await device(t, testnet, service, opts)
  const b = await device(t, testnet, service, opts)
  const room = await open(a.me.team, { name: 'clinic' })
  const joined = await join(b, room)
  await followed(service, 2)
  await settle(b, room, joined)
  const holding = hold(service)
  const after = Date.now()
  await put(room.messages, { text: 'mirrored' })
  const told = await holding.told(a, room, after)
  const core = mirror.store.get({ key: room.store.writerKey })
  await core.ready()
  const { length } = room.store
  await waitUntil(() => core.contiguousLength >= length, 30000)
  await core.close()
  // its writer is gone as its time is told
  await a.me.close()
  await holding.release(told)
  await pulsed(b, room.id, after)
  t.ok(b.loads.includes(room.id), 'woken, the mirror its one source')
})

test('a write that lands as the device resumes is told', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  // started again, it has told nothing in this run
  await a.me.close()
  const again = await device(t, testnet, service, { dir: a.dir })
  const there = await open(again.me.team, { id: room.id })
  await followed(service, 2)
  await cero.suspend(again.me)
  const after = Date.now()
  const writing = put(there.messages, { text: 'good morning' })
  await cero.resume(again.me)
  await writing
  await pulsed(b, room.id, after)
  await again.me.close()
  t.alike(await texts(b, room.id), ['hello', 'good morning'])
})

test('a suspended device hears of a write once it resumes', async (t) => {
  const { service, a, b, room } = await scene(t)
  const followers = () => Math.max(...[...service.server.subs.values()].map((subs) => subs.size))
  await cero.suspend(b.me)
  await waitUntil(() => followers() < 2)
  const after = Date.now()
  await put(room.messages, { text: 'while asleep' })
  const { publicKey } = crypto.keyPair(crypto.hash([NS, room.store.encryptionKey]))
  await waitUntil(async () => (await service.server.lookup(publicKey))?.bumped >= after)
  t.is(followers(), 1, 'asleep, it holds no connection to the service')
  await cero.resume(b.me)
  // it connects again as it resumes, not when a retry comes round
  await waitUntil(() => b.pulses.find((p) => p.id === room.id && p.heard >= after), 3000)
  await a.me.close()
  t.alike(await texts(b, room.id), ['hello', 'while asleep'])
})

test('after wakes nobody served, a later write in another room is still woken', async (t) => {
  const { testnet, service, a, b, rooms, member } = await many(t, 5)
  await a.me.close()
  const done = new Map()
  b.me.on('handle', (child) => child.once('close', () => done.set(child.id, true)))
  for (const room of rooms.slice(0, 4)) member.announce(signer(room), { bump: Date.now() + 1000 })
  await waitUntil(() => rooms.slice(0, 4).every((room) => done.get(room.id)), 30000)
  const back = await device(t, testnet, service, { dir: a.dir })
  const last = rooms[4]
  const there = await open(back.me.team, { id: last.id })
  await followed(service, 2)
  const after = Date.now()
  await put(there.messages, { text: 'later' })
  await pulsed(b, last.id, after)
})

test('a room whose wake nobody served is woken again by a newer time', async (t) => {
  const { a, b, rooms, member } = await many(t, 1)
  const [room] = rooms
  await a.me.close()
  const before = b.loads.length
  let closed = 0
  b.me.on('handle', (child) => child.once('close', () => closed++))
  member.announce(signer(room), { bump: Date.now() + 1000 })
  await waitUntil(() => closed === 1, 30000)
  member.announce(signer(room), { bump: Date.now() + 2000 })
  await waitUntil(() => closed === 2, 30000)
  t.is(b.loads.slice(before).length, 2, 'woken twice on one connection')
})

test('of the rooms a connection brings as due, at most 32 are woken', async (t) => {
  const { testnet, service, a, b, rooms } = await many(t, 34)
  await b.me.close()
  const after = Date.now()
  for (const room of rooms) await put(room.messages, { text: 'while you were out' })
  await waitUntil(async () => {
    for (const room of rooms) if ((await row(a, room)).told < after) return false
    return true
  })
  const again = await device(t, testnet, service, { dir: b.dir })
  let open = 0
  again.me.on('handle', (child) => (open++, child.once('close', () => open--)))
  await waitUntil(() => new Set(again.pulses.map((p) => p.id)).size >= 32, 60000)
  await waitUntil(() => open === 0, 30000)
  t.is(new Set(again.loads).size, 32)
})

test('heard: the row of a room moves as a write from another device lands, and is kept over a restart', async (t) => {
  const { testnet, service, b, room } = await scene(t)
  const row = async (peer) => (await get(peer.me.local.pulses, room.id)).data
  const first = await row(b)
  t.ok(first.heard > 0, 'the write it heard of in the room')

  const after = Date.now()
  await put(room.messages, { text: 'news' })
  for await (const { data } of cero.watch(b.me.local.pulses)) {
    if (data.some((r) => r.id === room.id && r.heard >= after)) break
  }
  t.pass('a watch of the table shows it, the room closed here')

  await b.me.close()
  const again = await device(t, testnet, service, { dir: b.dir })
  const kept = await row(again)
  t.ok(kept.heard >= after, 'kept over a restart')
})

test('a rotation after a removal moves the room to a key the removed member cannot sign for, and a device off meanwhile follows it there', async (t) => {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  const a = await device(t, testnet, service)
  const b = await device(t, testnet, service)
  const c = await device(t, testnet, service)
  const room = await open(a.me.team, { name: 'clinic' })
  const joined = await join(b, room)
  await close(await join(c, room))
  await followed(service, 3)
  await settle(b, room, joined)
  const old = signer(room)
  const subs = ({ publicKey }) => service.server.subs.get(b4a.toHex(publicKey))?.size ?? 0

  await b.me.close()
  await cero.del(room.members, c.me.identity.id)
  const epochs = room.store.keyring.all()
  const fresh = crypto.keyPair(crypto.hash([NS, epochs[epochs.length - 1].entropy]))
  // the removed member alone may follow the old key until it next opens the room
  await waitUntil(() => subs(fresh) === 1 && subs(old) <= 1)
  t.pass('a follows the newest epoch, and not the old key')

  // it keeps a woken room open for a while, as an app does by default, so it syncs on
  const again = await device(t, testnet, service, { dir: b.dir, keepOpen: 16 })
  await waitUntil(() => subs(fresh) === 2, 30000)
  t.ok(
    again.pulses.some((p) => p.id === room.id),
    'woken by the last time on the old key, it learned the epoch and moved'
  )

  // all the removed member can sign for is the old key
  const removed = await client(t, testnet, service)
  const bump = Date.now() + 30000
  removed.announce(old, { bump })
  await waitUntil(async () => (await service.server.lookup(old.publicKey))?.bumped === bump)
  const after = Date.now()
  await put(room.messages, { text: 'after the removal' })
  await pulsed(again, room.id, after)
  t.ok((await row(again, room)).since < bump, 'woken by the member, on the new key')
  t.ok((await row(a, room)).since < bump, 'never by the removed one')
})

test('two rotations while a device was off: it hears the last time on its key, then follows the newest', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  const old = signer(room)
  await b.me.close()
  await cero.rotate(room)
  await cero.rotate(room)
  const fresh = epochKey(room, 2)
  await waitUntil(
    () =>
      following(service, fresh) === 1 &&
      following(service, old) === 0 &&
      following(service, epochKey(room, 1)) === 0
  )
  // it keeps a woken room open for a while, as an app does by default, so it syncs on
  const again = await device(t, testnet, service, { dir: b.dir, keepOpen: 16 })
  await waitUntil(() => following(service, fresh) === 2, 30000)
  t.ok(again.loads.includes(room.id), 'woken on the key it held, it learned both and moved')
  t.is((await row(again, room)).epoch, 2)
})

test('a write told on an old key is told again on the newest', async (t) => {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  const a = await device(t, testnet, service)
  const b = await device(t, testnet, service)
  const c = await device(t, testnet, service)
  const room = await open(a.me.team, { name: 'clinic' })
  const joined = await join(b, room)
  const seen = await join(c, room)
  await followed(service, 3)
  await settle(b, room, joined)
  await b.me.close()
  // c holds the room as it rotates, learns the epoch, moves, and closes it
  await cero.rotate(room)
  const fresh = epochKey(room, 1)
  await waitUntil(() => following(service, fresh) === 2, 30000)
  await close(seen)
  await a.me.close()
  // b, on the old key, writes where nobody serves it the new one
  const again = await device(t, testnet, service, { dir: b.dir })
  const there = await open(again.me.team, { id: room.id })
  const after = Date.now()
  await put(there.messages, { text: 'on the old key' })
  await waitUntil(async () => (await row(again, room)).told >= after)
  const back = await device(t, testnet, service, { dir: a.dir })
  await open(back.me.team, { id: room.id })
  await pulsed(c, room.id, after)
  t.pass('told again on the new key once it learned it')
})

test('a write from another device that lands while the app holds the room counts as heard', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  const { server } = service
  const announce = server.announce.bind(server)
  const held = []
  server.announce = (m, channel) => held.push({ m, channel }) && Promise.resolve(false)
  const after = Date.now()
  await put(room.messages, { text: 'later' })
  const told = await waitUntil(async () => {
    const { told } = (await get(a.me.local.pulses, room.id)).data
    return told >= after && held.find((h) => h.m.announce.bump === told)
  })
  // no device serves it as its wake waits
  await a.me.close()
  server.announce = announce
  const woken = new Promise((resolve) =>
    b.me.once('handle', (child) => child.once('close', resolve))
  )
  await announce(told.m, told.channel)
  await woken
  const back = await device(t, testnet, service, { dir: a.dir })
  const there = await open(back.me.team, { id: room.id })
  const mine = await open(b.me.team, { id: room.id })
  await waitUntil(async () => (await get(mine.messages)).data.some((m) => m.text === 'later'))
  const v = told.m.announce.bump
  await waitUntil(async () => (await get(b.me.local.pulses, room.id)).data.heard >= v)
  const loads = b.loads.length
  await service.stop()
  await service.start()
  await followed(service, 2)
  const probe = await client(t, testnet, service)
  let kept = false
  probe.on('announce', () => (kept = true))
  probe.subscribe(signer(room).publicKey, { since: 0 })
  await waitUntil(() => kept)
  t.is(b.loads.length, loads, 'the next connection does not wake it for what it holds')
})

test('a write made with no service and killed before it was told is told at the next start', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  await a.me.close()
  await service.stop()
  const args = [
    CLOSE,
    a.dir,
    JSON.stringify(testnet.bootstrap),
    b4a.toHex(service.key),
    'owe',
    room.id
  ]
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve) =>
    child.stdout.on('data', (data) => b4a.toString(data).includes('owed') && resolve())
  )
  child.kill('SIGKILL')
  await new Promise((resolve) => child.on('exit', resolve))
  await service.start()
  const after = Date.now()
  const back = await device(t, testnet, service, { dir: a.dir })
  await open(back.me.team, { id: room.id })
  await pulsed(b, room.id, after)
  await back.me.close()
  t.ok((await texts(b, room.id)).includes('offline'))
})

test('a clock that was ahead does not hold the time told ahead', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  await a.me.close()
  // as a run with its clock ahead left it
  const ahead = Date.now() + 30000
  const before = await cero(a.dir, spec, { bootstrap: testnet.bootstrap, extensions: [] })
  const kept = (await get(before.local.pulses, room.id)).data
  await cero.set(before.local.pulses, { ...kept, told: ahead })
  await before.close()
  const again = await device(t, testnet, service, { dir: a.dir })
  const there = await open(again.me.team, { id: room.id })
  const after = Date.now()
  await put(there.messages, { text: 'now' })
  await waitUntil(async () => (await row(again, room)).told >= after)
  const { told } = await row(again, room)
  t.ok(told < ahead, 'told at the time it is')
  await waitUntil(
    async () => (await service.server.lookup(signer(room).publicKey))?.bumped === told
  )
  await pulsed(b, room.id, after)
})

test("a 'pulse' listener or an onerror that throws stops nothing", async (t) => {
  const { a, b, room } = await scene(t, {
    onerror: () => {
      throw new Error('onerror')
    }
  })
  b.me.on('pulse', () => {
    throw new Error('listener')
  })
  for (const text of ['one', 'two']) {
    await quiet(a, room)
    const after = Date.now()
    await put(room.messages, { text })
    await pulsed(b, room.id, after)
  }
  t.pass('both heard')
})

test('a wake that races a leave reports nothing and puts back no row', async (t) => {
  const errors = []
  const { a, b, room } = await scene(t, { onerror: (err) => errors.push(err) })
  // the topics rows pulse reads lag behind the leave
  const emit = b.me.emit.bind(b.me)
  let late = true
  b.me.emit = (name, ...args) => (name === 'topics' && late ? true : emit(name, ...args))
  const load = b.me._load.bind(b.me)
  let tried = null
  b.me._load = (...args) => (tried = load(...args))
  await leave(await open(b.me.team, { id: room.id }))
  await waitUntil(async () => !(await b.me.store.get('handles', room.id)).data?.encryptionKey)
  tried = null
  await put(room.messages, { text: 'after the leave' })
  await waitUntil(() => !!tried)
  await tried.catch(() => {})
  late = false
  b.me.emit('topics')
  await waitUntil(async () => !(await get(b.me.local.pulses, room.id)).data)
  t.alike(
    errors.map((err) => err.code),
    [],
    'no error for a room no longer its'
  )
})

test('a write of this device a reorder applies again is not told again', async (t) => {
  const { service, a, b, room } = await scene(t)
  await quiet(a, room)
  const { server } = service
  const announce = server.announce.bind(server)
  const told = []
  server.announce = (m, channel) => (told.push(m.announce.bump), announce(m, channel))
  const { writerKey, length } = room.store
  room.store.emit('apply', { op: 'add', name: 'messages', row: null, writerKey, length, seq: -1 })
  const after = Date.now()
  await put(room.messages, { text: 'new' })
  await pulsed(b, room.id, after)
  await quiet(a, room)
  t.is(told.length, 1, 'the new write alone')
})

test('a time the service sends twice as a subscription opens wakes once', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  await b.me.close()
  // the lookup of a new subscription waits for the announce the service takes meanwhile
  const { server } = service
  const lookup = server.lookup.bind(server)
  const announce = server.announce.bind(server)
  let release = null
  const taken = new Promise((resolve) => (release = resolve))
  server.lookup = async (key) => (await taken, lookup(key))
  server.announce = async (m, channel) => {
    const kept = await announce(m, channel)
    release()
    return kept
  }
  const again = await device(t, testnet, service, { dir: b.dir })
  await followed(service, 2)
  const after = Date.now()
  await put(room.messages, { text: 'twice' })
  await pulsed(again, room.id, after)
  await quiet(a, room)
  const later = Date.now()
  await put(room.messages, { text: 'later' })
  await pulsed(again, room.id, later)
  t.is(again.loads.filter((id) => id === room.id).length, 2, 'one wake for each time')
})

test('a write made while the network is suspended is told once it resumes', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  // started again, it has told nothing on its connection
  await a.me.close()
  const again = await device(t, testnet, service, { dir: a.dir })
  const there = await open(again.me.team, { id: room.id })
  await followed(service, 2)
  // the network alone: storage still takes the write
  await again.me.network.suspend()
  again.me.emit('status')
  await waitUntil(() => [...service.server.subs.values()].every((subs) => subs.size < 2))
  const after = Date.now()
  await put(there.messages, { text: 'meanwhile' })
  await again.me.network.resume()
  again.me.emit('status')
  await pulsed(b, room.id, after)
  await again.me.close()
  t.ok((await texts(b, room.id)).includes('meanwhile'))
})

test('a time the service sends twice wakes once, and a wake nobody serves gives its notice up', async (t) => {
  const { testnet, service, b, room } = await scene(t)
  await b.me.close()
  // the lookup of a new subscription waits for the announce the service takes meanwhile
  const { server } = service
  const lookup = server.lookup.bind(server)
  const announce = server.announce.bind(server)
  // a time with no write behind it
  const bump = Date.now() + 1000
  let release = null
  const taken = new Promise((resolve) => (release = resolve))
  server.lookup = async (key) => (await taken, lookup(key))
  server.announce = async (m, channel) => {
    const kept = await announce(m, channel)
    if (m.announce.bump === bump) release()
    return kept
  }
  const again = await device(t, testnet, service, { dir: b.dir })
  let closed = 0
  again.me.on('handle', (child) => child.once('close', () => closed++))
  await followed(service, 2)
  const { heard } = await row(again, room)
  const member = await client(t, testnet, service)
  member.announce(signer(room), { bump })
  await waitUntil(() => closed === 1, 30000)
  await waitUntil(() => again.loads.length >= 1)
  t.is(again.loads.length, 1, 'one wake for it on this connection')
  await waitUntil(async () => (await row(again, room)).since >= bump)
  t.is((await row(again, room)).heard, heard, 'no connection brings it again, heard as it was')
})

test('a room whose write lands as its wake waits its turn is not woken', async (t) => {
  const { a, b, rooms, member } = await many(t, 5)
  const last = rooms[4]
  const start = b.loads.length
  let closed = 0
  b.me.on('handle', (child) => child.id !== last.id && child.once('close', () => closed++))
  // four wakes with no write behind them hold every turn
  for (const room of rooms.slice(0, 4)) member.announce(signer(room), { bump: Date.now() + 1000 })
  await waitUntil(() => b.loads.length >= start + 4)
  const after = Date.now()
  await put(last.messages, { text: 'waits its turn' })
  await waitUntil(async () => (await row(a, last)).told >= after)
  // the app opens it meanwhile: the write lands
  const there = await open(b.me.team, { id: last.id })
  await pulsed(b, last.id, after)
  const loads = b.loads.filter((id) => id === last.id).length
  await waitUntil(() => closed === 4, 30000)
  t.is(b.loads.filter((id) => id === last.id).length, loads, 'no wake for it')
  await close(there)
})

test('the newest due is woken first', async (t) => {
  const { a, b, rooms, member } = await many(t, 6)
  await a.me.close()
  const start = b.loads.length
  const at = Date.now() + 1000
  for (const room of rooms.slice(0, 4)) member.announce(signer(room), { bump: at })
  await waitUntil(() => b.loads.length >= start + 4)
  member.announce(signer(rooms[4]), { bump: at + 1 })
  member.announce(signer(rooms[5]), { bump: at + 2 })
  await waitUntil(() => b.loads.length >= start + 5, 30000)
  t.is(b.loads[start + 4], rooms[5].id, 'the newer of the two waiting')
})

test('a rotation made while the service was down is told on the old key once it is back', async (t) => {
  const { testnet, service, b, room } = await scene(t)
  const old = signer(room)
  await b.me.close()
  await service.stop()
  await cero.rotate(room)
  const fresh = epochKey(room, 1)
  await service.start()
  await waitUntil(() => following(service, fresh) === 1)
  // it keeps a woken room open for a while, as an app does by default, so it syncs on
  const again = await device(t, testnet, service, { dir: b.dir, keepOpen: 16 })
  await waitUntil(() => following(service, fresh) === 2, 30000)
  t.is(following(service, old), 0)
})

test('the last write of a window that closes with the network suspended is told once it resumes', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  // started again, it has told nothing on its connection
  await a.me.close()
  const again = await device(t, testnet, service, { dir: a.dir })
  const there = await open(again.me.team, { id: room.id })
  await followed(service, 2)
  await put(there.messages, { text: 'one' })
  await put(there.messages, { text: 'two' })
  await again.me.network.suspend()
  again.me.emit('status')
  await waitUntil(async () => (await row(again, room)).owed)
  await again.me.network.resume()
  again.me.emit('status')
  await waitUntil(async () => !(await row(again, room)).owed)
  const { told } = await row(again, room)
  await waitUntil(async () => (await row(b, room)).since >= told)
  t.pass('b heard of the last one')
})

test('of thousands of rooms a connection brings as due 32 wake, the rest give their notice up, and the next brings none', async (t) => {
  const { testnet, service, b, room } = await scene(t)
  const n = 3000
  // rows of handles this device holds no keys of: a wake of one ends at once
  const fake = []
  for (let i = 0; i < n; i++) {
    const handle = b4a.toHex(crypto.randomBytes(32))
    const encryptionKey = crypto.randomBytes(32)
    fake.push({
      id: handle,
      handle,
      type: 'team',
      key: null,
      name: null,
      encryptionKey,
      epochs: null
    })
  }
  const { store } = b.me.local
  const read = store.get.bind(store)
  store.get = async (name, ...rest) => {
    const res = await read(name, ...rest)
    if (name !== 'topics' || rest.length > 0) return res
    return { ...res, data: [...res.data, ...fake] }
  }
  b.me.emit('topics')
  const signers = fake.map((f) => crypto.keyPair(crypto.hash([NS, f.encryptionKey])))
  const last = signers[n - 1]
  await waitUntil(() => following(service, last) === 1, 60000)
  await b.me.network.suspend()
  b.me.emit('status')
  await waitUntil(() => following(service, last) === 0)
  const member = await client(t, testnet, service)
  // a time kept from before the connection opens
  const bump = Date.now()
  for (const s of signers) member.announce(s, { bump })
  await waitUntil(async () => (await service.server.lookup(last.publicKey))?.bumped === bump, 60000)
  const ids = new Set(fake.map((f) => f.handle))
  const woken = () => new Set(b.loads.filter((id) => ids.has(id)))
  // how long the event loop is held at most as they drain
  let longest = 0
  let tick = Date.now()
  const timer = setInterval(() => {
    longest = Math.max(longest, Date.now() - tick)
    tick = Date.now()
  }, 5)
  const start = Date.now()
  await b.me.network.resume()
  b.me.emit('status')
  const given = async (f) => (await get(b.me.local.pulses, f.handle)).data?.since >= bump
  await waitUntil(() => given(fake[n - 1]), 60000)
  // the wake of a handle this device holds no keys of ends at once: each connection wakes it again
  const first = woken()
  for (const f of fake) if (!first.has(f.handle)) await waitUntil(() => given(f))
  const took = Date.now() - start
  clearInterval(timer)
  t.is(first.size, 32, 'woken')
  t.ok(longest < 500, `${n} drained in ${took} ms, the loop held ${longest} ms at most`)
  // the next connection: a time for the one room it holds comes after all the service kept
  await b.me.network.suspend()
  b.me.emit('status')
  await waitUntil(() => following(service, last) === 0)
  await b.me.network.resume()
  b.me.emit('status')
  await waitUntil(() => following(service, last) === 1, 60000)
  const before = b.loads.length
  member.announce(signer(room), { bump: Date.now() + 1000 })
  await waitUntil(() => b.loads.slice(before).includes(room.id), 30000)
  t.alike(woken(), first, 'none of the others woken')
})

test('a write made offline after one told online wakes nothing here as the service sends the one told', async (t) => {
  const { a, b, room } = await scene(t)
  await quiet(a, room)
  // past a write from another device that landed lately, a time is no longer taken for it
  await waitUntil(async () => Date.now() > (await row(a, room)).heard + 5000, 30000)
  await a.me.network.suspend()
  a.me.emit('status')
  await put(room.messages, { text: 'offline' })
  await waitUntil(async () => (await row(a, room)).owed)
  const before = a.loads.length
  const after = Date.now()
  await a.me.network.resume()
  a.me.emit('status')
  await pulsed(b, room.id, after)
  t.is(a.loads.length, before, 'no wake for its own time')
})

test('a write owed, told below a time the service holds ahead of this clock, is told once more past it', async (t) => {
  const { testnet, service, a, room } = await scene(t)
  await quiet(a, room)
  await a.me.network.suspend()
  a.me.emit('status')
  await waitUntil(() => following(service, signer(room)) === 1)
  const kept = async () => (await service.server.lookup(signer(room).publicKey))?.bumped
  // told by a device with its clock ahead of this one's
  const ahead = Date.now() + 20000
  const member = await client(t, testnet, service)
  member.announce(signer(room), { bump: ahead })
  await waitUntil(async () => (await kept()) === ahead)
  await put(room.messages, { text: 'offline' })
  await waitUntil(async () => (await row(a, room)).owed)
  await a.me.network.resume()
  a.me.emit('status')
  await waitUntil(async () => (await kept()) > ahead)
  const { told } = await row(a, room)
  t.ok(told > ahead, 'told past it')
  // a later time is another device's: this one tells nothing for it
  const before = a.loads.length
  member.announce(signer(room), { bump: ahead + 1000 })
  await waitUntil(async () => a.loads.length > before || (await row(a, room)).since >= ahead + 1000)
  t.is((await row(a, room)).told, told, 'told once')
})

test('writes from another device landing in a row are kept and told to the app at most once a second, the last as it ends', async (t) => {
  const { a, b, room } = await scene(t)
  const there = await open(b.me.team, { id: room.id })
  const start = b.pulses.length
  const after = Date.now()
  for (let i = 0; i < 20; i++) await put(room.messages, { text: `#${i}` })
  const wrote = Date.now()
  await pulsed(b, room.id, wrote)
  const took = Date.now() - after
  const told = b.pulses.slice(start).length
  t.ok(told <= Math.ceil(took / 1000) + 1, `${told} told for 20 writes landing in ${took} ms`)
  t.ok((await row(b, room)).heard >= wrote, 'the last kept')
  await close(there)
})

test('the last landing of a window is kept as the app closes', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  const there = await open(b.me.team, { id: room.id })
  await waitUntil(() => Date.now() > b.pulses.at(-1).heard + 1500)
  const after = Date.now()
  await put(room.messages, { text: 'one' })
  await pulsed(b, room.id, after)
  const first = b.pulses.at(-1).heard
  await put(room.messages, { text: 'two' })
  await waitUntil(async () => (await get(there.messages)).data.length === 3)
  await b.me.close()
  const again = await device(t, testnet, service, { dir: b.dir })
  t.ok((await row(again, room)).heard > first, 'kept')
})

test('a write from another device a reorder applies again does not move heard', async (t) => {
  const { a, b, room } = await scene(t)
  const there = await open(b.me.team, { id: room.id })
  const after = Date.now()
  await put(room.messages, { text: 'one' })
  await pulsed(b, room.id, after)
  // its window and the one after it closed
  await waitUntil(() => Date.now() > b.pulses.at(-1).heard + 2500)
  const count = b.pulses.length
  const { writerKey, length } = room.store
  const again = Date.now()
  there.store.emit('apply', { op: 'add', name: 'messages', row: null, writerKey, length, seq: -1 })
  await waitUntil(() => Date.now() > again + 1500)
  t.is(b.pulses.length, count, 'nothing heard')
  await close(there)
})

test('a write told just before the app stopped, on a link that dropped it, is told again at the next start', async (t) => {
  const { testnet, service, a, b, room } = await scene(t)
  await quiet(a, room)
  // b counts all a told so far as brought up to date: only the time told again can wake it
  const { told: last } = await row(a, room)
  await waitUntil(async () => (await row(b, room)).since >= last)
  const { server } = service
  const announce = server.announce.bind(server)
  const before = server.stats.onannounceCount
  server.announce = async () => false
  const after = Date.now()
  await put(room.messages, { text: 'lost on the way' })
  await waitUntil(() => server.stats.onannounceCount > before)
  await a.me.close()
  server.announce = announce
  const back = await device(t, testnet, service, { dir: a.dir })
  await open(back.me.team, { id: room.id })
  await pulsed(b, room.id, after)
  await back.me.close()
  t.ok((await texts(b, room.id)).includes('lost on the way'))
})

test('a room left is followed no more', async (t) => {
  const { service, b, room } = await scene(t)
  t.ok((await get(b.me.local.pulses, room.id)).data, 'followed')
  await leave(await open(b.me.team, { id: room.id }))
  await waitUntil(async () => !(await get(b.me.local.pulses, room.id)).data)
  await waitUntil(() => [...service.server.subs.values()].every((subs) => subs.size < 2))
  t.pass('its row and its subscription are gone')
})

test('pulse: a key that is no key, or a spec built without it, is refused', async (t) => {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  const opts = { bootstrap: testnet.bootstrap }
  await t.exception(cero(await t.tmp(), spec, { ...opts, extensions: [pulse('nope')] }), /INVALID/)
  await t.exception(
    cero(await t.tmp(), plain, { ...opts, extensions: [pulse(service.key)] }),
    /INVALID/
  )
})

test('a setup that runs once the root began to close follows nothing', async (t) => {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  const { me } = await device(t, testnet, service)
  await me.close()
  const stop = await pulse(service.key).setup(me)
  stop()
  t.is(typeof stop, 'function')
})

// ms the process lives on after cero() closed or failed
async function outlives(t, testnet, mode, key) {
  const args = [CLOSE, await t.tmp(), JSON.stringify(testnet.bootstrap), b4a.toHex(key), mode, '-']
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] })
  let closed = 0
  child.stdout.on('data', (data) => b4a.toString(data).includes('closed') && (closed = Date.now()))
  await new Promise((resolve) => child.on('exit', resolve))
  t.ok(closed, 'closed')
  return Date.now() - closed
}

// the network's own caps hold a process up to ~750 ms past its close
const HELD = 1500

test('close leaves nothing to keep the process alive, the service up or down', async (t) => {
  const testnet = await makeTestnet(t)
  const service = await makePulse(t, testnet)
  for (const [mode, key] of [
    ['write', service.key],
    ['write', crypto.keyPair().publicKey],
    ['throw', crypto.keyPair().publicKey],
    ['wake', service.key]
  ]) {
    const ms = await outlives(t, testnet, mode, key)
    t.ok(ms < HELD, `${mode}: exited ${ms} ms after`)
  }
})
