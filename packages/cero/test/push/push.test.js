import test from 'brittle'
import b4a from 'b4a'
import { Duplex } from 'streamx'
import HypercoreStorage from 'hypercore-storage'

import { encode, createNotification } from 'blind-push'
import hid from 'hypercore-id-encoding'

import { cero, put, set, get, del, open, leave, receive } from '../../src/index.js'
import { serve } from '../../src/rpc/server.js'
import { connect } from '../../src/rpc/client.js'
import { Handle } from '../../src/handle/index.js'
import { receive as cold, push as entry } from '../../src/push/index.js'
import { spec } from '../fixtures/spec/index.js'
import { Database } from '@cero-base/core/database'
import { Storage } from '@cero-base/core/storage'
import { ceroOpen, makeTestnet, makeGateway, makeMirror, waitUntil } from '../helpers/index.js'

test.configure({ timeout: 90000 })

const topicOf = (room) => b4a.toHex(room.store.discoveryKey)
const payloadOf = (message) => b4a.from(message.android.data.payload, 'base64')
// the push a mirror would build for a handle's writer core, at its length
const pushOf = async (handle, room) =>
  encode(
    await createNotification(handle.store.bee.local, {
      roomKey: room.store.key,
      extra: b4a.from('messages')
    })
  )

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

function mockMessaging({ failFirst = false } = {}) {
  const listeners = new Set()
  let failed = !failFirst
  return {
    topics: new Set(),
    async subscribe(topic) {
      if (!failed) {
        failed = true
        throw new Error('SERVICE_NOT_AVAILABLE')
      }
      this.topics.add(topic)
    },
    async unsubscribe(topic) {
      this.topics.delete(topic)
    },
    on(event, fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    push(payload) {
      for (const fn of listeners) fn(payload)
    }
  }
}

// a writes to a room through a mirror behind a gateway; b, served over RPC to a client with a
// messaging service, joined that room
async function scene(t, { messaging, errors, keepOpen = 0 } = {}) {
  const testnet = await makeTestnet(t)
  const gateway = await makeGateway(t, testnet)
  const mirror = await makeMirror(t, testnet, { pushGatewayKeys: [gateway.key] })
  const a = await ceroOpen(t, { testnet, mirrors: [mirror.publicKey] })
  const room = await open(a.me.team, { name: 'clinic' })

  const dir = await t.tmp()
  const [serverStream, clientStream] = pair()
  // keepOpen 0: a closed handle is closed, so a push is what opens it again
  const server = await serve(serverStream, spec, {
    storage: dir,
    bootstrap: testnet.bootstrap,
    keepOpen
  })
  const client = await connect(clientStream, spec, {
    onerror: (err) => errors?.push(err),
    ...(messaging && { push: messaging })
  })
  t.teardown(
    async () => {
      try {
        await client.close()
      } catch {}
      try {
        await server.close()
      } catch {}
    },
    { order: 5 }
  )
  const joined = await open(client.team, await cero.invite(room))
  await waitUntil(async () => (await get(joined.status)).data.writable)
  // the bootstrap writes pushed too: count from here
  await waitUntil(() => !room.store.pushing)
  gateway.before = gateway.sent.length
  return { gateway, a, room, b: { me: server.me, client, joined, dir } }
}

// a worker served to a client with a messaging service, whose pushes all verify as newer for `id`
async function woken(t) {
  const testnet = await makeTestnet(t)
  const [serverStream, clientStream] = pair()
  const server = await serve(serverStream, spec, {
    storage: await t.tmp(),
    bootstrap: testnet.bootstrap,
    keepOpen: 0
  })
  const messaging = mockMessaging()
  const client = await connect(clientStream, spec, { push: messaging })
  t.teardown(
    async () => {
      try {
        await client.close()
      } catch {}
      try {
        await server.close()
      } catch {}
    },
    { order: 5 }
  )
  const room = await open(client.team, { name: 'clinic' })
  client._receive = async () => ({ id: room.id, type: 'team', name: 'clinic', newer: true })
  const release = server._release.bind(server)
  const released = { count: 0 }
  server._release = async (...args) => {
    await release(...args)
    released.count++
  }
  const served = () => [...server.me.children].find((c) => c.id === room.id)
  return { server, client, messaging, room, served, released }
}

test('topics: the root lists a topic per handle, kept with the handles rows', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  await waitUntil(async () => (await get(me.topics)).data.length === 1)
  const [row] = (await get(me.topics)).data
  t.alike(
    { id: row.id, handle: row.handle, type: row.type, name: row.name },
    { id: topicOf(room), handle: room.id, type: 'team', name: 'clinic' }
  )
  t.is((await get(room.status)).data.topic, topicOf(room), 'a handle knows its topic')
  t.is((await get(me.status)).data.topic, undefined, 'the root has none')

  // another handle changes the handles rows: only its own topic row is written
  const store = me.local.store
  const puts = []
  const put = store.put.bind(store)
  store.put = (name, value) => {
    if (name === 'topics') puts.push(value.name)
    return put(name, value)
  }
  const other = await open(me.team, { name: 'other' })
  await waitUntil(async () => (await get(me.topics)).data.length === 2)
  store.put = put
  t.alike(puts, ['other'], 'the unchanged row was left alone')
  await leave(other)

  await leave(room)
  await waitUntil(async () => (await get(me.topics)).data.length === 0)
  t.pass('gone with the handle')
})

