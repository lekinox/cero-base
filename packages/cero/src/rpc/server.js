import c from 'compact-encoding'
import safetyCatch from 'safety-catch'
import AbortController from 'bare-abort-controller'

import { RPCServer, bindCodec } from '@cero-base/core/rpc'
import { CeroError } from '@cero-base/core/errors'

import { cero, restore, link } from '../index.js'
import { peek } from '../lib/peek.js'
import {
  put,
  set,
  get,
  del,
  watch,
  call,
  invite,
  revoke,
  rotate,
  removed,
  accept,
  deny,
  cancel,
  leave,
  suspend,
  resume,
  activate,
  deactivate,
  phrase,
  nearby,
  receive,
  send
} from '../lib/operators.js'

// what a UI reaches by name: these operators, never close or a handle's privates
const VERBS = new Map(
  Object.entries({
    invite,
    revoke,
    rotate,
    removed,
    accept,
    deny,
    cancel,
    suspend,
    resume,
    activate,
    deactivate,
    phrase,
    nearby,
    receive,
    send
  })
)

/**
 * @typedef {import('@cero-base/core/rpc').RPCServer} BaseRPCServer
 *
 * @typedef {object} ServerOpts
 * @property {string} storage   Directory passed to `cero()` for the local store.
 * @property {string} [name]    Optional display name forwarded to `cero()`.
 * @property {Array<{ host: string, port: number }>} [bootstrap]  Custom DHT bootstrap.
 * @property {boolean} [isMobile]
 * @property {(err: Error) => void} [onerror]
 *
 * @typedef {object} Identity
 * @property {string} id        Long-lived cero identity id.
 * @property {string} deviceId  Per-device id.
 * @property {string} deviceName  This device's name, empty when it has none.
 *
 * @typedef {{ ref: import('../lib/refs.js').Ref, codec: import('@cero-base/core/rpc').Codec, info?: import('../lib/spec.js').RefInfo }} RefAndCodec
 *
 * @typedef {import('../lib/spec.js').Spec} Spec
 * @typedef {import('../handle/index.js').Context} Context
 *
 * @typedef {{ data: import('../lib/spec.js').Row | import('../lib/spec.js').Row[] | null, total?: number, size?: number }} GetResult  Single-ref get omits `total`/`size`; list/handle refs include them.
 */

/**
 * IPC-side RPC server for cero. Bridges an `hrpc` channel to a live `Handle` tree: a store that holds an identity
 * boots its root via `cero()` as soon as it opens, so the network is up while the UI still loads; a new one waits
 * for the client to say how, by init, restore or link. Then it exposes data ops, pairing, and handle lifecycle.
 */
export class Server extends RPCServer {
  /**
   * @param {import('streamx').Duplex} ipc  Framed IPC stream (must be writable).
   * @param {Spec} spec
   * @param {Partial<ServerOpts>} [opts]
   */
  constructor(ipc, spec, { storage, ...opts } = {}) {
    if (!spec) throw CeroError.REQUIRED('spec')
    if (!storage) throw CeroError.REQUIRED('storage')
    super(ipc, spec)
    if (spec.local?.schema && !spec.local.codec) bindCodec(spec.local)
    this.storage = storage
    /** @private */
    this._report = opts.onerror || ((err) => console.error(err))
    /** @type {Omit<Partial<ServerOpts>, 'storage'> & { onerror: (err: Error) => void }} */
    this.opts = { ...opts, onerror: (err) => this._onerror(err) }
    /** @type {Set<object>} open error streams, one per connected client */
    this._errors = new Set()
    /** @type {Context | null} */
    this.me = null
    /** @type {Map<string, Context>} */
    this.handles = new Map()
    /** @type {Map<string, Set<object>>} handle id → its open watch streams */
    this._watchStreams = new Map()
    /** @type {Map<string, number>} handle id → the opens the page holds on it, let go when it reloads */
    this._held = new Map()
    /** @private */
    this._booting = null
    /** @private */
    this._adopting = null
    /** @private */
    this._stop = new AbortController()
    this._wireInit()
    this._wireRestore()
    this._wireLink()
  }

  /**
   * Root cero id (undefined until booted).
   *
   * @returns {string|undefined}
   */
  get id() {
    return this.me?.id
  }

  /**
   * Root identity object (undefined until booted).
   *
   * @returns {import('@cero-base/core/identity').Identity | undefined}
   */
  get identity() {
    return this.me?.identity
  }

  /** @private */
  async _open() {
    await super._open()
    if (await peek(this.storage, this.spec, this.opts)) this._start()
  }

  /**
   * Open the root, as `how` says on a new store: a phrase recovers, an invite links, neither creates.
   * @private
   */
  _start(how = {}) {
    const booting = this._boot(how)
    this._booting = booting
    // it surfaces on the request that waits for it; the next one starts over
    booting.catch(() => {
      if (this._booting === booting) this._booting = null
    })
    return booting
  }

