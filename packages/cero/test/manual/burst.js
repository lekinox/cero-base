// Rooms under load, outside the suite: one device is in every room, far more than it announces at once, and
// other devices hold a few of them each. Writes land in rooms picked at random, and every one has to reach the
// device within the scenario's bound. `npm run test:burst` runs them all, `SCENARIO=lone,closed npm run test:burst` those.

import test from 'brittle'
import process from 'process'
import { cero } from '../../src/index.js'
import { put, open, close, watch } from '../../src/lib/operators.js'
import { bundled, pulse } from '../../src/extensions/index.js'
import { spec } from '../fixtures/spec/index.js'
import { spec as pulsing } from '../fixtures/spec/pulse/index.js'
import { makeTestnet, makePulse, waitUntil } from '../helpers/index.js'

const SCENARIOS = {
  // a few rooms written by apps that just started: no burst brings the device's other rooms on the network
  lone: { rooms: 100, peers: 20, writes: 10, only: 5, restart: true, within: 10000 },
  restart: { rooms: 100, peers: 20, writes: 200, restart: true, within: 60000 },
  connected: { rooms: 100, peers: 20, writes: 200, within: 10000 },
  // more devices write at once than a device keeps connections by default: this one keeps more
  crowd: { rooms: 160, peers: 80, writes: 160, restart: true, within: 30000, connections: 200 },
  // the device keeps every room closed and runs pulse: each write is on it before the app opens a room
  closed: { rooms: 100, peers: 20, writes: 200, restart: true, within: 30000, closed: true }
}
// the writes land at random moments over this long
const SPREAD = 10000
const SEED = Number(process.env.SEED || 1)
const GROUP = 20
const picked = process.env.SCENARIO ? process.env.SCENARIO.split(',') : Object.keys(SCENARIOS)

test.configure({ timeout: 600000 })

