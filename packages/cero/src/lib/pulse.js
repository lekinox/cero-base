import Client from 'hypertracker/client'
import crypto from 'hypercore-crypto'
import c from 'compact-encoding'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'

import { CeroError } from '@cero-base/core/errors'
import { epochEntries } from '@cero-base/core/database/encryption'

import { get, set, del, open, close, activate } from './operators.js'

// a handle's key pair on the service comes from the newest epoch key this device holds for it, its
// encryption key before the first rotation: a member removed since cannot sign for it, and the
// service sees its public key, never the handle's topic
const [NS] = crypto.namespace('cero/bump', 1)

// a handle's own writes are told at most once in EVERY ms, and writes from other devices landing
// in it kept and told to the app at most once in HEARD ms. WAKING handles are woken at once, each
// open until a write from another device lands in it or WAIT ms pass. Of the handles a connection
// brings as due, the newest REPLAYED are woken. A time arriving within DIRECT ms of a write from
// another device landing is that write. A connection that died goes unnoticed for up to ~20 s,
// so what was told in the UNSURE ms before it closed is told again
const EVERY = 100
const HEARD = 1000
const WAKING = 4
const WAIT = 10000
const REPLAYED = 32
const DIRECT = 5000
const UNSURE = 30000

/**
 * Follow every handle this device is in on the service at `key`: tell it of this device's writes,
 * and wake a handle when another device tells of one. A best effort: a notice may come late or
 * twice, and the data is Cero's sync's. `me` emits `'pulse'` with the handle's id and the local
 * time a write from another device landed in it.
 *
 * @param {import('../handle/index.js').Context} me
 * @param {string | Uint8Array} key  The service's public key.
 * @returns {() => void}  Stops following.
 */