  /** @private */
  async _boot(how) {
    // a close stops a recovery or a link still waiting for a device: the next open goes on with it
    const opts = { ...this.opts, ...how, signal: this._stop.signal }
    this.me = await cero(this.storage, this.spec, opts)
    this.handles.set(this.me.id, this.me)
    await this.me.fileServer.listen()
    this._wireData()
    this._wireHandles()
    this._wireVerbs()
  }

  /** @private */
  async _close() {
    this._stop.abort()
    await this._booting?.catch(() => {})
    if (this.me) {
      try {
        await this.me.close()
      } catch {}
    }
    // a link or a restore past its commit resolves with an open root, closed before this ends
    await this._adopting
    await super._close()
  }

  /**
   * The root a restore or a link resolves with is the one served from here on; with the server closing it closes.
   * @private
   */
  _adopt(swapping) {
    const adopted = swapping.then(async (me) => {
      if (this.closing) {
        await me.close()
        throw CeroError.CLOSED('Server')
      }
      this.me = me
      this.handles = new Map([[me.id, me]])
      this._held.clear()
    })
    this._adopting = adopted.catch(() => {})
    return adopted
  }

  /**
   * End every watch stream bound to a handle (e.g. when it closes or leaves).
   * @private
   */
  _endWatches(handle) {
    const set = this._watchStreams.get(handle)
    if (!set) return
    for (const s of set) s.destroy()
    this._watchStreams.delete(handle)
  }

  /** @private */
  _onerror(err) {
    if (!this._errors.size) return this._report(err)
    const frame = {
      message: err?.message || String(err),
      code: err?.code || '',
      stack: err?.stack || '',
      reason: err?.reason || ''
    }
    for (const stream of this._errors) stream.write(frame)
  }

  /**
   * Wire the `errors` and `init` handlers: init waits for the boot and attaches the client.
   * @private
   */
  _wireInit() {
    this.rpc.onErrors((stream) => {
      closeWithWire(stream)
      this._errors.add(stream)
      stream.on('error', safetyCatch)
      stream.on('close', () => this._errors.delete(stream))
    })
    this._on('onInit', async () => {
      await this.ready()
      await (this._booting ?? this._start())
      // a reloaded UI is a new client on the same worker: it re-attaches, its old streams end, and every open the old
      // page held is let go for it, as it never closes them
      for (const handle of this._watchStreams.keys()) this._endWatches(handle)
      await this._letGo()
      return this._identity()
    })
  }

  /**
   * Wire the `restore` handler.
   * @private
   */
  _wireRestore() {
    this._on('onRestore', async ({ phrase }) => {
      await this.ready()
      if (!this._booting) await this._start({ phrase })
      else {
        await this._booting
        await this._adopt(restore(this.me, phrase))
      }
      return this._identity()
    })
  }

  /**
   * Wire the `link` handler: a stream, the request's id as it is sent, the identity once linked.
   * @private
   */
  _wireLink() {
    this.rpc.onLink((stream) => {
      closeWithWire(stream)
      stream.on('error', safetyCatch)
      const run = async () => {
        await this.ready()
        const { invite } = stream.data
        const onrequest = (id) => stream.write({ request: id })
        // as link() waits: the invite's lifetime, a denial ends it
        if (!this._booting) await this._start({ invite, onrequest, recoveryTimeout: 0 })
        else {
          await this._booting
          await this._adopt(link(this.me, invite, { onrequest }))
        }
        stream.write({ request: '', ...this._identity() })
        stream.end()
      }
      run().catch((err) => {
        stream.once('error', () => {})
        stream.writeStream.destroy(err)
        stream.destroy()
      })
    })
  }

