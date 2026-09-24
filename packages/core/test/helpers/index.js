import createTestnet from '@hyperswarm/testnet'
import Hyperswarm from 'hyperswarm'
import BlindPeer from 'blind-peer'
import b4a from 'b4a'
import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import { Duplex, Readable } from 'streamx'

import { Network } from '../../src/network/index.js'
import { Database } from '../../src/database/index.js'
import { Identity } from '../../src/identity/index.js'
import { spec } from '../fixtures/spec/index.js'

// ─── generic ──────────────────────────────────────────────────────────────

export function once(emitter, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout)
    emitter.once(event, (...args) => {
      clearTimeout(timer)
      resolve(args.length === 1 ? args[0] : args)
    })
  })
}

export function randomTopic() {
  const topic = b4a.alloc(32)
  for (let i = 0; i < 32; i++) topic[i] = Math.floor(Math.random() * 256)
  return topic
}

// ─── stream helpers ───────────────────────────────────────────────────────

// Two streamx Duplex streams piped end-to-end. Writes on one push on the other.
export function pair() {
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

export function streamFromChunks(chunks) {
  let i = 0
  return new Readable({
    read(cb) {
      if (i >= chunks.length) this.push(null)
      else this.push(chunks[i++])
      cb(null)
    }
  })
}

export async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return b4a.concat(chunks)
}

/**
 * Drain a live snapshot stream with one continuous reader, matching each snapshot
 * against `expected` in order: a function is invoked with the snapshot (custom
 * assertions), anything else is deep-compared via `t.alike`. Resolves once the
 * queue empties. One `for await` never detaches mid-stream — repeated `once('data')`
 * does, which races streamx and drops emissions.
 *
 * @param {object} t
 * @param {import('streamx').Readable} stream
 * @param {Array<object | ((snap: object) => void)>} expected
 * @returns {Promise<void>}
 */
export function observe(t, stream, expected) {
  const queue = expected.slice()
  return (async () => {
    try {
      for await (const snap of stream) {
        const check = queue.shift()
        if (typeof check === 'function') check(snap)
        else t.alike(snap, check)
        if (queue.length === 0) break
      }
    } catch {}
  })()
}

// ─── storage helpers ──────────────────────────────────────────────────────

export async function makeStore(t, { columnFamilies = [] } = {}) {
  const dir = await t.tmp()
  const root = new HypercoreStorage(dir, columnFamilies.length ? { columnFamilies } : undefined)
  await root.ready()
  const store = new Corestore(root, { manifestVersion: 2 })
  await store.ready()
  t.teardown(
    async () => {
      try {
        await store.close()
      } catch {}
      try {
        await root.close()
      } catch {}
    },
    { order: 50 }
  )
  return { store, root, dir }
}

// ─── network helpers ──────────────────────────────────────────────────────

export async function makeTestnet(t, size = 3) {
  const net = await createTestnet(size)
  t.teardown(() => net.destroy(), { order: 100 })
  return net
}

export async function makeNet(t, testnet, opts = {}) {
  // tight reconnect tiers: the default escalates to ~10min after a few local
  // connection resets and strands tests long past their own timeout
  const net = new Network({
    bootstrap: testnet.bootstrap,
    backoffs: [300, 800, 1500, 3000],
    ...opts
  })
  await net.ready()
  t.teardown(() => net.close().catch(() => {}), { order: 1 })
  return net
}

export async function makePair(t, testnet) {
  const a = await makeNet(t, testnet)
  const b = await makeNet(t, testnet)
  return { a, b }
}

export async function connectPair(t, a, b, topic = randomTopic()) {
  const da = a.join(topic)
  const db = b.join(topic)
  await Promise.all([da.flush(), db.flush()])
  // testnet quirk: re-activate after both flushed to force a fresh lookup
  await da.activate()
  await db.activate()
  await Promise.all([waitForConnection(a), waitForConnection(b)])
  t.teardown(() => Promise.all([da.destroy(), db.destroy()]).catch(() => {}), { order: 2 })
  return { da, db, topic }
}