export function follow(me, key) {
  if (!me.local.pulses) {
    throw CeroError.INVALID('pulse: build the spec with pulse() among its extensions')
  }
  const server = decode(key)
  // a root that began to close before this setup ran has no network left to follow on
  if (me.closing) return () => {}
  const client = new Client(server, { dht: me.network.dht })
  const rooms = new Map() // handle id → what this device follows of it
  const byKey = new Map() // its public key on the service, hex → the same
  const early = new Set() // handles written in before their topics row was read
  const unsure = new Set() // handles told as a connection died
  const lengths = new Map() // handle id → writer, hex → its length at its last op applied
  const waits = new Map() // handle id → ends the wait of its wake
  const queue = new Set()
  const replays = new Set() // handles this connection brought as due, let wake
  let connection = 0
  let opened = 0 // when the connection opened: a time below it was kept by the service
  let waking = 0
  let stopped = false
  let passing = null
  let again = false

  // the app's onerror throwing is no reason to stop
  const report = (err) => {
    if (stopped || me.closing) return
    try {
      me._onerror(err)
    } catch {}
  }
  const live = () => !client.connecting && !client.suspended && !!client.channel?.opened

  // on every handle before it opens, so a write landing as it boots is heard
  const offs = Object.keys(me.spec.handles || {}).map((type) =>
    me._hookType({ type }, (child) => {
      const onapply = ({ writerKey, length }) => {
        // a reorder applies ops again, at the length their writer wrote them at
        if (!lengths.has(child.id)) lengths.set(child.id, new Map())
        const writers = lengths.get(child.id)
        const hex = b4a.toHex(writerKey)
        if (length <= (writers.get(hex) ?? 0)) return
        writers.set(hex, length)
        const own = child.store.writerKey
        if (own && b4a.equals(writerKey, own)) wrote(child.id)
        else landed(child.id)
      }
      child.store.on('apply', onapply)
      return () => child.store.off('apply', onapply)
    })
  )

  client.on('connect', () => {
    const on = ++connection
    opened = Date.now()
    replays.clear()
    client.cork()
    for (const room of rooms.values()) greet(room)
    unsure.clear()
    client.uncork()
    client.connection.once('close', () => {
      const since = Date.now() - UNSURE
      for (const room of rooms.values()) {
        if (room.on === on && room.sent > since) unsure.add(room.id)
      }
    })
  })

  client.on('announce', ({ publicKey, bumped }) => {
    const room = byKey.get(b4a.toHex(publicKey))
    if (!room) return
    room.seen = Math.max(room.seen, bumped)
    // a write owed was told before the service sent what it kept: at or past it, it was dropped
    const first = room.check === connection
    room.check = 0
    if (first && bumped >= room.told && live()) tell(room)
    // the service sends no device what it told on that connection: a time alike told before it is
    // this device's own, kept; one alike told on it is another device's of the same ms, and this
    // one's was dropped
    if (bumped === room.prior) return
    if (bumped === room.told && live()) tell(room)
    // direct sync often beats the service: the write it tells of is in when told before the last
    // write that landed, or the handle is open here
    const direct = Date.now() - room.heard < DIRECT && (bumped <= room.heard || held(room.id))
    if (room.due <= room.since && direct) {
      room.since = Math.max(room.since, bumped)
      return keep(room)
    }
    room.due = Math.max(room.due, bumped)
    if (room.wokenOn === connection && room.woken >= room.due) return
    if (bumped < opened && !admit(room)) return
    queue.add(room)
    pump()
  })

  const onstatus = () => {
    if (me.network.suspended) client.suspend().catch(report)
    else if (client.suspended) client.resume()
  }
  me.on('status', onstatus)

  // the last landing of a window is kept as the root begins to close, while it can still write
  me.own({ destroy: () => rooms.forEach(flush) })

  // a cero() that fails after its setups ran never closes the root
  me.network.once('close', stop)
  me.ready().then(begin, () => {})
  return stop

  function begin() {
    if (stopped) return
    client.connect()
    me.on('topics', pass)
    pass()
  }

  // the topics rows, read again as one changes: a handle added, gone, or with a newer epoch
  function pass() {
    if (passing) {
      again = true
      return
    }
    passing = (async () => {
      do {
        again = false
        await read()
      } while (again && !stopped)
    })()
      .catch(report)
      .finally(() => (passing = null))
  }

  async function read() {
    const { data: rows } = await me.local.store.get('topics')
    const ids = new Set(rows.map((row) => row.handle))
    for (const id of [...rooms.keys()]) if (!ids.has(id)) await drop(id).catch(report)
    for (const row of rows) {
      const room = rooms.get(row.handle)
      if (!room) await add(row).catch(report)
      else if (!same(room.epochs, row.epochs)) rotated(room, row)
    }
  }

  // `since` is the last time of the service counted as brought up to date here, `seen` the last it
  // sent, `due` the last another device told, `told` the last this device told, `owed` a write
  // here not told yet, `heard` when a write from another device last landed, `epoch` the newest
  // this device told under. A handle followed for the first time hears of nothing before
  async function add(row) {
    const id = row.handle
    const { data } = await get(me.local.pulses, id)
    const keys = keysOf(row)
    const since = data?.since ?? Date.now()
    const room = {
      id,
      type: row.type,
      ...keys,
      heard: data?.heard ?? 0,
      told: data?.told ?? 0,
      prior: data?.told ?? 0,
      since,
      seen: since,
      due: since,
      owed: !!data?.owed,
      epoch: data ? data.epoch : keys.newest,
      last: 0,
      on: 0,
      sent: 0,
      check: 0,
      woken: 0,
      wokenOn: 0,
      timer: null,
      again: false,
      landing: null,
      later: false,
      kept: Promise.resolve(),
      waking: false
    }
    rooms.set(id, room)
    byKey.set(b4a.toHex(room.keyPair.publicKey), room)
    if (!data) keep(room)
    if (early.delete(id)) owe(room)
    // told just before the app was stopped, maybe on a connection dead unnoticed
    const age = Date.now() - room.told
    if (age >= 0 && age < UNSURE) unsure.add(id)
    if (live()) greet(room)
  }

  async function drop(id) {
    const room = rooms.get(id)
    rooms.delete(id)
    byKey.delete(b4a.toHex(room.keyPair.publicKey))
    queue.delete(room)
    lengths.delete(id)
    clearTimeout(room.timer)
    clearTimeout(room.landing)
    waits.get(id)?.()
    if (live()) client.unsubscribe(room.keyPair.publicKey)
    await room.kept
    await del(me.local.pulses, id)
  }

  function rotated(room, row) {
    const old = room.keyPair
    Object.assign(room, keysOf(row))
    if (b4a.equals(old.publicKey, room.keyPair.publicKey)) return
    byKey.delete(b4a.toHex(old.publicKey))
    byKey.set(b4a.toHex(room.keyPair.publicKey), room)
    if (!live()) return
    client.unsubscribe(old.publicKey)
    greet(room)
  }

  // what the service kept is asked first. A write owed is told at this time; one told as a
  // connection died is told again as it was, so the service drops it if it had it
  function greet(room) {
    client.subscribe(room.keyPair.publicKey, { since: room.since + 1 })
    room.prior = room.told
    if (room.epoch < room.newest) retire(room)
    if (room.owed) repay(room)
    else if (unsure.delete(room.id)) client.announce(room.keyPair, { bump: room.told })
  }

  // one last time on every older key since the one this device told under, so a device still on
  // it wakes, syncs and learns the newest; a device that told before tells again on the newest
  function retire(room) {
    const bump = Math.max(Date.now(), room.seen + 1)
    for (let epoch = room.epoch; epoch < room.newest; epoch++) {
      const secret = secretOf(room, epoch)
      if (secret) client.announce(keyPairOf(secret), { bump })
    }
    room.epoch = room.newest
    if (room.told) room.owed = true
    keep(room)
  }

  // the first write in a while is told at once, the last of those after it once the window
  // closes, at the time it was made. One made with no connection is kept owed and told as the
  // next one opens
  function wrote(id) {
    const room = rooms.get(id)
    if (!room) return early.add(id)
    room.last = Date.now()
    if (!live()) return owe(room)
    if (room.timer) {
      room.again = true
      return
    }
    tell(room)
    coalesce(room)
  }

  function coalesce(room) {
    room.timer = setTimeout(() => {
      room.timer = null
      if (!room.again || rooms.get(room.id) !== room) return
      room.again = false
      if (!live()) return owe(room)
      tell(room, room.last)
      coalesce(room)
    }, EVERY)
  }

  function owe(room) {
    if (room.owed) return
    room.owed = true
    keep(room)
  }

  // told as a subscription opens, before the time the service kept arrives
  function repay(room) {
    tell(room)
    room.check = connection
  }

  // past what the service sent, which drops a time at or below it: never past a time of this
  // device's own, so a clock that was ahead does not hold the times ahead
  function tell(room, at = Date.now()) {
    room.told = Math.max(at, room.seen + 1)
    room.on = connection
    room.sent = Date.now()
    room.owed = false
    client.announce(room.keyPair, { bump: room.told })
    keep(room)
  }

  // one at a time, so the row ends as the room is, and a drop deletes it after the last
  function keep(room) {
    const { id, heard, told, since, owed, epoch } = room
    const row = { id, heard, told, since, owed, epoch }
    room.kept = room.kept.then(() => set(me.local.pulses, row)).catch(report)
  }

  // the one place a handle is brought up to date: a write from another device landing in it, by
  // a wake or any other way. The first of a window is kept and told to the app as its batch ends,
  // the last as the window closes
  function landed(id) {
    const room = rooms.get(id)
    if (!room) return
    room.heard = Date.now()
    room.since = Math.max(room.since, room.due)
    waits.get(id)?.()
    if (room.landing) {
      room.later = true
      return
    }
    room.landing = setTimeout(() => quiet(room), HEARD)
    queueMicrotask(() => heard(room))
  }

  function quiet(room) {
    room.landing = null
    if (!room.later) return
    room.later = false
    room.landing = setTimeout(() => quiet(room), HEARD)
    heard(room)
  }

  function flush(room) {
    clearTimeout(room.landing)
    room.landing = null
    if (!room.later) return
    room.later = false
    heard(room)
  }

  function heard(room) {
    if (rooms.get(room.id) !== room) return
    keep(room)
    try {
      me.emit('pulse', room.id, room.heard)
    } catch (err) {
      report(err)
    }
  }

  // of the handles a connection brings as due the newest REPLAYED wake: an older one waiting its
  // turn gives its notice up for a newer
  function admit(room) {
    if (replays.has(room)) return true
    if (replays.size < REPLAYED) {
      replays.add(room)
      return true
    }
    let oldest = room
    for (const r of replays) if (queue.has(r) && r.due < oldest.due) oldest = r
    forgo(oldest, oldest.due)
    if (oldest === room) return false
    queue.delete(oldest)
    replays.delete(oldest)
    replays.add(room)
    return true
  }

  // a notice nobody served is counted as brought up to date, `heard` as it was: no connection
  // brings it again
  function forgo(room, at) {
    room.since = Math.max(room.since, at)
    keep(room)
  }

  // the newest due first, in one pass for each wake: one whose write landed as it waited leaves
  function pump() {
    while (waking < WAKING && !stopped) {
      let room = null
      for (const r of queue) {
        if (r.due <= r.since) queue.delete(r)
        else if (!r.waking && (!room || r.due > room.due)) room = r
      }
      if (!room) return
      queue.delete(room)
      room.woken = room.due
      room.wokenOn = connection
      room.waking = true
      waking++
      wake(room).finally(() => {
        room.waking = false
        waking--
        pump()
      })
    }
  }

  function held(id) {
    return [...me.children].some((child) => child.id === id)
  }

  // open, rank first, and stay open until a write from another device lands or WAIT ms pass
  async function wake(room) {
    const { id } = room
    let end = null
    let late = false
    const waited = new Promise((resolve) => {
      const timer = setTimeout(() => {
        late = true
        end()
      }, WAIT)
      end = () => {
        clearTimeout(timer)
        if (waits.get(id) === end) waits.delete(id)
        resolve()
      }
      waits.set(id, end)
    })
    try {
      const h = await open(me[room.type], { id })
      try {
        if (rooms.get(id) !== room) return
        await activate(h)
        await waited
        if (late && rooms.get(id) === room) forgo(room, room.woken)
      } finally {
        await close(h)
      }
    } catch (err) {
      // a handle left or removed meanwhile is no longer this device's
      if (rooms.get(id) === room && err.code !== 'UNKNOWN') report(err)
    } finally {
      end()
    }
  }

  function stop() {
    if (stopped) return
    stopped = true
    for (const room of rooms.values()) {
      clearTimeout(room.timer)
      clearTimeout(room.landing)
    }
    for (const end of [...waits.values()]) end()
    for (const off of offs) off()
    me.off('topics', pass)
    me.off('status', onstatus)
    me.network.off('close', stop)
    client.close().catch(() => {})
  }
}

// the epochs a topics row holds, the newest of them and the key pair it gives
function keysOf(row) {
  const entries = row.epochs ? c.decode(epochEntries, row.epochs) : []
  const room = { epochs: row.epochs ?? null, encryptionKey: row.encryptionKey, entries, newest: 0 }
  for (const e of entries) room.newest = Math.max(room.newest, e.epoch)
  return { ...room, keyPair: keyPairOf(secretOf(room, room.newest)) }
}

// epoch 0 is the handle before its first rotation
function secretOf({ entries, encryptionKey }, epoch) {
  if (epoch === 0) return encryptionKey
  return entries.find((e) => e.epoch === epoch)?.entropy ?? null
}

function keyPairOf(secret) {
  return crypto.keyPair(crypto.hash([NS, secret]))
}

function same(a, b) {
  return a && b ? b4a.equals(a, b) : (a ?? null) === (b ?? null)
}

function decode(key) {
  try {
    return hid.decode(key)
  } catch {
    throw CeroError.INVALID('pulse takes the public key its service prints')
  }
}