test('topics: a launch and a new handle read no list of every handle', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const opts = { bootstrap: testnet.bootstrap }
  const first = await cero(dir, spec, opts)
  await open(first.team, { name: 'clinic' })
  await open(first.team, { name: 'other' })
  await waitUntil(async () => (await get(first.topics)).data.length === 2)
  await first._indexing
  await first.close()

  // every read of all the handles, or of all their topics rows, from here on
  const lists = []
  const local = Storage.prototype.get
  const main = Database.prototype.get
  Storage.prototype.get = function (name, query) {
    if (name === 'topics' && query === undefined) lists.push(name)
    return local.call(this, name, query)
  }
  Database.prototype.get = function (name, query) {
    if (name === 'handles' && query === undefined) lists.push(name)
    return main.call(this, name, query)
  }
  t.teardown(() => {
    Storage.prototype.get = local
    Database.prototype.get = main
  })

  const me = await cero(dir, spec, opts)
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  await me._indexing
  t.alike(lists, [], 'the launch read none')
  const third = await open(me.team, { name: 'third' })
  await waitUntil(async () => (await me.local.store.get('topics', topicOf(third))).data)
  await me._indexing
  t.alike(lists, [], 'nor did a new handle')
  t.is((await get(me.topics)).data.length, 3, 'and every handle has its row')
})

test('topics: a row that failed to write is written at the next launch', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const errors = []
  const opts = { bootstrap: testnet.bootstrap, onerror: (err) => errors.push(err) }
  const first = await cero(dir, spec, opts)
  const store = first.local.store
  const put = store.put.bind(store)
  store.put = (name, value) => {
    if (name !== 'topics') return put(name, value)
    return Promise.reject(new Error('disk full'))
  }
  const id = topicOf(await open(first.team, { name: 'clinic' }))
  await waitUntil(() => errors.length > 0)
  await first.close()

  const me = await cero(dir, spec, opts)
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  await waitUntil(async () => (await me.local.store.get('topics', id)).data)
  t.pass('no handle changed since: the launch goes on from the last pass that finished')
})

test('topics: with no point to go on from, a launch reads every handle once and drops the rows of those gone', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const opts = { bootstrap: testnet.bootstrap, keepOpen: 0 }
  const first = await cero(dir, spec, opts)
  const room = await open(first.team, { name: 'clinic' })
  const other = await open(first.team, { name: 'other' })
  const id = topicOf(room)
  const kept = topicOf(other)
  await waitUntil(async () => (await first.local.store.get('topics', kept)).data)
  await waitUntil(async () => (await first.local.store.get('topics', id)).data)
  await cero.close(room)
  await cero.close(other)
  await first._indexing
  // as a store an earlier release wrote: no point kept, a handle with no row and a row with no handle
  const { data: row } = await first.local.store.get('topics', id)
  await first.local.store.del('topics', id)
  await first.local.store.put('topics', { ...row, id: 'f'.repeat(64), handle: 'gone' })
  await first.store.bee.local.setUserData('cero/since/topics', null)
  await first.close()

  const puts = []
  const reads = []
  const { put, get: read } = Storage.prototype
  Storage.prototype.put = function (name, value) {
    if (name === 'topics') puts.push(value.name)
    return put.call(this, name, value)
  }
  Storage.prototype.get = function (name, query) {
    if (name === 'topics') reads.push(query ?? 'all')
    return read.call(this, name, query)
  }
  t.teardown(() => Object.assign(Storage.prototype, { put, get: read }))
  const me = await cero(dir, spec, opts)
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  await me._indexing
  t.alike(reads, ['all'], 'the rows are read once, as one list')
  t.alike(
    (await get(me.topics)).data.map((r) => r.id).sort(),
    [id, kept].sort(),
    'the handle has its row again and the row with no handle is gone'
  )
  t.alike(puts, ['clinic'], 'a row that still describes its handle is not written again')
})

