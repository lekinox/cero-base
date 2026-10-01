import test from 'brittle'
import b4a from 'b4a'
import z32 from 'z32'

import { Blobs, encodeId, decodeId } from '../../src/blobs/index.js'
import { Identity } from '../../src/identity/index.js'
import { Network } from '../../src/network/index.js'
import {
  makeNet,
  makeTestnet,
  makeStore,
  connectPair,
  randomTopic,
  streamFromChunks,
  streamToBuffer
} from '../helpers/index.js'

test.configure({ timeout: 60000 })

async function makeBlobs(t, opts = {}) {
  const { store } = opts.store ? { store: opts.store } : await makeStore(t)
  const blobs = new Blobs({ store, encryptionKey: Identity.randomBytes(32), ...opts })
  await blobs.ready()
  t.teardown(() => blobs.close().catch(() => {}), { order: 1 })
  return { blobs, store }
}

// ─── construction validation ──────────────────────────────────────────────

test('construction: store is required', (t) => {
  t.exception.all(() => new Blobs({}), /store is required/)
  t.exception.all(() => new Blobs({ encryptionKey: b4a.alloc(32, 1) }), /store is required/)
})

test('construction: refuses a store its network does not replicate', async (t) => {
  const { store } = await makeStore(t)
  const { store: other } = await makeStore(t)
  const network = new Network({ store })
  const encryptionKey = Identity.randomBytes(32)
  t.exception.all(() => new Blobs({ store: other, network, encryptionKey }), /INVALID/)
  t.ok(
    new Blobs({ store: store.namespace('x'), network, encryptionKey }),
    'a session of its store is fine'
  )
})

test('construction: encryptionKey is required, the identity never stands in', async (t) => {
  const { store } = await makeStore(t)
  const identity = await Identity.create()
  t.exception.all(() => new Blobs({ store, identity }), /encryptionKey is required/)
})

test('construction: accepts explicit encryptionKey', async (t) => {
  const { store } = await makeStore(t)
  const encryptionKey = b4a.alloc(32, 1)
  const blobs = new Blobs({ store, encryptionKey })
  t.alike(blobs.encryptionKey, encryptionKey)
})

// ─── lifecycle ────────────────────────────────────────────────────────────

test('ready/close: opens and closes cleanly', async (t) => {
  const { store } = await makeStore(t)
  const blobs = new Blobs({ store, encryptionKey: Identity.randomBytes(32) })
  await blobs.ready()
  t.is(blobs.opened, true)
  t.ok(blobs.key)
  t.ok(blobs.discoveryKey)
  t.is(typeof blobs.id, 'string')
  t.ok(blobs.hyperblobs)
  await blobs.close()
  t.is(blobs.closed, true)
})

test('ready is idempotent', async (t) => {
  const { blobs } = await makeBlobs(t)
  await blobs.ready()
  await blobs.ready()
  t.is(blobs.opened, true)
})

test('close is idempotent', async (t) => {
  const { store } = await makeStore(t)
  const blobs = new Blobs({ store, encryptionKey: Identity.randomBytes(32) })
  await blobs.ready()
  await blobs.close()
  await blobs.close()
  t.is(blobs.closed, true)
})

test('id, key, discoveryKey are null before ready', async (t) => {
  const { store } = await makeStore(t)
  const blobs = new Blobs({ store, encryptionKey: Identity.randomBytes(32) })
  t.is(blobs.id, null)
  t.is(blobs.key, null)
  t.is(blobs.discoveryKey, null)
  t.teardown(() => blobs.close().catch(() => {}), { order: 1 })
})

// ─── put / get: buffer ────────────────────────────────────────────────────

test('put(buffer) returns a raw blobId; get(blobId) returns same bytes', async (t) => {
  const { blobs } = await makeBlobs(t)
  const data = b4a.from('hello world')
  const blobId = await blobs.put(data)
  t.is(typeof blobId.blockOffset, 'number')
  t.is(typeof blobId.byteLength, 'number')
  const out = await blobs.get(blobId)
  t.alike(out, data)
})

test('put(buffer) works with Uint8Array input', async (t) => {
  const { blobs } = await makeBlobs(t)
  const data = new Uint8Array([1, 2, 3, 4, 5])
  const blobId = await blobs.put(data)
  const out = await blobs.get(blobId)
  t.alike(b4a.toBuffer(out), b4a.from([1, 2, 3, 4, 5]))
})

test('put(buffer): blobId.byteLength matches the input size', async (t) => {
  const { blobs } = await makeBlobs(t)
  const data = b4a.alloc(1024 * 256, 7) // 256 KB
  const blobId = await blobs.put(data)
  t.is(blobId.byteLength, data.byteLength)
  const out = await blobs.get(blobId)
  t.alike(out, data)
})

