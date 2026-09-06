import { get, count, watch } from '@cero-base/cero'

import { Framed } from './protocol.js'

/**
 * A decoded request frame. Carries the correlation `id` and `method`, plus the
 * per-method fields a handler reads: `ref`, `handleId`, `query`, `cancelId`.
 * @typedef {{ id?: string, method?: string, ref?: string, handleId?: string, query?: object, cancelId?: string }} ReqFrame
 */

/**
 * Read-only inspection server over a local Duplex `stream`.
 *
 * @param {object} stream  A streamx Duplex carrying length-prefixed JSON frames.
 * @param {object} me  The live root cero handle.
 * @param {{ events?: { snapshot(): unknown, subscribe(fn: (e: object) => void): () => void }, stats?: { snapshot(): unknown, subscribe(fn: (s: object) => void): () => void }, redact?: (ref: string, row: Record<string, unknown>) => Record<string, unknown> }} [opts]
 * @returns {{ close(): void }}
 */
export function serve(stream, me, opts) {
  return new TapServer(stream, me, opts)
}

export class TapServer {
  constructor(stream, me, opts = {}) {
    this.stream = stream
    this.me = me
    this.redact = opts.redact || ((ref, row) => row)
    this.opts = opts
    this.tracked = new Map()
    this._authed = !opts.token
    this.wire = new Framed(stream, (req) => this.onRequest(req))
    this._cleanup = () => this._teardown()
    stream.on('close', this._cleanup)
    // a socket reset must not crash the host
    stream.on('error', this._cleanup)
  }

  /**
   * Dispatch an inbound request frame to its named method handler.
   * @param {ReqFrame} req  A decoded request frame, expected to carry `id` and `method`.
   * @returns {Promise<void>}
   */
  async onRequest(req) {
    // a malformed frame (JSON null / scalar) has no method — ignore it
    if (!req || typeof req !== 'object') return
    // the first frame must carry the token, one shot
    if (!this._authed) {
      if (req.token !== this.opts.token) return this.stream.destroy()
      this._authed = true
    }
    const handler = this[req.method]
    if (!handler || !METHODS.has(req.method)) {
      this._send({
        id: req.id,
        ok: false,
        error: `unknown method '${req.method}'`,
        code: 'UNKNOWN'
      })
      return
    }
    try {
      await handler.call(this, req)
    } catch (err) {
      this._send({ id: req.id, ok: false, error: String(err.message || err), code: err.code })
    }
  }

  /**
   * Reply with the root handle and its direct children as `{ id, type }` rows.
   * @param {ReqFrame} req  A request frame carrying `id`.
   * @returns {void}
   */
  handles(req) {
    const me = this.me
    const data = [
      { id: me.id, type: 'root' },
      ...[...(me.children || [])].map((c) => ({ id: c.id, type: c.type || null }))
    ]
    this._send({ id: req.id, ok: true, data })
  }

  /**
   * Read a ref once and reply with the redacted result.
   * @param {ReqFrame} req  A request frame carrying `id`, `ref`, `handleId` and `query`.
   * @returns {Promise<void>}
   */
  async get(req) {
    const ref = this._resolveRef(req)
    const r = await get(ref, req.query)
    const data = Array.isArray(r.data)
      ? r.data.map((row) => this.redact(req.ref, row))
      : r.data && this.redact(req.ref, r.data)
    this._send({ id: req.id, ok: true, data: { ...r, data } })
  }

  /**
   * Count rows for a ref and reply with the total.
   * @param {ReqFrame} req  A request frame carrying `id`, `ref`, `handleId` and `query`.
   * @returns {Promise<void>}
   */
  async count(req) {
    const ref = this._resolveRef(req)
    this._send({ id: req.id, ok: true, data: (await count(ref, req.query)).data })
  }

  /**
   * Stream redacted live updates for a ref until cancelled or the stream ends.
   * @param {ReqFrame} req  A request frame carrying `id`, `ref`, `handleId` and `query`.
   * @returns {void}
   */
  watch(req) {
    const ref = this._resolveRef(req)
    const s = watch(ref, req.query)
    this._track(req.id, () => s.destroy())
    s.on('data', (d) => {
      const data = Array.isArray(d.data) ? d.data.map((row) => this.redact(req.ref, row)) : d.data
      this._send({ id: req.id, frame: { ...d, data } })
    })
    s.on('end', () => this._send({ id: req.id, end: true }))
    // a watch-stream error must not crash the host — end the client stream cleanly
    s.on('error', () => {
      this._drop(req.id)
      this._send({ id: req.id, end: true })
    })
  }

  /**
   * Stream the events source snapshot then live events.
   * @param {ReqFrame} req  A request frame carrying `id`.
   * @returns {void}
   */
  events(req) {
    this._source(req, this.opts.events)
  }

  /**
   * Stream the stats source snapshot then live stats.
   * @param {ReqFrame} req  A request frame carrying `id`.
   * @returns {void}
   */
  stats(req) {
    this._source(req, this.opts.stats)
  }

  /**
   * Stop a tracked stream by id and release its resources.
   * @param {ReqFrame} req  A request frame carrying `cancelId`.
   * @returns {void}
   */
  cancel(req) {
    this._drop(req.cancelId)
  }

  /**
   * Tear down all tracked streams and destroy the underlying stream.
   * @returns {void}
   */
  close() {
    this._teardown()
    this.stream.destroy()
  }

  _resolveRef(req) {
    const me = this.me
    const handle =
      req.handleId === me.id || !req.handleId
        ? me
        : [...(me.children || [])].find((c) => c.id === req.handleId)
    const info = handle?.spec?.meta?.refs?.[req.ref]
    if (!handle || !info) throw new CodeError('UNKNOWN', `unknown ref '${req.ref}'`)
    return handle[req.ref]
  }

  _source(req, src) {
    if (!src) {
      this._send({ id: req.id, end: true })
      return
    }
    const snap = src.snapshot()
    const items = Array.isArray(snap) ? snap : snap == null ? [] : [snap]
    for (const item of items) this._send({ id: req.id, frame: item })
    const off = src.subscribe((e) => this._send({ id: req.id, frame: e }))
    this._track(req.id, off)
  }

  _track(id, off) {
    this.tracked.set(id, off)
  }

  _drop(id) {
    const off = this.tracked.get(id)
    if (off) {
      this.tracked.delete(id)
      off()
    }
  }

  _send(obj) {
    this.wire.send(obj)
  }

  _teardown() {
    for (const off of this.tracked.values()) off()
    this.tracked.clear()
  }
}

const METHODS = new Set(['handles', 'get', 'count', 'watch', 'events', 'stats', 'cancel'])

class CodeError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