test('topics: a pass still waiting when the root closes does nothing and reports nothing', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  await me._indexing
  let release
  me._indexing = new Promise((resolve) => (release = resolve))
  const queued = me._index().catch((err) => errors.push(err))
  await me.close()
  release()
  await queued
  t.alike(errors, [])
  await t.execution(me._seal({ opened: false }), 'nor does the seal of a handle that never opened')
})

test('topics: a row written by a pass that kept no point goes with its handle', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { keepOpen: 0, onerror: (err) => errors.push(err) })
  await me._indexing
  // the pass writes the row and fails to keep its point: as a kill between the two
  const local = me.store.bee.local
  const set = local.setUserData.bind(local)
  local.setUserData = (key, value) => {
    if (key !== 'cero/since/topics' || value === null) return set(key, value)
    local.setUserData = set
    return Promise.reject(new Error('disk full'))
  }
  const room = await open(me.team, { name: 'clinic' })
  const id = topicOf(room)
  await waitUntil(async () => (await me.local.store.get('topics', id)).data)
  await waitUntil(() => errors.length > 0)
  await leave(room)
  await waitUntil(async () => !(await me.local.store.get('topics', id)).data)
  t.pass('the pass after it started over and dropped the row')
})

test('topics: a failed pass over the root still reads the writers of the handles behind it', async (t) => {
  const a = await ceroOpen(t, { onerror: () => {} })
  const c = await ceroOpen(t, { testnet: a.testnet })
  const room = await open(a.me.team, { name: 'clinic' })
  const theirs = await open(c.me.team, await cero.invite(room))
  await waitUntil(async () => (await get(theirs.status)).data.writable)
  await put(theirs.messages, { text: 'from c' })
  await waitUntil(async () => (await get(room.messages)).data.length === 1)
  const payload = await pushOf(theirs, room)
  await waitUntil(async () => await receive(a.me, payload))
  await a.me._indexing

  // her demotion and a change to the root's rows wait behind one pass, and the root's fails
  let release
  a.me._indexing = new Promise((resolve) => (release = resolve))
  a.me._follow = async () => {
    delete a.me._follow
    throw new Error('disk full')
  }
  await set(room.members, { id: c.me.identity.id, role: 'reader' })
  const failed = a.me._index().catch(() => {})
  release()
  await failed
  await waitUntil(async () => (await receive(a.me, payload)) === null)
  t.pass('her core is refused, though the pass over the root failed')
})

test('topics: a handle writes no row the pass over the root has not written', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  const id = topicOf(room)
  await waitUntil(async () => (await me.local.store.get('topics', id)).data)
  await me._indexing
  await me.local.store.del('topics', id)
  await me._index(room)
  t.absent((await me.local.store.get('topics', id)).data, 'its writers have no row to go on')
})

test('topics: a handle whose row the pass over the root failed to write has its writers once it is written', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  await me._indexing
  const store = me.local.store
  const put = store.put.bind(store)
  store.put = (name, value) => {
    if (name !== 'topics') return put(name, value)
    store.put = put
    return Promise.reject(new Error('disk full'))
  }
  const room = await open(me.team, { name: 'clinic' })
  await waitUntil(() => errors.length > 0)
  // nothing changes in the root again: the handle's own pass has the root's rows written
  await set(room.members, { id: me.identity.id, name: 'renamed' })
  const own = await pushOf(room, room)
  await waitUntil(async () => await receive(me, own))
  t.pass('its own core is accepted')
})

test('topics: the pass over the root leaves the writers of a handle that is closing as they were sealed', async (t) => {
  const { me } = await ceroOpen(t, { keepOpen: 0 })
  const room = await open(me.team, { name: 'clinic' })
  const id = topicOf(room)
  const handle = room.id
  await waitUntil(async () => (await me.local.store.get('topics', id)).data?.writers)
  const { data: sealed } = await me.local.store.get('topics', id)
  await cero.close(room)
  await me._indexing
  // a handle that opened, failed its claim and is on its way out: nothing reads its store
  const store = { get: () => Promise.reject(new Error('closed')) }
  const closing = { opened: true, closing: true, id: handle, store }
  me._pending.add(closing)
  t.teardown(() => me._pending.delete(closing))
  await me.store.set('handles', { id: handle, name: 'renamed' })
  await waitUntil(async () => (await me.local.store.get('topics', id)).data.name === 'renamed')
  t.alike((await me.local.store.get('topics', id)).data.writers, sealed.writers)
})