// ─── put / get: stream ────────────────────────────────────────────────────

test('put(stream) returns a blobId; get(blobId) returns concatenated bytes', async (t) => {
  const { blobs } = await makeBlobs(t)
  const chunks = [b4a.from('one '), b4a.from('two '), b4a.from('three')]
  const blobId = await blobs.put(streamFromChunks(chunks))
  t.is(typeof blobId.blockOffset, 'number')
  const out = await blobs.get(blobId)
  t.alike(out, b4a.concat(chunks))
})

test('put(stream) streams many chunks without buffering all of them', async (t) => {
  const { blobs } = await makeBlobs(t)
  const chunks = []
  for (let i = 0; i < 64; i++) chunks.push(b4a.alloc(8192, i & 0xff))
  const blobId = await blobs.put(streamFromChunks(chunks))
  t.is(blobId.byteLength, 64 * 8192)
  const out = await blobs.get(blobId)
  t.alike(out, b4a.concat(chunks))
})

// ─── positional ids ──────────────────────────────────────────────────────

test('put: identical bytes get distinct positional blobIds (no dedup)', async (t) => {
  const { blobs } = await makeBlobs(t)
  const data = b4a.from('same content')
  const a = await blobs.put(data)
  const b = await blobs.put(data)
  t.not(a.blockOffset, b.blockOffset)
  t.alike(await blobs.get(a), data)
  t.alike(await blobs.get(b), data)
})

// ─── createReadStream (stream out) ───────────────────────────────────────

test('createReadStream(blobId) returns a Readable with original bytes', async (t) => {
  const { blobs } = await makeBlobs(t)
  const data = b4a.from('streaming back out')
  const blobId = await blobs.put(data)
  const out = await streamToBuffer(blobs.createReadStream(blobId))
  t.alike(out, data)
})

// ─── clear ───────────────────────────────────────────────────────────────

test('clear(blobId): get with wait:false returns null afterwards', async (t) => {
  const { blobs } = await makeBlobs(t)
  const blobId = await blobs.put(b4a.from('temp'))
  t.alike(await blobs.get(blobId), b4a.from('temp'))
  await blobs.clear(blobId)
  const out = await blobs.get(blobId, { wait: false })
  t.is(out, null)
})

// ─── escape hatch ────────────────────────────────────────────────────────

test('blobs.hyperblobs exposes the underlying instance', async (t) => {
  const { blobs } = await makeBlobs(t)
  t.ok(blobs.hyperblobs)
  t.is(typeof blobs.hyperblobs.put, 'function')
  t.is(typeof blobs.hyperblobs.get, 'function')
})

// ─── input validation ───────────────────────────────────────────────────

test('put: null/undefined input rejected', async (t) => {
  const { blobs } = await makeBlobs(t)
  await t.exception.all(() => blobs.put(null), /input is required/)
  await t.exception.all(() => blobs.put(undefined), /input is required/)
})

test('put: non-buffer non-stream input rejected', async (t) => {
  const { blobs } = await makeBlobs(t)
  await t.exception.all(() => blobs.put(42), /buffer or a Readable/)
  await t.exception.all(() => blobs.put('a string'), /buffer or a Readable/)
  await t.exception.all(() => blobs.put({}), /buffer or a Readable/)
})

// ─── methods after close ────────────────────────────────────────────────

test('methods after close throw', async (t) => {
  const { store } = await makeStore(t)
  const blobs = new Blobs({ store, encryptionKey: Identity.randomBytes(32) })
  await blobs.ready()
  const blobId = await blobs.put(b4a.from('ok'))
  await blobs.close()
  await t.exception.all(() => blobs.put(b4a.from('x')), /closed/)
  await t.exception.all(() => blobs.get(blobId), /closed/)
  await t.exception.all(() => blobs.clear(blobId), /closed/)
  t.exception(() => blobs.createReadStream(blobId), /closed/)
})

// ─── reopen by key ───────────────────────────────────────────────────────

test('open existing blob store by key on a separate store', async (t) => {
  const { store: storeA } = await makeStore(t)
  const encryptionKey = Identity.randomBytes(32)
  const a = new Blobs({ store: storeA, encryptionKey })
  await a.ready()
  await a.put(b4a.from('persist me'))
  const key = a.key
  await a.close()

  const { store: storeB } = await makeStore(t)
  const b = new Blobs({ store: storeB, encryptionKey, key })
  await b.ready()
  t.teardown(() => b.close().catch(() => {}))
  t.alike(b.key, key)
})

// ─── id codec (coreKey + raw blobId + type) ──────────────────────────────