  /**
   * Register the row-level RPC handlers (put/set/get/del/watch/call).
   * @private
   */
  _wireData() {
    this._on('onAddFile', async ({ handle, data, name, type }) => {
      const h = this._resolve(handle)
      const { data: file } = await put(h.files, { data, type: type || '', name: name || null })
      const { data: row } = await get(h.files, file.id)
      return { data: h.spec.codec.encodeRow(h.files.schema, row) }
    })

    this._on('onAddRow', async ({ handle, ref, data, local }) => {
      const { ref: r, codec, info } = this._refOf(handle, ref, local)
      const { data: row } = await put(r, received(codec.decodeRow(r.schema, data), info))
      return { data: codec.encodeRow(r.schema, row) }
    })

    this._on('onSet', async ({ handle, ref, data, fields, local, noUpsert }) => {
      const { ref: r, codec, info } = this._refOf(handle, ref, local)
      const row = received(codec.decodeRow(r.schema, data), info, fields)
      const result = await set(r, row, { upsert: !noUpsert })
      return { data: result ? codec.encodeRow(r.schema, result.data) : null }
    })

    this._on('onGet', async ({ handle, ref, query, local }) => {
      const { ref: r, codec } = this._refOf(handle, ref, local)
      const q = fromWire(query)
      return encodeGet(r, codec, q, await get(r, q))
    })

    this._on('onDel', async ({ handle, ref, id, local }) => {
      await del(this._refOf(handle, ref, local).ref, id)
      return {}
    })

    this.rpc.onWatch((stream) => {
      const { handle, ref, local } = stream.data
      let query, r, codec, live
      try {
        query = fromWire(stream.data.query)
        ;({ ref: r, codec } = this._refOf(handle, ref, local))
        live = watch(r, query)
      } catch (err) {
        // forward the error over the wire by destroying the response stream with it
        stream.once('error', () => {})
        stream.writeStream.destroy(err)
        stream.destroy()
        return
      }
      // keep-latest under backpressure: snapshots are idempotent
      let pending = null
      let blocked = false
      const onData = (snap) => {
        if (blocked) {
          pending = snap
          return
        }
        blocked = stream.write(encodeGet(r, codec, query, snap)) === false
        if (blocked) {
          stream.once('drain', () => {
            blocked = false
            if (pending === null) return
            const next = pending
            pending = null
            onData(next)
          })
        }
      }
      let set = this._watchStreams.get(handle)
      if (!set) this._watchStreams.set(handle, (set = new Set()))
      set.add(stream)
      live.on('data', onData)
      // a watch ending with its handle ends the client's
      live.once('close', () => stream.destroy())
      // channel teardown destroys the stream with CHANNEL_CLOSED; 'close' cleans up
      closeWithWire(stream)
      stream.on('error', safetyCatch)
      stream.on('close', () => {
        live.off('data', onData)
        live.destroy()
        this._watchStreams.get(handle)?.delete(stream)
      })
    })

    this._on('onCall', async ({ handle, op, data }) => {
      const h = this._resolve(handle)
      const r = h[op]
      if (!r) throw CeroError.UNKNOWN('ref', op)
      await call(r, h.spec.codec.decodeAction(h, op, data))
      return { data: null }
    })
  }

  /**
   * Register add/open/join/close/leave RPC handlers for child handles.
   * @private
   */
  _wireHandles() {
    this._on('onAddHandle', async ({ handle, ref, data }) => {
      const parent = this._resolve(handle)
      const info = parent.spec.meta.refs?.[ref] || parent.spec.handles?.[ref]
      if (!info) throw CeroError.UNKNOWN('handle type', ref)
      const wire = parent.spec.codec.decodeCreate(data) || {}
      const opts = { name: wire.name }
      const child = await this.me._create(ref, opts)
      const id = child.id
      this._hold(id, child)
      return { id, type: ref, name: opts.name || '' }
    })

    this._on('onOpenHandle', async ({ parent, row, type }) => {
      if (this._resolve(parent) !== this.me) throw CeroError.UNSUPPORTED('nested handles')
      const { data } = await this.me.store.get('handles', row)
      if (!data?.encryptionKey) throw CeroError.UNKNOWN('handle', row)
      const child = await this.me._load(type, row)
      this._hold(row, child)
      return { id: row, type: data.type, name: data.name || '' }
    })

    this._on('onJoin', async ({ parent, ref, invite }) => {
      if (this._resolve(parent) !== this.me) throw CeroError.UNSUPPORTED('nested handles')
      let child
      try {
        child = await this.me._join(invite, ref)
      } catch (err) {
        if (err.code !== 'DENIED') throw err
        return { id: '', type: ref, denied: true, reason: err.reason || '' }
      }
      const id = child.id
      this._hold(id, child)
      return { id, type: ref, name: '' }
    })

    this._on('onCloseHandle', async ({ handle }) => {
      const h = this.handles.get(handle)
      if (!h || h === this.me) return {}
      await this._release(handle, h)
      return {}
    })

    this._on('onLeave', async ({ handle }) => {
      await leave(this._resolve(handle))
      this._held.delete(handle)
      this._endWatches(handle)
      this.handles.delete(handle)
      return {}
    })
  }

  /** @private one open the page holds on `id` */
  _hold(id, h) {
    this.handles.set(id, h)
    this._held.set(id, (this._held.get(id) ?? 0) + 1)
  }

  /** @private one of the page's opens on `id` let go: the handle drops off the wire once nobody here holds it */
  async _release(id, h) {
    const n = (this._held.get(id) ?? 1) - 1
    if (n > 0) this._held.set(id, n)
    else this._held.delete(id)
    await h.close()
    // another holder on this device keeps it, with its watches; a reopen while it is idle registers it again
    if (h._refs > 0) return
    this._endWatches(id)
    this.handles.delete(id)
  }