test('topics: one handle whose pass fails does not stop the pass of the next', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err.message) })
  const first = await open(me.team, { name: 'first' })
  const second = await open(me.team, { name: 'second' })
  await waitUntil(async () => (await get(me.topics)).data.length === 2)
  await me._indexing
  const topic = me._topic.bind(me)
  const passed = []
  me._topic = async (child, sealing) => {
    passed.push(child.name)
    if (child === first) throw new Error('disk full')
    return topic(child, sealing)
  }
  let release
  me._indexing = new Promise((resolve) => (release = resolve))
  const queued = [me._index(first), me._index(second)]
  release()
  await Promise.all(queued)
  t.alike(passed, ['first', 'second'])
  t.alike(errors, ['disk full'], 'and the failure reached the app')
})

test('topics: after one failed reindex the next handles change still indexes', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  const store = me.local.store
  const put = store.put.bind(store)
  let failing = true
  store.put = (name, value) => {
    if (name !== 'topics' || !failing) return put(name, value)
    failing = false
    return Promise.reject(new Error('disk full'))
  }
  await open(me.team, { name: 'clinic' })
  await waitUntil(() => errors.length || null)
  t.alike(
    errors.map((e) => e.message),
    ['disk full'],
    'the failed pass reaches onerror'
  )
  await open(me.team, { name: 'other' })
  await waitUntil(async () => (await get(me.topics)).data.length === 2, 10000)
  t.alike(
    errors.map((e) => e.message),
    ['disk full'],
    'and only once'
  )
})

test('topics: a pass that fails leaves the next one to run, and an unreadable handle costs its own row', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  const store = me.local.store
  const put = store.put.bind(store)
  store.put = (name, value) => {
    if (name !== 'topics') return put(name, value)
    store.put = put
    throw new Error('disk full')
  }
  const first = await open(me.team, { name: 'first' })
  await waitUntil(() => errors.length > 0)
  const second = await open(me.team, { name: 'second' })
  await waitUntil(async () => (await get(me.topics)).data.length === 2)
  t.pass('the pass after the failed one wrote both rows')
  const own = await pushOf(first, first)
  await waitUntil(async () => await receive(me, own))

  // its members and devices no longer list: a change in the handle writes its row again
  const read = first.store.get.bind(first.store)
  first.store.get = async (name, query) => {
    if (query === undefined) throw new Error('unreadable')
    return read(name, query)
  }
  await set(first.members, { id: me.identity.id, name: 'renamed' })
  await waitUntil(async () => (await receive(me, own)) === null)
  first.store.get = read
  t.pass('the handle it could not read accepts nobody')
  t.ok(await receive(me, await pushOf(second, second)), 'the others are written as ever')
})

test('topics: a failed pass that several updates joined reaches onerror once', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  const room = await open(me.team, { name: 'clinic' })
  await me._indexing

  // the pass under way is slow, and the one queued behind it fails
  const topic = me._topic.bind(me)
  let release
  const held = new Promise((resolve) => (release = resolve))
  let passes = 0
  me._topic = async (...args) => {
    passes++
    if (passes === 1) await held
    if (passes === 2) throw new Error('disk full')
    return topic(...args)
  }
  for (let i = 0; i < 6; i++) await set(room.members, { id: me.identity.id, name: `a${i}` })
  release()
  await waitUntil(() => errors.length > 0)
  for (let p = null; p !== me._indexing;) await (p = me._indexing).catch(() => {})
  t.is(passes, 2, 'the updates behind the slow pass joined one')
  t.alike(
    errors.map((e) => e.message),
    ['disk full'],
    'reported once'
  )
})

