import crypto from 'crypto'

import { stats } from './stats.js'
import { serve } from './server.js'
import { redact } from './redact.js'
import { loopback } from './transport.js'

/**
 * An applied-op event fed into the ring buffer.
 *
 * @typedef {{ op: string, name: string, row: Record<string, unknown>, writerKey: Buffer, seq: number }} OpEvent
 */

/**
 * A periodic `stats(me)` sample. See `stats()` for the field meanings.
 *
 * @typedef {{ handleId: string, network: { connections: number, peers: number, dht: object | null }, bee: { local: number }, cores: Array<{ length: number, byteLength: number, peers: number }>, at: number }} StatsSample
 */

/**
 * `cero.use(devtools())` tap extension. Bound to the root handle's lifecycle, it feeds
 * every applied op into a bounded ring buffer, samples `stats(me)` on an interval, and
 * serves a read-only inspection.
 *
 * @param {{ port?: number, host?: string, token?: string | false, bufferSize?: number, sampleInterval?: number, redact?: ((ref: string, row: Record<string, unknown>) => Record<string, unknown>) | { fields?: string[], match?: (key: string, value: unknown, path: string) => boolean, deny?: RegExp | false }, transport?: { accept(handler: (stream: object) => void): void } }} [opts]
 * @returns {{ setup(me: object): () => void }}
 */
export function devtools(opts = {}) {
  return {
    setup(me) {
      const events = new Ring(opts.bufferSize ?? 1000)
      const sampler = new Sampler(me, opts.sampleInterval ?? 1000)
      const redactor = makeRedactor(opts.redact)
      // any local process can dial the port, so a per-run token gates the tap
      const token =
        opts.token === false ? null : opts.token || crypto.randomBytes(16).toString('hex')
      const transport =
        opts.transport || loopback({ port: opts.port ?? 9111, host: opts.host, token })
      const offs = []
      const servers = new Set()

      const follow = (handle) => {
        const off = handle.store.onApply((e) =>
          events.push(redactor ? { ...e, row: redactor(e.name, e.row) } : e)
        )
        offs.push(off)
        if (handle !== me) handle.once('close', off)
      }

      follow(me)
      for (const child of me.children) follow(child)
      me.on('handle', (child) => follow(child), { signal: me.signal })

      transport.accept((stream) => {
        const server = serve(stream, me, { events, stats: sampler, redact: redactor, token })
        servers.add(server)
        stream.on('close', () => servers.delete(server))
      })

      return () => {
        sampler.stop()
        for (const off of offs) off()
        for (const server of servers) server.close()
        servers.clear()
        if (!opts.transport && transport.close) transport.close() // close the loopback we opened
      }
    }
  }
}

function makeRedactor(opt) {
  if (opt === false) return null // explicit opt-out only; redaction is on by default
  if (typeof opt === 'function') return opt
  return redact(opt || undefined)
}

/** Bounded ring buffer with snapshot + live subscription. */
class Ring {
  constructor(max) {
    this.max = max
    this.items = []
    this.subs = new Set()
  }

  /**
   * Append an event, evicting the oldest if over capacity, then notify subscribers.
   * @param {OpEvent} e
   * @returns {void}
   */
  push(e) {
    this.items.push(e)
    if (this.items.length > this.max) this.items.shift()
    for (const fn of this.subs) fn(e)
  }

  /**
   * Copy of the buffered events.
   * @returns {OpEvent[]}
   */
  snapshot() {
    return this.items.slice()
  }

  /**
   * Subscribe to pushed events.
   * @param {(e: OpEvent) => void} fn
   * @returns {() => boolean} unsubscribe
   */
  subscribe(fn) {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
}

/** Periodic `stats(me)` sampler with snapshot + live subscription. */
class Sampler {
  constructor(me, interval) {
    this.subs = new Set()
    this.latest = stats(me, Date.now())
    this.timer = setInterval(() => {
      this.latest = stats(me, Date.now())
      for (const fn of this.subs) fn(this.latest)
    }, interval)
  }

  /**
   * Most recent stats sample.
   * @returns {StatsSample}
   */
  snapshot() {
    return this.latest
  }

  /**
   * Subscribe to each new stats sample.
   * @param {(latest: StatsSample) => void} fn
   * @returns {() => boolean} unsubscribe
   */
  subscribe(fn) {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  /**
   * Stop the sampling interval.
   * @returns {void}
   */
  stop() {
    clearInterval(this.timer)
  }
}