const sampleKey = () => b4a.alloc(32, 0xab)
const sampleBlobId = () => ({ blockOffset: 3, blockLength: 1, byteOffset: 4096, byteLength: 128 })

test('encodeId/decodeId round-trips coreKey, blobId and type', (t) => {
  const coreKey = sampleKey()
  const blobId = sampleBlobId()
  const id = encodeId(coreKey, blobId, 'image/png')
  t.is(typeof id, 'string')
  t.ok(id.length > 0)
  const out = decodeId(id)
  t.alike(out.coreKey, coreKey)
  t.alike(out.blobId, blobId)
  t.is(out.type, 'image/png')
})

test('encodeId/decodeId round-trips a blobId field > 4 GiB', (t) => {
  const big = 0x1_0000_0001 // 4 GiB + 1, overflows uint32
  const coreKey = sampleKey()
  const blobId = { blockOffset: 70000, blockLength: 42, byteOffset: big, byteLength: big + 12345 }
  const id = encodeId(coreKey, blobId, 'video/mp4')
  const out = decodeId(id)
  t.alike(out.coreKey, coreKey)
  t.alike(out.blobId, blobId)
  t.is(out.type, 'video/mp4')
})

test('encodeId/decodeId round-trips an empty type', (t) => {
  const coreKey = sampleKey()
  const blobId = sampleBlobId()
  const id = encodeId(coreKey, blobId, '')
  const out = decodeId(id)
  t.is(out.type, '')
  t.alike(out.coreKey, coreKey)
  t.alike(out.blobId, blobId)
})

test('decodeId rejects a non-string id', (t) => {
  t.exception.all(() => decodeId(null), /id must be/)
  t.exception.all(() => decodeId(123), /id must be/)
  t.exception.all(() => decodeId(''), /id must be/)
})

test('decodeId rejects an id that is not valid z32', (t) => {
  t.exception.all(() => decodeId('!!!not-valid-z32!!!'), /valid z32/)
})

test('decodeId rejects a truncated payload', (t) => {
  const short = z32.encode(b4a.alloc(8))
  t.exception.all(() => decodeId(short), /malformed|id/)
})

// ─── replication ────────────────────────────────────────────────────────

// Build A (writer) + B (replica of A) connected over the testnet.
async function makeReplicationPair(t, { topic } = {}) {
  const testnet = await makeTestnet(t)
  const { store: storeA } = await makeStore(t)
  const { store: storeB } = await makeStore(t)
  const netA = await makeNet(t, testnet, { store: storeA })
  const netB = await makeNet(t, testnet, { store: storeB })

  const blobsA = new Blobs({
    store: storeA,
    network: netA,
    encryptionKey: Identity.randomBytes(32)
  })
  await blobsA.ready()
  t.teardown(() => blobsA.close().catch(() => {}), { order: 1 })

  const blobsB = new Blobs({
    store: storeB,
    network: netB,
    key: blobsA.key,
    encryptionKey: blobsA.encryptionKey
  })
  await blobsB.ready()
  t.teardown(() => blobsB.close().catch(() => {}), { order: 1 })

  await connectPair(t, netA, netB, topic || blobsA.discoveryKey)

  return { blobsA, blobsB, netA, netB }
}

test('replication: peer B reads a blob put on peer A', async (t) => {
  const { blobsA, blobsB } = await makeReplicationPair(t)
  const payload = b4a.from('replicated payload')
  const blobId = await blobsA.put(payload)
  const out = await blobsB.get(blobId)
  t.alike(out, payload)
})

test('replication: 1 MB blob round-trips across the wire', async (t) => {
  const { blobsA, blobsB } = await makeReplicationPair(t)
  const payload = b4a.alloc(1024 * 1024, 7)
  const blobId = await blobsA.put(payload)
  const out = await blobsB.get(blobId)
  t.alike(out, payload)
})

test('replication: stream blob read from peer', async (t) => {
  const { blobsA, blobsB } = await makeReplicationPair(t)
  const chunks = [b4a.from('alpha '), b4a.from('beta '), b4a.from('gamma')]
  const blobId = await blobsA.put(streamFromChunks(chunks))
  const out = await streamToBuffer(blobsB.createReadStream(blobId))
  t.alike(out, b4a.concat(chunks))
})

test('replication: rides the connections a network already has, joining no topic of its own', async (t) => {
  const { blobsA, blobsB, netA, netB } = await makeReplicationPair(t, { topic: randomTopic() })
  t.absent(netA.swarm.status(blobsA.discoveryKey), 'the writer joined no blob topic')
  t.absent(netB.swarm.status(blobsB.discoveryKey), 'nor the reader')
  const payload = b4a.from('over the room link')
  const blobId = await blobsA.put(payload)
  t.alike(await blobsB.get(blobId), payload)
})