test('topics: a burst of updates on one handle is a few passes that read only that handle, and the last one lands', async (t) => {
  const a = await ceroOpen(t)
  const c = await ceroOpen(t, { testnet: a.testnet })
  const room = await open(a.me.team, { name: 'clinic' })
  const other = await open(a.me.team, { name: 'other' })
  const theirs = await open(c.me.team, await cero.invite(room))
  await waitUntil(async () => (await get(theirs.status)).data.writable)
  await put(theirs.messages, { text: 'from c' })
  await waitUntil(async () => (await get(room.messages)).data.length === 1)
  const payload = await pushOf(theirs, room)
  await waitUntil(async () => await receive(a.me, payload))
  await a.me._indexing

  // a pass that reads a handle's writers takes a while, as in a big room
  const counts = { passes: 0, updates: 0, other: 0 }
  const topic = a.me._topic.bind(a.me)
  a.me._topic = (...args) => {
    counts.passes++
    return topic(...args)
  }
  room.store.on('update', (touched) => touched.has('members') && counts.updates++)
  const slow = room.store.get.bind(room.store)
  room.store.get = async (name, query) => {
    const read = await slow(name, query)
    if (query === undefined) await new Promise((resolve) => setTimeout(resolve, 100))
    return read
  }
  const plain = other.store.get.bind(other.store)
  other.store.get = (name, query) => {
    if (query === undefined) counts.other++
    return plain(name, query)
  }
  for (let i = 0; i < 20; i++) await set(room.members, { id: a.me.identity.id, name: `a${i}` })
  await set(room.members, { id: c.me.identity.id, role: 'reader' })
  await waitUntil(async () => (await receive(a.me, payload)) === null)
  t.pass('the last update, her demotion, landed')
  for (let p = null; p !== a.me._indexing;) await (p = a.me._indexing)
  t.ok(counts.passes < counts.updates / 2, `${counts.passes} passes for ${counts.updates} updates`)
  t.is(counts.other, 0, 'the other handle was not read')
})

test('topics: an update that lands while a handle closes leaves its row as it was sealed', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { keepOpen: 0, onerror: (err) => errors.push(err) })
  const room = await open(me.team, { name: 'clinic' })
  const own = await pushOf(room, room)
  await waitUntil(async () => await receive(me, own))
  // an op of another member applies between the seal and the store closing
  const seal = me._seal.bind(me)
  me._seal = (child) => {
    const sealing = seal(child)
    child.store.emit('update', new Set(['members']))
    return sealing
  }
  // the store is still closing when the pass that update asked for runs
  const close = room.store._close.bind(room.store)
  let closing
  const held = new Promise((resolve) => (closing = resolve))
  room.store._close = async () => {
    await held
    return close()
  }
  const closed = cero.close(room)
  await waitUntil(() => !!room.store.closing)
  for (let p = null; p !== me._indexing;) await (p = me._indexing).catch(() => {})
  closing()
  await closed
  t.is(me._ending.size, 0, 'closed, it is no longer waited for')
  t.alike(errors, [], 'nothing reaches onerror')
  t.ok(await receive(me, own), 'its pushes still verify')
})

test('topics: a second device of the identity lists a handle it never opened', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const b = await ceroOpen(t, { testnet: a.testnet, phrase: a.me.identity.toPhrase() })
  await waitUntil(async () => (await get(b.me.topics)).data.length === 1)
  t.is((await get(b.me.topics)).data[0].id, topicOf(room))
})

test('receive: a push about a joined room verifies as newer, on the worker and over RPC', async (t) => {
  const { gateway, room, b } = await scene(t)
  await b.me.network.suspend()
  await put(room.messages, { text: 'hi' })
  await waitUntil(() => gateway.sent.length === gateway.before + 1)
  const payload = payloadOf(gateway.sent.at(-1))

  const hit = await receive(b.me, payload)
  // a joined handle's row carries no name until the app sets one
  t.is(hit.row?.text, 'hi', 'the row rode along and this device opened it')
  const { row, ...rest } = hit
  t.alike(rest, { id: b.joined.id, type: 'team', name: null, newer: true, ref: 'messages' })
  t.alike(await receive(b.client, payload), hit, 'the same over RPC')
  t.is(await receive(b.me, b4a.from('garbage')), null)
  await t.exception(receive(b.joined, payload), /on me/, "a push is the app's, not a handle's")
  await b.me.network.resume()

  await cero.suspend(b.client)
  await t.exception(receive(b.client, payload), /suspended/, 'no read from a suspended storage')
  await cero.resume(b.client)
})

