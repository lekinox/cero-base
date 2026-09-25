import ReadyResource from 'ready-resource'
import b4a from 'b4a'
import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import createTestnet from '@hyperswarm/testnet'
import BlindPeer from 'blind-peer'

import { Network } from '@cero-base/core/network'
import { Identity } from '@cero-base/core/identity'

import { cero, get } from '../../src/index.js'
import { Handle } from '../../src/handle/index.js'
import { Local } from '../../src/local/index.js'
import { spec } from '../fixtures/spec/index.js'

export async function makeStore(t) {
  const dir = await t.tmp()
  const root = new HypercoreStorage(dir)
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

export async function makeTestnet(t, size = 3) {
  const net = await createTestnet(size)
  t.teardown(() => net.destroy(), { order: 100 })
  return net
}

// the store its handle opens from, as cero() gives it: mailbox cores and a join live there
export async function makeNet(t, testnet, identity = null, store = null) {
  store ??= (await makeStore(t)).store
  const opts = { bootstrap: testnet.bootstrap, store }
  if (identity) opts.identity = identity
  const net = new Network(opts)
  await net.ready()
  t.teardown(() => net.close().catch(() => {}), { order: 1 })
  return net
}

// a real blind-peer mirror, in process
export async function makeMirror(t, testnet) {
  const mirror = new BlindPeer(await t.tmp(), { bootstrap: testnet.bootstrap })
  await mirror.listen()
  t.teardown(() => mirror.close().catch(() => {}), { order: 80 })
  return mirror
}

// resolves once the mirror stores the whole core posted to `referrer`
export async function holds(mirror, referrer) {
  const key = await new Promise((resolve) => {
    const onadd = (record) => {
      if (!record.referrer || !b4a.equals(record.referrer, referrer)) return
      mirror.off('add-core', onadd)
      resolve(record.key)
    }
    mirror.on('add-core', onadd)
  })
  const core = mirror.store.get({ key })
  await core.ready()
  await waitUntil(() => core.length > 0 && core.contiguousLength === core.length)
  await core.close()
}

export async function waitForConnection(net, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (net.connections.size > 0) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timeout waiting for connection')
}

// the invites of the joins a device still waits on
export async function joinsOf(me) {
  const { data } = await get(me.joins)
  return data.map((join) => join.invite)
}

// a join waiting on the room's confirm invites, read the way an app reads it; `after` skips one
export function nextRequest(room, after = null) {
  return waitUntil(async () => {
    const { data } = await get(room.requests, { admitted: false })
    return data.find((r) => r.id !== after?.id) || null
  })
}

export async function waitUntil(fn, timeout = 30000, step = 50) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, step))
  }
  throw new Error(
    `timeout (${timeout}ms) waiting for: ${String(fn).replace(/\s+/g, ' ').trim().slice(0, 120)}`
  )
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

export class FakeStore extends ReadyResource {
  constructor(refs = {}) {
    super()
    this.refs = refs
    this.calls = []
  }

  async _open() {}
  async _close() {}

  record(op, name, arg) {
    const call = { op, name, arg }
    this.calls.push(call)
    return call
  }

  put(name, row) {
    return this.record('put', name, row)
  }
  set(name, row) {
    return this.record('set', name, row)
  }
  get(name, q) {
    return this.record('get', name, q)
  }
  del(name, id) {
    return this.record('del', name, id)
  }
  watch(name, q) {
    this.record('watch', name, q)
    return { on() {}, once() {}, destroy() {} }
  }
  call(name, d) {
    return this.record('call', name, d)
  }
}

export async function fetch(...args) {
  const f = globalThis.fetch || (await import('bare-fetch')).default
  return f(...args)
}

// a cero instance in its own directory
export async function ceroOpen(t, opts = {}) {
  const testnet = opts.testnet || (await makeTestnet(t))
  const dir = await t.tmp()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, ...opts })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return { me, dir, testnet }
}

// a bare root handle on its own network, bootstrapped unless it opens a key; `local` adds the
// device store, which keeps per-handle keypairs and joins
export async function openHandle(t, { local, ...opts } = {}) {
  const { store } = await makeStore(t)
  const identity = opts.identity || (await Identity.create())
  const testnet = opts.testnet || (await makeTestnet(t))
  const net = await makeNet(t, testnet, null, store)
  const discovery = net.join(identity.topic)
  await discovery.flush()
  if (local) {
    opts.local = new Local(null, spec, { store })
    await opts.local.ready()
  }
  const me = new Handle({ store, identity, network: net, spec, ...opts })
  await me.ready()
  if (!opts.key) await me.bootstrap({ name: opts.name || null })
  t.teardown(
    async () => {
      await me.close().catch(() => {})
      await discovery.destroy().catch(() => {})
    },
    { order: 5 }
  )
  return { me, store, identity, net, testnet, discovery }
}