  /** @private every open the page holds let go: a reload, whose old page closes nothing */
  async _letGo() {
    for (const [id, n] of [...this._held]) {
      const h = this.handles.get(id)
      for (let i = 0; i < n && h; i++) await this._release(id, h).catch(safetyCatch)
    }
    this._held.clear()
  }

  /**
   * Register the `verb` handler: the operator by its name, on the handle, as in the worker.
   * @private
   */
  _wireVerbs() {
    this._on('onVerb', async ({ handle, verb, args }) => {
      const run = VERBS.get(verb)
      if (!run) throw CeroError.UNKNOWN('verb', verb)
      const data = await run(this._resolve(handle), ...c.decode(c.any, args))
      return { data: data === undefined ? null : c.encode(c.any, data) }
    })
  }

  /**
   * Register a request handler whose error fails only its call.
   * @private
   */
  _on(name, fn) {
    this.rpc[name](async (req) => {
      try {
        return await fn(req)
      } catch (err) {
        if (!CeroError.isCeroError(err)) this._onerror(err)
        // bare-rpc rethrows a TypeError or a RangeError and ends the worker
        throw Object.assign(new Error(err.message), { code: err.code, reason: err.reason })
      }
    })
  }

  /**
   * Look up a live handle by id, throwing if unknown. Binds the handle's
   * codec on first use.
   *
   * @param {string} id
   * @returns {Context}
   * @private
   */
  _resolve(id) {
    const h = this.handles.get(id)
    if (!h) throw CeroError.UNKNOWN('handle', id)
    if (!h.spec.codec) bindCodec(h.spec)
    return h
  }

  /**
   * Resolve a `{ handle, ref }` pair to its `Ref` and codec.
   *
   * @param {string} id
   * @param {string} name
   * @param {boolean} [local]
   * @returns {RefAndCodec}
   * @private
   */
  _refOf(id, name, local) {
    if (local) {
      const info = this.spec.meta.local?.refs?.[name]
      if (!info || info.internal) throw CeroError.UNKNOWN('local ref', name)
      return { ref: this.me.local[name], codec: this.spec.local.codec, info }
    }
    const h = this._resolve(id)
    const info = h.spec.meta.refs?.[name]
    if (!info) throw CeroError.UNKNOWN('ref', name)
    return { ref: h[name], codec: h.spec.codec, info }
  }

  /**
   * Snapshot the current identity for return to the client.
   *
   * @returns {Identity}
   * @private
   */
  _identity() {
    const fs = this.me.fileServer
    return {
      id: this.me.id,
      deviceId: this.me.device?.id || '',
      deviceName: this.me.device?.name || '',
      fileBase: `http://127.0.0.1:${fs.port}`,
      fileToken: fs.server.token || ''
    }
  }
}

/**
 * Construct a `Server`, wait for it to be ready, and return it.
 *
 * @param {import('streamx').Duplex} ipc
 * @param {Spec} spec
 * @param {ServerOpts} opts
 * @returns {Promise<Server>}
 */
export async function serve(ipc, spec, opts) {
  const server = new Server(ipc, spec, opts)
  await server.ready()
  return server
}

// hrpc destroys only the wire's stream when the client drops it, never the one a handler holds
function closeWithWire(stream) {
  stream.writeStream.once('close', () => stream.destroy())
}

// a query crosses as the client wrote it; no bytes is no query
function fromWire(buf) {
  return buf ? c.decode(c.any, buf) : undefined
}

/**
 * One row for an id or a single ref, the list otherwise; total is int on the wire: -1 encodes null.
 * @param {GetResult} res
 */
function encodeGet(r, codec, query, { data, total, size }) {
  const one = typeof query === 'string' || r.kind === 'single'
  const wire = toIds(r)
  return {
    data: one ? codec.encodeRow(r.schema, wire(data)) : codec.encodeRows(r.schema, data?.map(wire)),
    total: total ?? -1,
    size: size ?? 0
  }
}

// a read resolves file fields to { id, type, size, url }, which a typed row cannot carry: the wire
// takes the id, and the client builds the same file from it
function toIds(r) {
  const fields = r.name === 'files' ? null : r.handle.store?.refs?.[r.name]?.files
  if (!fields?.length) return (row) => row
  return (row) => {
    if (!row) return row
    const out = { ...row }
    for (const f of fields) if (out[f] && typeof out[f] === 'object') out[f] = out[f].id
    return out
  }
}

// a typed row decodes every field, the ones the client left out as defaults: keep what was sent
function received(row, info, sent = null) {
  const declared = info?.fields
  if (!declared) return row
  const out = row.id ? { id: row.id } : {}
  for (const i of sent ?? declared.keys()) out[declared[i]] = row[declared[i]]
  return out
}