test('receive: cold, from the storage, with the app open and once it closed', async (t) => {
  const { gateway, room, b } = await scene(t)
  await b.me.network.suspend()
  await put(room.messages, { text: 'while b sleeps' })
  await waitUntil(() => gateway.sent.length === gateway.before + 1)
  const payload = payloadOf(gateway.sent.at(-1))

  const expected = { id: b.joined.id, type: 'team', name: null, newer: true, ref: 'messages' }
  const seen = await cold(b.dir, spec, payload)
  t.is(seen.row?.text, 'while b sleeps', 'the row, from the keys the topics rows keep')
  t.alike(
    { ...seen, row: undefined },
    { ...expected, row: undefined },
    'read-only beside the live app'
  )
  await b.client.close()
  await b.me.close()
  t.is((await cold(b.dir, spec, payload))?.row?.text, 'while b sleeps', 'and from a closed app')
  const storage = new HypercoreStorage(`${b.dir}/main`)
  await storage.ready()
  await storage.close()
  t.pass('the cold read left the storage reopenable')
})

test('receive: a member seated after the topics row was written is accepted, refused while she reads and once her removal applied here', async (t) => {
  const a = await ceroOpen(t)
  const b = await ceroOpen(t, { testnet: a.testnet })
  const c = await ceroOpen(t, { testnet: a.testnet })
  const room = await open(a.me.team, { name: 'clinic' })
  const mine = await open(b.me.team, await cero.invite(room))
  await waitUntil(async () => (await get(b.me.topics)).data.length === 1)

  const theirs = await open(c.me.team, await cero.invite(room))
  await waitUntil(async () => (await get(theirs.status)).data.writable)
  await put(theirs.messages, { text: 'from c' })
  await waitUntil(async () => (await get(mine.messages)).data.length === 1)
  const payload = await pushOf(theirs, room)
  await waitUntil(async () => (await receive(b.me, payload))?.row?.text === 'from c')
  t.pass('her seat reached b and her push reads as verified')
  const role = (r) => set(room.members, { id: c.me.identity.id, role: r })
  await role('reader')
  await waitUntil(async () => (await receive(b.me, payload)) === null)
  t.pass('set to reader she writes nothing, and her push reads as nothing')
  await role('member')
  await waitUntil(async () => await receive(b.me, payload))
  t.pass('set back, it reads again')

  await del(room.members, c.me.identity.id)
  await waitUntil(async () => !(await get(mine.members, c.me.identity.id)).data)
  await waitUntil(async () => (await receive(b.me, payload)) === null)
  t.pass('her removal applied here, her push reads as nothing')
  const own = await pushOf(mine, room)
  t.ok(await receive(b.me, own), "b's own still does")
  await b.me.close()
  // a launch that leaves the handle closed keeps the writers it last had open
  const again = await cero(b.dir, spec, { bootstrap: a.testnet.bootstrap })
  await again.close()
  t.ok(await cold(b.dir, spec, own), 'cold, from the stored row, a writer reads')
  t.is(await cold(b.dir, spec, payload), null, 'and she does not')
})

test('receive: a member who removes one of her two devices: its push reads as nothing, the other still verifies', async (t) => {
  const a = await ceroOpen(t)
  const b = await ceroOpen(t, { testnet: a.testnet })
  const room = await open(a.me.team, { name: 'clinic' })
  const mine = await open(b.me.team, await cero.invite(room))
  const two = await ceroOpen(t, { testnet: a.testnet, phrase: b.me.identity.toPhrase() })
  await waitUntil(async () => (await get(two.me.topics)).data.length === 1)
  const second = await open(two.me.team, { id: mine.id })
  await waitUntil(async () => (await get(second.status)).data.writable)
  await put(second.messages, { text: 'two' })
  await waitUntil(async () => (await get(mine.messages)).data.length === 1)
  const kept = await pushOf(mine, room)
  const gone = await pushOf(second, room)
  await waitUntil(async () => (await receive(b.me, kept)) && (await receive(b.me, gone)))

  // with the owner away nobody rotates, so the removal is the only update that lands
  await a.me.close()
  await del(mine.devices, hid.encode(second.store.writerKey))
  await waitUntil(async () => (await receive(b.me, gone)) === null)
  t.pass('the removed device reads as nothing')
  t.ok(await receive(b.me, kept), 'her other device still verifies')
  await b.me.close()
  t.is(await cold(b.dir, spec, gone), null, 'cold, the removed one neither')
  t.ok(await cold(b.dir, spec, kept), 'and the other still does')
})