// When both peers dial at once and one leg fails to holepunch, hyperswarm
// drops the working connection in favour of the half-open one (its duplicate
// guard prefers the new connection once bytes have flowed), then gives up on
// the peer after a few retries and only looks again ten minutes later — look
// again ourselves
export async function waitForConnection(net, timeout = 30000) {
  const deadline = Date.now() + timeout
  let lookupAt = Date.now() + 2000
  while (Date.now() < deadline) {
    if (net.connections.size > 0) {
      await new Promise((r) => setTimeout(r, 200))
      if (net.connections.size > 0) return
    }
    if (Date.now() >= lookupAt) {
      lookupAt = Date.now() + 2000
      for (const d of net._discoveries) d.session.refresh().catch(() => {})
    }
    await new Promise((resolve) => {
      const onConn = () => {
        net.off('connection', onConn)
        resolve()
      }
      net.on('connection', onConn)
      setTimeout(() => {
        net.off('connection', onConn)
        resolve()
      }, 200)
    })
  }
  throw new Error('timeout waiting for stable connection')
}

export async function waitFor(fn, { timeout = 15000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor: condition not met before timeout')
}

export function collect(stream, n, { timeout = 15000 } = {}) {
  const batches = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`collect: ${batches.length}/${n} batches`)),
      timeout
    )
    stream.on('data', (batch) => {
      batches.push(batch)
      if (batches.length >= n) {
        clearTimeout(timer)
        resolve(batches)
      }
    })
    stream.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export function replay(batches) {
  const map = new Map()
  for (const { changes, reset } of batches) {
    if (reset) map.clear()
    for (const { prev, next } of changes) {
      const id = (next || prev).id
      if (next) map.set(id, next)
      else map.delete(id)
    }
  }
  return map
}

// ─── blind-peer mirror (real, in-process) ─────────────────────────────────

export async function makeMirror(t, testnet) {
  return (await makeBlindPeer(t, testnet)).publicKey
}

export async function makeBlindPeer(t, testnet) {
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const dir = await t.tmp()
  const mirror = new BlindPeer(dir, { swarm })
  await mirror.listen()
  t.teardown(
    async () => {
      try {
        await mirror.close()
      } catch {}
      try {
        await swarm.destroy()
      } catch {}
    },
    { order: 80 }
  )
  return mirror
}

// the mirror holds every block of what joiners need: the writer core, the bootstrap core and each view
export async function waitForMirrored(db) {
  const cores = [db.bee.local, db.bee.bootstrap, ...db.bee.views()].map((c) =>
    db.store.get({ key: c.key })
  )
  await Promise.all(cores.map((c) => c.ready()))
  try {
    await waitFor(() =>
      cores.every((c) => c.peers.some((p) => p.remoteContiguousLength >= c.length))
    )
  } finally {
    await Promise.all(cores.map((c) => c.close()))
  }
}

export async function fetch(...args) {
  const f = globalThis.fetch || (await import('bare-fetch')).default
  return f(...args)
}

// a database on its own network, joined to its topic
export async function makePeer(t, testnet, { topic, presence, mirrors, ...opts } = {}) {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = opts.identity || (await Identity.create())
  // only mirrors need the store on the network
  const network = new Network({
    bootstrap: testnet.bootstrap,
    store: mirrors && store,
    presence,
    mirrors
  })
  await network.ready()
  topic ??= identity.topic
  const discovery = network.join(topic)
  await discovery.flush()
  const errors = []
  const db = new Database({
    store,
    identity,
    network,
    spec,
    onerror: (err) => errors.push(err),
    ...opts
  })
  await db.ready()
  t.teardown(
    async () => {
      await db.close().catch(() => {})
      await discovery.destroy().catch(() => {})
      await network.close().catch(() => {})
    },
    { order: 5 }
  )
  return { db, store, identity, network, discovery, topic, errors }
}

// genesis admits the first member at any rank
export async function withRole(t, role, opts = {}) {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = await Identity.create()
  const db = new Database({ store, identity, spec, ...opts })
  await db.ready()
  t.teardown(() => db.close().catch(() => {}), { order: 5 })
  const ts = Date.now()
  const member = {
    id: identity.id,
    key: db.writerKey,
    role,
    name: 'me',
    createdAt: ts,
    updatedAt: ts
  }
  await db.write([
    ['add-writer', db._admission(db.writerKey, ts)],
    ['add-member', member]
  ])
  return { db, identity }
}
