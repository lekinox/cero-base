import test from 'brittle'
import b4a from 'b4a'
import HypercoreStorage from 'hypercore-storage'

import { encode } from 'blind-push'
import crypto from 'hypercore-crypto'

import { verify, decrypt } from '../../src/push/index.js'
import {
  makeTestnet,
  makeGateway,
  makeMirror,
  makeBlindPeer,
  makePeer,
  waitFor,
  waitForConnection,
  waitForMirrored
} from '../helpers/index.js'

test.configure({ timeout: 60000 })

const handle = (db) => ({ id: 'room', key: db.key })

// a writer with a mirror behind a gateway, and a reader of its database that holds the writer's core
async function pair(t, opts = {}) {
  const testnet = await makeTestnet(t)
  const gateway = await makeGateway(t, testnet)
  const peer = await makeBlindPeer(t, testnet, { pushGatewayKeys: [gateway.key] })
  const mirror = peer.publicKey
  gateway.indexes = []
  peer.on('notification-rx', (request) => gateway.indexes.push(request.block.index))
  const a = await makePeer(t, testnet, { mirrors: [mirror], push: true, ...opts })
  await a.db.bootstrap({ name: 'a' })
  const b = await makePeer(t, testnet, {
    identity: a.identity,
    topic: a.topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await b.db.bootstrap({ recovering: true })
  await Promise.all([waitForConnection(a.network), waitForConnection(b.network)])
  await waitForMirrored(a.db)
  // the bootstrap writes pushed too: count from here
  await waitFor(() => !a.db.pushing)
  gateway.before = gateway.sent.length
  return { gateway, a, b }
}

const last = (gateway) => b4a.from(gateway.sent.at(-1).android.data.payload, 'base64')

test('push: a write reaches the gateway, the reader verifies it as newer, then as seen', async (t) => {
  const { gateway, a, b } = await pair(t)
  await b.network.suspend()
  await a.db.put('messages', { text: 'hi' })
  await waitFor(() => gateway.sent.length === gateway.before + 1)
  t.is(gateway.sent.at(-1).topic, b4a.toHex(a.db.discoveryKey), 'sent to the handle topic')
  const payload = last(gateway)

  const hit = await verify(b.store.storage, payload, [handle(a.db)])
  t.is(hit.id, 'room')
  t.ok(hit.newer, 'the reader is behind')
  t.is(hit.ref, 'messages', 'the push names the ref')

  await b.network.resume()
  await waitFor(async () => (await b.db.get('messages')).data.length === 1)
  const again = await verify(b.store.storage, payload, [handle(a.db)])
  t.absent(again.newer, 'a replay proves nothing new')
})

test('push: a closed device verifies from its storage opened read-only', async (t) => {
  const { gateway, a, b } = await pair(t)
  await b.network.suspend()
  await a.db.put('messages', { text: 'while b sleeps' })
  await waitFor(() => gateway.sent.length === gateway.before + 1)
  const payload = last(gateway)

  const dir = b.store.storage.path
  await b.db.close()
  await b.network.close()
  await b.store.close()
  const storage = new HypercoreStorage(dir, { readOnly: true })
  await storage.ready()
  t.teardown(() => storage.close(), { order: 4 })

  const hit = await verify(storage, payload, [handle(a.db)])
  t.ok(hit?.newer, 'verified cold')
})

test('push: an unknown handle, a tampered payload and garbage all read as nothing', async (t) => {
  const { gateway, a, b } = await pair(t)
  await b.network.suspend()
  await a.db.put('messages', { text: 'x' })
  await waitFor(() => gateway.sent.length === gateway.before + 1)
  const payload = last(gateway)

  t.is(await verify(b.store.storage, payload, []), null, 'not a handle of this device')
  const tampered = b4a.from(payload)
  tampered[tampered.length - 1] ^= 1
  t.is(await verify(b.store.storage, tampered, [handle(a.db)]), null, 'tampered')
  t.is(await verify(b.store.storage, b4a.from('garbage'), [handle(a.db)]), null, 'garbage')
  const short = encode({
    discoveryKey: crypto.discoveryKey(a.db.key),
    payload: b4a.alloc(3),
    version: 3
  })
  t.is(
    await verify(b.store.storage, short, [handle(a.db)]),
    null,
    'a payload too short to hold a proof'
  )
})

test('push: a burst of writes is at most two pushes, the last at the latest block', async (t) => {
  const { gateway, a } = await pair(t)
  await Promise.all([1, 2, 3, 4, 5].map((n) => a.db.put('messages', { text: `m${n}` })))
  await waitFor(() => gateway.sent.length > gateway.before && !a.db.pushing)
  const pushes = gateway.sent.length - gateway.before
  t.ok(pushes <= 2, `${pushes} pushes for five writes`)
  t.is(new Set(gateway.indexes).size, gateway.indexes.length, 'no block pushed twice')
})

test('push: a write while the network sleeps pushes at resume', async (t) => {
  const { gateway, a } = await pair(t)
  await a.network.suspend()
  await a.db.put('messages', { text: 'queued' })
  await waitFor(() => !a.db.pushing)
  t.is(gateway.sent.length, gateway.before, 'nothing while suspended')
  await a.network.resume()
  await waitFor(() => gateway.sent.length === gateway.before + 1)
  t.pass('pushed at resume')
})

test('push: a push attempt outlives its database without a crash', async (t) => {
  const testnet = await makeTestnet(t)
  // a mirror nobody runs: the first attempt fails, the retry comes 5 s later
  const a = await makePeer(t, testnet, { mirrors: [crypto.randomBytes(32)], push: true })
  await a.db.bootstrap({ name: 'a' })
  await a.db.put('messages', { text: 'to nobody' })
  const { db } = a
  await db.close()
  await waitFor(() => !db.pushing, { timeout: 20000 })
  t.pass('the retry found a closed database and stopped')
})

test('push: a write to a ref that declares no push sends nothing', async (t) => {
  const { gateway, a } = await pair(t)
  await a.db.put('tasks', { title: 'quiet' })
  t.absent(a.db.pushing, 'tasks declares no push')
  const pushed = await waitFor(() => gateway.sent.length > gateway.before, { timeout: 2000 }).catch(
    () => false
  )
  t.absent(pushed, 'nothing sent')
  await a.db.put('messages', { text: 'loud' })
  await waitFor(() => gateway.sent.length === gateway.before + 1)
  t.pass('a ref that declares push still does')
})

test('push: nothing without mirrors, nothing from a database that does not push', async (t) => {
  const testnet = await makeTestnet(t)
  const alone = await makePeer(t, testnet, { push: true })
  await alone.db.bootstrap({ name: 'alone' })
  await alone.db.put('messages', { text: 'nobody listens' })
  t.absent(alone.db.pushing, 'no mirrors, no push')

  const { gateway, a } = await pair(t, { push: false })
  await a.db.put('messages', { text: 'quiet' })
  await waitFor(() => a.db.bee.local.length > 1)
  const pushed = await waitFor(() => gateway.sent.length > gateway.before, { timeout: 2000 }).catch(
    () => false
  )
  t.absent(pushed, 'push off, nothing sent')
})

test('push: the block rides when it fits and decrypts to the op for a holder of the keys, each epoch', async (t) => {
  const { gateway, a, b } = await pair(t)
  const keys = () => ({ encryptionKey: a.db.encryptionKey, epochs: a.db.keyring.all() })
  const op = async (payload, k = keys()) => {
    const hit = await verify(b.store.storage, payload, [handle(a.db)])
    const body = await decrypt(b.store.storage, hit, k)
    return body && a.db.spec.dispatch.decode(body)
  }

  await a.db.put('messages', { text: 'hi' })
  await waitFor(() => gateway.sent.length === gateway.before + 1)
  const first = await verify(b.store.storage, last(gateway), [handle(a.db)])
  t.is(first.block?.index, a.db.bee.local.length - 1, 'the block rode along, at its index')
  const decoded = await op(last(gateway))
  t.ok(decoded.name.endsWith('/add-messages'), 'the op')
  t.is(decoded.value.text, 'hi', 'with the row')
  t.is(
    await decrypt(b.store.storage, first, { encryptionKey: b4a.alloc(32) }),
    null,
    'not with another key'
  )

  await a.db.rotate()
  await a.db.put('messages', { text: 'after' })
  await waitFor(() => gateway.sent.length === gateway.before + 2)
  t.is((await op(last(gateway))).value.text, 'after', 'a rotated epoch decrypts with its entropy')
  t.is(
    await op(last(gateway), { encryptionKey: a.db.encryptionKey, epochs: [] }),
    null,
    'not without it'
  )

  await a.db.put('messages', { text: 'x'.repeat(8000) })
  await waitFor(() => gateway.sent.length === gateway.before + 3)
  const big = await verify(b.store.storage, last(gateway), [handle(a.db)])
  t.is(big.block, null, 'a block that does not fit stays behind')
  t.is(await decrypt(b.store.storage, big, keys()), null, 'nothing to open then')
})