// c is taken out of a room b holds, and b's handle or app closes in the same tick the removal applies there
async function closedOnRemoval(t, close) {
  const a = await ceroOpen(t)
  const b = await ceroOpen(t, { testnet: a.testnet, keepOpen: 0 })
  const c = await ceroOpen(t, { testnet: a.testnet })
  const room = await open(a.me.team, { name: 'clinic' })
  const mine = await open(b.me.team, await cero.invite(room))
  const theirs = await open(c.me.team, await cero.invite(room))
  await waitUntil(async () => (await get(theirs.status)).data.writable)
  await put(theirs.messages, { text: 'from c' })
  await waitUntil(async () => (await get(mine.messages)).data.length === 1)
  const payload = await pushOf(theirs, room)
  const own = await pushOf(mine, room)
  await waitUntil(async () => await receive(b.me, payload))

  let closed = null
  mine.store.on('update', (touched) => {
    if (!closed && (touched.has('members') || touched.has('*'))) closed = close(b.me, mine)
  })
  await del(room.members, c.me.identity.id)
  await waitUntil(() => !!closed)
  await closed
  t.is(await cold(b.dir, spec, payload), null, 'her push reads as nothing from the stored row')
  t.ok(await cold(b.dir, spec, own), "b's own still does")
}

test('receive: a removal applied just before the handle closes is what its stored row keeps', (t) =>
  closedOnRemoval(t, (me, room) => cero.close(room)))

test('receive: a removal applied just before the app closes is what its stored row keeps', (t) =>
  closedOnRemoval(t, (me) => me.close()))

test('push: a write to a ref that declares no push sends nothing', async (t) => {
  const { gateway, room } = await scene(t)
  await put(room.notes, { text: 'quiet' })
  t.absent(room.store.pushing, 'notes declares no push')
  const pushed = await waitUntil(() => gateway.sent.length > gateway.before, 2000).catch(
    () => false
  )
  t.absent(pushed, 'nothing sent')
})

test('push: the bare-kit entry hands a verified push to show and answers what it returns', async (t) => {
  const { gateway, room, b } = await scene(t)
  await b.me.network.suspend()
  await put(room.messages, { text: 'ping' })
  await waitUntil(() => gateway.sent.length === gateway.before + 1)
  const payload = gateway.sent.at(-1).android.data.payload

  const handlers = {}
  globalThis.BareKit = { on: (event, fn) => (handlers[event] = fn) }
  t.teardown(() => delete globalThis.BareKit)
  await t.exception(() => entry(spec), /show/, 'the app says what to show, there is no default')

  const request = JSON.stringify({ storage: b.dir, payload })
  const ask = async () => {
    const replies = []
    await handlers.push(request, (err, res) => replies.push([err, res]))
    return replies
  }
  const seen = []
  entry(spec, (hit) => {
    seen.push(hit)
    return { title: hit.name || 'Equipo', body: `Nuevo: ${hit.ref}` }
  })
  t.alike(await ask(), [[null, JSON.stringify({ title: 'Equipo', body: 'Nuevo: messages' })]])
  t.is(seen[0]?.row?.text, 'ping', 'show gets the row')
  t.alike(
    seen.map(({ row, ...s }) => s),
    [{ id: b.joined.id, type: 'team', name: null, newer: true, ref: 'messages' }]
  )

  entry(spec, () => undefined)
  t.alike(await ask(), [[null, null]], 'nothing returned, nothing shown')
  entry(spec, () => {
    throw new Error('boom')
  })
  t.alike(
    await ask(),
    [[null, null]],
    'a throwing show shows nothing, the OS still gets its answer'
  )

  await b.me.network.resume()
  await waitUntil(async () => (await get(b.joined.messages)).data.length === 1)
  seen.length = 0
  entry(spec, (hit) => seen.push(hit))
  t.alike(await ask(), [[null, null]], 'a push the device already holds is not shown')
  t.is(seen.length, 0, 'and show was never asked')
})

test('push: a subscribe that fails is retried at the next change, the follower lives on', async (t) => {
  const messaging = mockMessaging({ failFirst: true })
  const errors = []
  const { b } = await scene(t, { messaging, errors })
  await waitUntil(() => errors.length > 0)
  t.is(messaging.topics.size, 0, 'the first subscribe failed, and was reported')
  const other = await open(b.client.team, { name: 'other' })
  await waitUntil(() => messaging.topics.size === 2)
  t.pass('the next change subscribed both, the failed one again')
  await leave(other)
})

test('push: the bare-kit entry answers every push, a bad one with nothing and show unasked', async (t) => {
  const handlers = {}
  globalThis.BareKit = { on: (event, fn) => (handlers[event] = fn) }
  t.teardown(() => delete globalThis.BareKit)
  entry(spec, () => t.fail('a bad push is never shown'))
  const replies = []
  await handlers.push('not json', (err, res) => replies.push([err, res]))
  await handlers.push(JSON.stringify({ storage: await t.tmp(), payload: '' }), (err, res) =>
    replies.push([err, res])
  )
  t.alike(replies, [
    [null, null],
    [null, null]
  ])
})

