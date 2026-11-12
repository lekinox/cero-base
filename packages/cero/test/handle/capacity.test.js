import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import hid from 'hypercore-id-encoding'
import { encode, createNotification } from 'blind-push'

import { cero, open, put, get, receive } from '../../src/index.js'
import { Handle } from '../../src/handle/index.js'
import { spec } from '../fixtures/spec/index.js'
import HyperDB from 'hyperdb'
import { Database } from '@cero-base/core/database'
import { Storage } from '@cero-base/core/storage'
import { addHandles, makeTestnet, waitUntil } from '../helpers/index.js'

test.configure({ timeout: 90000 })

// what a device does with one handle costs the same however many it holds: counted at both, the counts are equal
const SIZES = [50, 500]

const topicOf = (id) => b4a.toHex(crypto.discoveryKey(hid.decode(id)))

// a root that holds `size` handles it never opened, each with its topics row
async function root(t, testnet, size, opts = {}) {
  const dir = await t.tmp()
  opts = { bootstrap: testnet.bootstrap, ...opts }
  const me = await cero(dir, spec, opts)
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const ids = await addHandles(me, size)
  await waitUntil(async () => (await get(me.topics)).data.length === size)
  await me._indexing
  return { me, dir, opts, ids }
}

// what `act` reads and writes of the handles rows and of their topics rows, and the handles it opens
async function counted(act) {
  const seen = { lists: 0, rows: new Set(), topics: new Set(), changes: 0, puts: 0, opened: 0 }
  const { get: main, since } = Database.prototype
  const { get: local, put: write } = Storage.prototype
  const ready = Handle.prototype._open
  Database.prototype.get = function (name, query) {
    // the rows of one state are read through their index: no list of the handles
    if (name === 'handles' && !query?.state) {
      typeof query === 'string' ? seen.rows.add(query) : seen.lists++
    }
    return main.call(this, name, query)
  }
  Database.prototype.since = async function (name, mark) {
    const res = await since.call(this, name, mark)
    if (name === 'handles') {
      seen.changes += res.changes.length
      if (res.reset) seen.lists++
    }
    return res
  }
  Storage.prototype.get = function (name, query) {
    if (name === 'topics') typeof query === 'string' ? seen.topics.add(query) : seen.lists++
    return local.call(this, name, query)
  }
  Storage.prototype.put = function (name, row) {
    if (name === 'topics') seen.puts++
    return write.call(this, name, row)
  }
  Handle.prototype._open = function () {
    if (this.parent) seen.opened++
    return ready.call(this)
  }
  try {
    await act()
  } finally {
    Object.assign(Database.prototype, { get: main, since })
    Object.assign(Storage.prototype, { get: local, put: write })
    Handle.prototype._open = ready
  }
  return { ...seen, rows: seen.rows.size, topics: seen.topics.size }
}

// the rows `act` reads of the handles: through each index or the collection, by its name
async function reads(act) {
  const seen = {}
  const { find } = HyperDB.prototype
  HyperDB.prototype.find = function (name, query, opts) {
    const stream = find.call(this, name, query, opts)
    if (!name.startsWith('@cero/handles')) return stream
    const all = stream.toArray.bind(stream)
    stream.toArray = async () => {
      const rows = await all()
      seen[name] = (seen[name] ?? 0) + rows.length
      return rows
    }
    return stream
  }
  try {
    await act()
  } finally {
    HyperDB.prototype.find = find
  }
  return seen
}

// the same counts at every size
async function flat(t, expected, measure) {
  const testnet = await makeTestnet(t)
  for (const size of SIZES) t.alike(await measure(testnet, size), expected, `${size} handles`)
}

test('capacity: a launch with nothing changed reads no list of the handles or of their topics rows, and opens none', async (t) => {
  const none = { lists: 0, rows: 0, topics: 0, changes: 0, puts: 0, opened: 0 }
  await flat(t, none, async (testnet, size) => {
    const { me: first, dir, opts } = await root(t, testnet, size)
    await first.close()
    return counted(async () => {
      const me = await cero(dir, spec, opts)
      t.teardown(() => me.close().catch(() => {}), { order: 5 })
      await me._indexing
    })
  })
})

test("capacity: a change to one handle's row writes its topics row and reads no list", async (t) => {
  // the write reads the row it changes
  const one = { lists: 0, rows: 1, topics: 1, changes: 1, puts: 1, opened: 0 }
  await flat(t, one, async (testnet, size) => {
    const { me, ids } = await root(t, testnet, size)
    const [id] = ids
    return counted(async () => {
      await me.store.set('handles', { id, name: 'renamed' })
      await waitUntil(
        async () => (await me.local.store.get('topics', topicOf(id))).data.name === 'renamed'
      )
      await me._indexing
    })
  })
})

test('capacity: a join reads one handles row, its own', async (t) => {
  await flat(t, { lists: 0, rows: 1 }, async (testnet, size) => {
    const host = await root(t, testnet, 0)
    const room = await open(host.me.team, { name: 'clinic' })
    const invite = await cero.invite(room)
    const { me } = await root(t, testnet, size)
    let joined = null
    const { lists, rows } = await counted(async () => {
      joined = await open(me.team, invite)
    })
    t.is(joined.id, room.id, 'the room joined')
    return { lists, rows }
  })
})

test("capacity: a push is verified with one topics row read, its handle's", async (t) => {
  await flat(t, { lists: 0, topics: 1, opened: 0 }, async (testnet, size) => {
    const { me } = await root(t, testnet, size)
    const room = await open(me.team, { name: 'clinic' })
    await put(room.messages, { text: 'hi' })
    await waitUntil(
      async () => (await me.local.store.get('topics', topicOf(room.id))).data?.writers
    )
    await me._indexing
    // the push a mirror would build for the room's writer core, at its length
    const payload = encode(
      await createNotification(room.store.bee.local, {
        roomKey: room.store.key,
        extra: b4a.from('messages')
      })
    )
    let hit = null
    const { lists, topics, opened } = await counted(async () => {
      hit = await receive(me, payload)
    })
    t.is(hit?.id, room.id, 'verified')
    return { lists, topics, opened }
  })
})

test('capacity: handles opened and closed past keepOpen leave keepOpen of them open', async (t) => {
  const keepOpen = 2
  await flat(t, { lists: 0, open: keepOpen }, async (testnet, size) => {
    const { me } = await root(t, testnet, size, { keepOpen })
    const made = []
    for (let i = 0; i < keepOpen + 2; i++) made.push(await open(me.team, { name: `room ${i}` }))
    const { lists } = await counted(async () => {
      for (const room of made) await cero.close(room)
      await waitUntil(() => made.every((room) => room.closed || !room.closing))
    })
    return { lists, open: me.children.size }
  })
})

test('capacity: a page of one type among handles of several types reads its rows through the index, never every handle', async (t) => {
  const page = 10
  await flat(t, { '@cero/handles-type': page }, async (testnet, size) => {
    const { me } = await root(t, testnet, 0)
    const types = { team: size / 2, club: size / 5, room: (size * 3) / 10 }
    for (const [type, count] of Object.entries(types)) await addHandles(me, count, 0, type)
    await me._indexing
    let res = null
    const seen = await reads(async () => {
      res = await get(me.team, { limit: page, reverse: true })
    })
    t.is(res.data.length, page)
    t.ok(
      res.data.every((row) => row.type === 'team'),
      'of the one type'
    )
    return seen
  })
})
