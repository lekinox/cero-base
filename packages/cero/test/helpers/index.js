import ReadyResource from 'ready-resource'
import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import createTestnet from '@hyperswarm/testnet'

import { Network } from '@cero-base/core/network'

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

export async function makeNet(t, testnet, identity = null) {
  const opts = { bootstrap: testnet.bootstrap }
  if (identity) opts.identity = identity
  const net = new Network(opts)
  await net.ready()
  t.teardown(() => net.close().catch(() => {}), { order: 1 })
  return net
}

export async function waitForConnection(net, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (net.connections.size > 0) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timeout waiting for connection')
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
  count(name, q) {
    return this.record('count', name, q)
  }
  watch(name, q) {
    this.record('watch', name, q)
    return { on() {}, once() {}, destroy() {} }
  }
  changes(name, q) {
    this.record('changes', name, q)
    return { async *[Symbol.asyncIterator]() {}, on() {}, once() {}, destroy() {} }
  }
  call(name, d) {
    return this.record('call', name, d)
  }
}

export async function fetch(...args) {
  const f = globalThis.fetch || (await import('bare-fetch')).default
  return f(...args)
}