test('push: the messaging service follows the topics, and a push activates the handle', async (t) => {
  const messaging = mockMessaging()
  const errors = []
  // a wake lets go of the handle it opened: idle, it stays on the swarm
  const { gateway, room, b } = await scene(t, { messaging, errors, keepOpen: 1 })
  await waitUntil(() => messaging.topics.has(topicOf(room)))
  t.is(messaging.topics.size, 1, 'subscribed to the joined room')

  await b.me.network.suspend()
  await put(room.messages, { text: 'wake up' })
  await waitUntil(() => gateway.sent.length === gateway.before + 1)
  const dk = room.store.discoveryKey
  // closed before it syncs the write, so the push is newer: one more idle handle closes it
  const served = [...b.me.children].find((c) => c.id === b.joined.id)
  await cero.close(b.joined)
  await cero.close(await open(b.client.team, { name: 'other' }))
  await waitUntil(() => served.closed)
  await b.me.network.resume()
  await waitUntil(() => b.me.network.presence.mode(dk) === null)
  messaging.push(payloadOf(gateway.sent.at(-1)))
  await waitUntil(() => b.me.network.presence.mode(dk) === 'active')
  t.pass('the push opened the handle and ranked it first')

  await cero.suspend(b.client)
  messaging.push(payloadOf(gateway.sent.at(-1)))
  const errored = await waitUntil(() => errors.length > 0, 1000).catch(() => false)
  t.absent(errored, 'a push while the app sleeps is left to the OS, no error')
  await cero.resume(b.client)

  const reopened = await open(b.client.team, { id: b.joined.id })
  await leave(reopened)
  await waitUntil(() => !messaging.topics.has(topicOf(room)))
  t.pass('unsubscribed on leave')
})

test('push: a wake lets go of the handle it opened', async (t) => {
  const { server, messaging, room, served, released } = await woken(t)
  await cero.close(room)
  await waitUntil(() => !served())
  for (let i = 0; i < 3; i++) messaging.push(new Uint8Array(1))
  // the app's close, then one per wake
  await waitUntil(() => released.count === 4)
  t.absent(server._held.has(room.id), 'three wakes hold nothing')
  t.absent(server.handles.has(room.id), 'the app holds nothing')
  await waitUntil(() => !served())
  t.pass('the room closes once nobody holds it')
})

test('push: a wake whose activation fails still lets go of the handle it opened', async (t) => {
  const { server, messaging, room, served, released } = await woken(t)
  await cero.close(room)
  await waitUntil(() => !served())
  const active = Handle.prototype._active
  Handle.prototype._active = () => {
    throw new Error('activation failed')
  }
  t.teardown(() => {
    Handle.prototype._active = active
  })
  messaging.push(new Uint8Array(1))
  // the app's close, then the wake's
  await waitUntil(() => released.count === 2)
  Handle.prototype._active = active
  t.absent(server._held.has(room.id), 'the wake holds nothing')
})

test('push: a wake leaves a room the app holds open', async (t) => {
  const { server, messaging, room, served, released } = await woken(t)
  messaging.push(new Uint8Array(1))
  await waitUntil(() => released.count === 1)
  t.is(server._held.get(room.id), 1, "the app's own hold")
  t.ok(served(), 'still open on the worker')
  t.is((await put(room.messages, { text: 'hi' })).data.text, 'hi', 'the app still writes to it')
  await cero.close(room)
  await waitUntil(() => !served())
  t.absent(server._held.has(room.id), 'let go with the app')
})

test('receive: a rotated room still opens its pushes, with the epochs the root carries', async (t) => {
  const { gateway, room, b } = await scene(t)
  await cero.rotate(room)
  // b learns the epoch through its root before the next push lands
  const served = [...b.me.children].find((c) => c.id === b.joined.id)
  await waitUntil(() => served.store.keyring.seq === 1 || null)
  await b.me.network.suspend()
  await put(room.messages, { text: 'after the key turned' })
  await waitUntil(() => gateway.sent.length === gateway.before + 1)
  const hit = await receive(b.me, payloadOf(gateway.sent.at(-1)))
  t.is(hit.row?.text, 'after the key turned')
  await b.me.network.resume()
})
