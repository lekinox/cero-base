import test from 'brittle'
import b4a from 'b4a'
import { Duplex } from 'streamx'
import HypercoreStorage from 'hypercore-storage'

import { cero, put, get, open, leave, receive } from '../../src/index.js'
import { serve } from '../../src/rpc/server.js'
import { connect } from '../../src/rpc/client.js'
import { receive as cold, push as entry } from '../../src/push/index.js'
import { spec } from '../fixtures/spec/index.js'
import { ceroOpen, makeTestnet, makeGateway, makeMirror, waitUntil } from '../helpers/index.js'

test.configure({ timeout: 90000 })

const topicOf = (room) => b4a.toHex(room.store.discoveryKey)
const payloadOf = (message) => b4a.from(message.android.data.payload, 'base64')

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
async function scene(t, { messaging, errors } = {}) {
  const testnet = await makeTestnet(t)
  const gateway = await makeGateway(t, testnet)
  const mirror = await makeMirror(t, testnet, { pushGatewayKeys: [gateway.key] })
  const a = await ceroOpen(t, { testnet, mirrors: [mirror.publicKey] })
  const room = await open(a.me.team, { name: 'clinic' })

  const dir = await t.tmp()
  const [serverStream, clientStream] = pair()
  const server = await serve(serverStream, spec, { storage: dir, bootstrap: testnet.bootstrap })
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
  await waitUntil(() => errors.length === 1)
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
  const { gateway, room, b } = await scene(t, { messaging, errors })
  await waitUntil(() => messaging.topics.has(topicOf(room)))
  t.is(messaging.topics.size, 1, 'subscribed to the joined room')

  await b.me.network.suspend()
  await put(room.messages, { text: 'wake up' })
  await waitUntil(() => gateway.sent.length === gateway.before + 1)
  await b.me.network.resume()
  const dk = room.store.discoveryKey
  await cero.close(b.joined)
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
  await waitUntil(() => messaging.topics.size === 0)
  t.pass('unsubscribed on leave')
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