function rng(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function summary(delays) {
  const sorted = [...delays].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return `p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${sorted[sorted.length - 1]} ms`
}

for (const name of picked) {
  const {
    rooms: count,
    peers: devices,
    writes,
    only = 0,
    restart = false,
    within,
    connections = 40,
    closed = false
  } = SCENARIOS[name]

  test(`${name}: ${writes} writes in ${only || count} of ${count} rooms, ${devices} devices${restart ? ', each app starts then writes' : ''}`, async (t) => {
    const random = rng(SEED)
    const testnet = await makeTestnet(t)
    const service = closed ? await makePulse(t, testnet) : null
    const launch = async (dir, opts) => {
      const extensions = service ? { extensions: [...bundled, pulse(service.key)] } : {}
      const built = service ? pulsing : spec
      const me = await cero(dir, built, { bootstrap: testnet.bootstrap, ...extensions, ...opts })
      t.teardown(() => me.close().catch(() => {}), { order: 5 })
      return me
    }

    const hub = await launch(await t.tmp(), { presence: { connections } })
    const rooms = []
    for (let i = 0; i < count; i++) rooms.push(await open(hub.team, { name: `room ${i}` }))
    const ids = rooms.map((room) => room.id)

    // a device takes in a few tens of connections at once: the others join in groups
    const peers = []
    for (let first = 0; first < devices; first += GROUP) {
      const group = []
      for (let p = first; p < Math.min(first + GROUP, devices); p++) {
        const dir = await t.tmp()
        group.push({ me: await launch(dir), dir, index: p, handles: new Map(), opening: null })
      }
      await Promise.all(
        group.map(async (peer) => {
          for (let i = peer.index; i < count; i += devices) {
            peer.handles.set(i, await open(peer.me.team, await cero.invite(rooms[i])))
          }
        })
      )
      await waitUntil(() => group.every((peer) => [...peer.handles.values()].every(known)), 60000)
      if (restart) {
        for (const peer of group) {
          await peer.me.close()
          peer.handles.clear()
        }
      }
      peers.push(...group)
    }

    const got = new Map()
    const follow = (room) =>
      watch(room.messages).on('data', ({ data }) => {
        const now = Date.now()
        for (const m of data) if (!got.has(m.text)) got.set(m.text, now)
      })
    // what an app reads: the row of a room, as its `heard` moves
    const heard = new Map()
    let peak = 0
    if (closed) {
      watch(hub.local.pulses).on('data', ({ data }) => {
        const now = Date.now()
        for (const row of data) {
          const marks = heard.get(row.id) || []
          if (!marks.length || row.heard > marks[marks.length - 1].heard) {
            marks.push({ heard: row.heard, at: now })
            heard.set(row.id, marks)
          }
        }
      })
      hub.on('handle', () => (peak = Math.max(peak, hub.children.size)))
      for (const room of rooms) await close(room)
    } else {
      for (const room of rooms) follow(room)
      // no room is on the network for having just been used
      await waitUntil(() => rooms.every((room) => room.store._discovery.state !== 'pinned'), 120000)
    }

    const online = (peer) =>
      (peer.opening ??= (async () => {
        if (restart) peer.me = await launch(peer.dir)
      })())
    const handle = async (peer, i) => {
      await online(peer)
      if (!peer.handles.has(i)) peer.handles.set(i, open(peer.me.team, { id: ids[i] }))
      return peer.handles.get(i)
    }

    const pick = []
    while (pick.length < only) {
      const i = Math.floor(random() * count)
      if (!pick.includes(i)) pick.push(i)
    }
    const sent = new Map()
    const jobs = []
    for (let w = 0; w < writes; w++) {
      const i = only ? pick[Math.floor(random() * only)] : Math.floor(random() * count)
      const delay = Math.floor(random() * SPREAD)
      jobs.push(
        new Promise((resolve) => setTimeout(resolve, delay)).then(async () => {
          const text = `w${w}`
          const room = await handle(peers[i % devices], i)
          // stamped before the write: a pulse can reach the device before the put resolves here
          const at = Date.now()
          await put(room.messages, { text })
          sent.set(text, { i, at })
        })
      )
    }
    await Promise.all(jobs)

    if (closed) {
      // the room's row says a write told at or after the last one in it was brought up to date
      const last = new Map()
      for (const { i, at } of sent.values()) last.set(i, Math.max(at, last.get(i) || 0))
      const mark = (i, at) => (heard.get(ids[i]) || []).find((m) => m.heard >= at)
      await waitUntil(() => [...last].every(([i, at]) => mark(i, at)), within, 100).catch(() => {})
      const told = [...last].filter(([i, at]) => mark(i, at)).length
      t.comment(
        `${told} of ${last.size} written rooms brought up to date with no room opened by the app`
      )
      t.comment(`at most ${peak} rooms open on the device at once`)
      t.is(told, last.size, `every written room was brought up to date within ${within} ms`)

      // with every other device gone, what the device reads is what pulse brought in
      for (const peer of peers) await peer.me.close()
      for (const i of last.keys()) follow(await open(hub.team, { id: ids[i] }))
      await waitUntil(() => got.size >= sent.size, 10000, 100).catch(() => {})
      const writesAt = [...sent.values()].map(({ i, at }) =>
        Math.max(0, (mark(i, at)?.at ?? at) - at)
      )
      t.comment(`${got.size} of ${sent.size} writes on the device: ${summary(writesAt)}`)
      t.is(got.size, sent.size, 'every write was on the device before the app opened a room')
      return
    }

    await waitUntil(() => got.size >= sent.size, within, 100).catch(() => {})
    const delays = [...got].map(([text, at]) => Math.max(0, at - sent.get(text).at))
    const took = hub.network.replicator.stats.connects.server.opened
    t.comment(`${got.size} of ${sent.size} writes reached the device: ${summary(delays)}`)
    t.comment(`connections the device took in: ${took}, now ${hub.network.connections.size}`)
    t.is(got.size, sent.size, `every write arrived within ${within} ms`)
  })
}

function known(handle) {
  return handle.store.known.length > 0
}
