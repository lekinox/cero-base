import c from 'compact-encoding'
import safetyCatch from 'safety-catch'

import { RPCServer, bindCodec } from '@cero-base/core/rpc'
import { CeroError } from '@cero-base/core/errors'

import { cero, restore, toSeed } from '../index.js'
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
  cancel,
  leave,
  suspend,
  resume,
  activate,
  deactivate,
  phrase,
  nearby
} from '../lib/operators.js'

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
 * @property {string} deviceId  Per-device id (empty when no `local` spec).
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
 * IPC-side RPC server for cero. Bridges an `hrpc` channel to a live `Handle` tree: boots the
 * root via `cero()` as soon as it opens, so the network is up while the UI still loads, then
 * exposes data ops, pairing, and handle lifecycle.
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
    /** @private */
    this._booting = null
    this._wireInit()
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
    this._booting = this._boot()
    // it surfaces on init
    this._booting.catch(() => {})
  }

  /** @private */
  async _boot() {
    this.me = await cero(this.storage, this.spec, this.opts)
    this.handles.set(this.me.id, this.me)
    await this.me.fileServer.listen()
    this._wireData()
    this._wirePairing()
    this._wireHandles()
    this._wireRestore()
    this._wireSeed()
  }

  /** @private */
  async _close() {
    await this._booting?.catch(() => {})
    if (this.me) {
      try {
        await this.me.close()
      } catch {}
    }
    await super._close()
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
      this._errors.add(stream)
      stream.on('error', safetyCatch)
      stream.on('close', () => this._errors.delete(stream))
    })
    this.rpc.onInit(async () => {
      await this._booting
      // a reloaded UI is a new client on the same worker: it re-attaches, its old streams end
      for (const handle of this._watchStreams.keys()) this._endWatches(handle)
      return this._identity()
    })
  }

  /**
   * Wire the `restore` handler. The phrase becomes a seed here: the UI cannot load the crypto it takes.
   * @private
   */
  _wireRestore() {
    this.rpc.onRestore(async ({ phrase }) => {
      if (!this.me) throw CeroError.NOT_READY('Server', 'server')
      this.me = await restore(this.me, toSeed(phrase))
      this.handles = new Map([[this.me.id, this.me]])
      return this._identity()
    })
  }

  /**
   * Register the row-level RPC handlers (put/set/get/del/watch/call).
   * @private
   */
  _wireData() {
    this.rpc.onAddFile(async ({ handle, data, name, type }) => {
      const h = this._resolve(handle)
      const { data: file } = await put(h.files, { data, type: type || '', name: name || null })
      const { data: row } = await get(h.files, file.id)
      return { data: h.spec.codec.encodeRow(h.files.schema, row) }
    })

    this.rpc.onAddRow(async ({ handle, ref, data, local }) => {
      const { ref: r, codec, info } = this._refOf(handle, ref, local)
      const { data: row } = await put(r, received(codec.decodeRow(r.schema, data), info))
      return { data: codec.encodeRow(r.schema, row) }
    })

    this.rpc.onSet(async ({ handle, ref, data, fields, local, noUpsert }) => {
      const { ref: r, codec, info } = this._refOf(handle, ref, local)
      const row = received(codec.decodeRow(r.schema, data), info, fields)
      const result = await set(r, row, { upsert: !noUpsert })
      return { data: result ? codec.encodeRow(r.schema, result.data) : null }
    })

    this.rpc.onGet(async ({ handle, ref, query, local }) => {
      const { ref: r, codec } = this._refOf(handle, ref, local)
      const q = fromWire(query)
      return encodeGet(r, codec, q, await get(r, q))
    })

    this.rpc.onDel(async ({ handle, ref, id, local }) => {
      await del(this._refOf(handle, ref, local).ref, id)
      return {}
    })

    this.rpc.onWatch((stream) => {
      const { handle, ref, local } = stream.data
      const query = fromWire(stream.data.query)
      let r, codec, live
      try {
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
      stream.on('error', safetyCatch)
      stream.on('close', () => {
        live.off('data', onData)
        live.destroy()
        this._watchStreams.get(handle)?.delete(stream)
      })
    })

    this.rpc.onCall(async ({ handle, op, data }) => {
      const h = this._resolve(handle)
      const r = h[op]
      if (!r) throw CeroError.UNKNOWN('ref', op)
      await call(r, h.spec.codec.decodeAction(h, op, data))
      return { data: null }
    })
  }

  /**
   * Register invite/revoke/join RPC handlers.
   * @private
   */
  _wirePairing() {
    this.rpc.onInvite(async ({ handle, role, ttl, reuse, confirm, data }) => {
      const code = await invite(this._resolve(handle), {
        role: role || undefined,
        ttl: ttl || undefined,
        reuse: reuse === true,
        confirm: confirm === true,
        data: data || null
      })
      return { invite: code }
    })

    this.rpc.onRevoke(async ({ handle, invite: code }) => {
      return { ok: await revoke(this._resolve(handle), code) }
    })

    this.rpc.onRotate(({ handle }) => rotate(this._resolve(handle)))

    this.rpc.onAnswer(async ({ handle, id, accept, role, reason }) => {
      await this._resolve(handle)._answer(id, { accept, role: role || undefined, reason })
      return {}
    })

    this.rpc.onSuspend(async ({ handle }) => {
      await suspend(this._resolve(handle))
      return {}
    })

    this.rpc.onResume(async ({ handle }) => {
      await resume(this._resolve(handle))
      return {}
    })

    this.rpc.onSetActive(async ({ handle, active: on }) => {
      await (on ? activate : deactivate)(this._resolve(handle))
      return {}
    })

    this.rpc.onNearby(async ({ on, invite }) => {
      await nearby(this.me, invite || on)
      return {}
    })

    this.rpc.onCancel(async ({ invite: code }) => ({ ok: await cancel(this.me, code) }))

    this.rpc.onJoin(async ({ parent, ref, invite }) => {
      if (this._resolve(parent) !== this.me) throw CeroError.UNSUPPORTED('nested handles')
      let child
      try {
        child = await this.me._join(invite, ref)
      } catch (err) {
        if (err.code !== 'DENIED') throw err
        return { id: '', type: ref, denied: true, reason: err.reason || '' }
      }
      const id = child.id
      this.handles.set(id, child)
      return { id, type: ref, name: '' }
    })
  }

  /**
   * Register add/open/close/leave RPC handlers for child handles.
   * @private
   */
  _wireHandles() {
    this.rpc.onAddHandle(async ({ handle, ref, data }) => {
      const parent = this._resolve(handle)
      const info = parent.spec.meta.refs?.[ref] || parent.spec.handles?.[ref]
      if (!info) throw CeroError.UNKNOWN('handle type', ref)
      const wire = parent.spec.codec.decodeCreate(data) || {}
      const opts = { name: wire.name }
      const child = await this.me._create(ref, opts)
      const id = child.id
      this.handles.set(id, child)
      return { id, type: ref, name: opts.name || '' }
    })

    this.rpc.onOpenHandle(async ({ parent, row }) => {
      if (this._resolve(parent) !== this.me) throw CeroError.UNSUPPORTED('nested handles')
      const { data } = await this.me.store.get('handles', row)
      if (!data) throw CeroError.UNKNOWN('handle', row)
      const child = await this.me._load(data.type, row)
      this.handles.set(row, child)
      return { id: row, type: data.type, name: data.name || '' }
    })

    this.rpc.onCloseHandle(async ({ handle }) => {
      const h = this.handles.get(handle)
      if (!h || h === this.me) return {}
      this._endWatches(handle)
      this.handles.delete(handle)
      await h.close()
      return {}
    })

    this.rpc.onLeave(async ({ handle }) => {
      await leave(this._resolve(handle))
      this._endWatches(handle)
      this.handles.delete(handle)
      return {}
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
      const r = this.me.local?.[name]
      if (!r) throw CeroError.UNKNOWN('local ref', name)
      return { ref: r, codec: this.spec.local.codec, info }
    }
    const h = this._resolve(id)
    const r = h[name]
    if (!r) throw CeroError.UNKNOWN('ref', name)
    return { ref: r, codec: h.spec.codec, info: h.spec.meta?.refs?.[name] }
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

  /**
   * Wire the on-demand `seed` handler — surfaces the recovery phrase only when asked.
   * @private
   */
  _wireSeed() {
    this.rpc.onSeed(async () => {
      if (!this.me) throw CeroError.NOT_READY('Server', 'server')
      return { phrase: await phrase(this.me) }
    })
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
  return {
    data: one ? codec.encodeRow(r.schema, data) : codec.encodeRows(r.schema, data),
    total: total ?? -1,
    size: size ?? 0
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
