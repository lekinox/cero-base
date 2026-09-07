import safetyCatch from 'safety-catch'

import { RPCServer, bindCodec } from '@cero-base/core/rpc'
import { CeroError } from '@cero-base/core/errors'
import { encodeId } from '@cero-base/core/blobs/codec'

import { cero, restore } from '../index.js'
import { put, set, get, del, watch, changes, call } from '../lib/operators.js'

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
 *
 * @typedef {{ ref: any, codec: any }} RefAndCodec
 *
 * @typedef {{ data: any, total?: number, size?: number }} GetResult  Single-ref get omits `total`/`size`; list/handle refs include them.
 */

/**
 * IPC-side RPC server for cero. Bridges an `hrpc` channel to a live `Handle` tree:
 * lazy-initializes the root via `cero()` on the first `init` call, then exposes data ops,
 * pairing, and handle lifecycle.
 */
export class Server extends RPCServer {
  /**
   * @param {any} ipc                Framed IPC stream (must be writable).
   * @param {object} spec
   * @param {Partial<ServerOpts>} [opts]
   */
  constructor(ipc, spec, { storage, ...opts } = {}) {
    if (!spec) throw CeroError.REQUIRED('spec')
    if (!storage) throw CeroError.REQUIRED('storage')
    super(ipc, spec)
    if (spec.local?.schema && !spec.local.codec) bindCodec(spec.local)
    this.storage = storage
    this.opts = opts
    this.me = null
    this.handles = new Map()
    /** @type {Map<string, Set<object>>} handle id → its open watch streams */
    this._watchStreams = new Map()
    this._wireInit()
  }

  /**
   * Root cero id (null until `init` has run).
   *
   * @returns {string|undefined}
   */
  get id() {
    return this.me?.id
  }

  /**
   * Root identity object (null until `init` has run).
   *
   * @returns {any}
   */
  get identity() {
    return this.me?.identity
  }

  async _close() {
    if (this.me) {
      try {
        await this.me.close()
      } catch {}
    }
    await super._close()
  }

  /** End every watch stream bound to a handle (e.g. when it closes or leaves). */
  _endWatches(handle) {
    const set = this._watchStreams.get(handle)
    if (!set) return
    for (const s of set) s.destroy()
    this._watchStreams.delete(handle)
  }

  /** Wire the `init` handler that lazily constructs the root cero handle. */
  _wireInit() {
    this.rpc.onInit(async () => {
      if (this.me) throw CeroError.CONFLICT('already initialized')
      this.me = await cero(this.storage, this.spec, this.opts)
      this.handles.set(this.me.id, this.me)
      await this.me.fileServer.listen()
      this._wireData()
      this._wirePairing()
      this._wireHandles()
      this._wireRestore()
      this._wireSeed()
      return this._identity()
    })
  }

  /** Wire the `restore` handler that rebuilds the local store from a phrase. */
  _wireRestore() {
    this.rpc.onRestore(async ({ phrase }) => {
      if (!this.me) throw CeroError.NOT_READY('Server', 'server')
      this.me = await restore(this.me, phrase)
      this.handles = new Map([[this.me.id, this.me]])
      return this._identity()
    })
  }

  /** Register the row-level RPC handlers (put/set/get/del/watch/call). */
  _wireData() {
    this.rpc.onAddFile(async ({ handle, data, name, type }) => {
      const h = this._resolve(handle)
      const blobs = h.blobs // captured once — the instance carries its epoch stamp
      await blobs.ready()
      const blobId = await blobs.put(data)
      const id = encodeId(blobs.key, blobId, type || '')
      const codec = h.spec.codec
      await h.store.call('add-file', { id, name: name || null, stamp: blobs.stamp || 0 })
      const { data: row } = await get(h.files, id)
      return { data: codec.encodeRow(h.files.schema, row) }
    })

    this.rpc.onAddRow(async ({ handle, ref, data, local }) => {
      const { ref: r, codec } = this._refOf(handle, ref, local)
      const { data: row } = await put(r, codec.decodeRow(r.schema, data))
      return { data: codec.encodeRow(r.schema, row) }
    })

    this.rpc.onSet(async ({ handle, ref, data, local, noUpsert }) => {
      const { ref: r, codec } = this._refOf(handle, ref, local)
      const result = await set(r, codec.decodeRow(r.schema, data), { upsert: !noUpsert })
      // an update-only miss returns null — encode an empty row back
      return { data: codec.encodeRow(r.schema, result?.data ?? null) }
    })

    this.rpc.onGet(async ({ handle, ref, query, local }) => {
      const { ref: r, codec } = this._refOf(handle, ref, local)
      const result = /** @type {GetResult} */ (await get(r, codec.decodeQuery(query)))
      const data =
        r.kind === 'single'
          ? codec.encodeRow(r.schema, result.data)
          : codec.encodeRows(r.schema, result.data)
      // total is int on the wire: -1 encodes null
      return { data, total: result.total ?? -1, size: result.size ?? 0 }
    })

    this.rpc.onGetOne(async ({ handle, ref, id, local }) => {
      const { ref: r, codec } = this._refOf(handle, ref, local)
      const { data } = await get(r, id)
      return { data: data ? codec.encodeRow(r.schema, data) : null }
    })

    this.rpc.onDel(async ({ handle, ref, id, local }) => {
      await del(this._refOf(handle, ref, local).ref, id)
      return {}
    })

    this.rpc.onWatch((stream) => {
      const { handle, ref, query, local } = stream.data
      let r, codec, live
      try {
        ;({ ref: r, codec } = this._refOf(handle, ref, local))
        live = watch(r, codec.decodeQuery(query))
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
        const data =
          r.kind === 'single'
            ? codec.encodeRow(r.schema, snap.data)
            : codec.encodeRows(r.schema, snap.data)
        blocked = stream.write({ data, total: snap.total ?? -1, size: snap.size ?? 0 }) === false
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
      // channel teardown destroys the stream with CHANNEL_CLOSED; 'close' cleans up
      stream.on('error', safetyCatch)
      stream.on('close', () => {
        live.off('data', onData)
        live.destroy()
        this._watchStreams.get(handle)?.delete(stream)
      })
    })

    this.rpc.onChanges((stream) => {
      const { handle, ref, query, local } = stream.data
      let r, codec, live
      try {
        ;({ ref: r, codec } = this._refOf(handle, ref, local))
        live = changes(r, codec.decodeQuery(query))
      } catch (err) {
        stream.once('error', () => {})
        stream.writeStream.destroy(err)
        stream.destroy()
        return
      }
      let set = this._watchStreams.get(handle)
      if (!set) this._watchStreams.set(handle, (set = new Set()))
      set.add(stream)
      // deltas are not idempotent: hold the iteration on backpressure instead
      const pump = async () => {
        for await (const batch of live) {
          const ok = stream.write({
            changes: codec.encodeChanges(r.schema, batch.changes),
            reset: batch.reset === true
          })
          if (ok === false) await new Promise((resolve) => stream.once('drain', resolve))
        }
      }
      pump().catch(safetyCatch)
      stream.on('error', safetyCatch)
      stream.on('close', () => {
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

  /** Register invite/revoke/join RPC handlers. */
  _wirePairing() {
    this.rpc.onInvite(async ({ handle, role, expiresIn, reuse }) => {
      const h = this._resolve(handle)
      const invite = await h.invite({
        role: role || undefined,
        expiresIn: expiresIn || undefined,
        reuse: reuse === true
      })
      return { invite }
    })

    this.rpc.onRevoke(async ({ handle, invite }) => {
      const ok = await this._resolve(handle).revoke(invite)
      return { ok }
    })

    this.rpc.onRotate(async ({ handle }) => {
      const { epoch } = await this._resolve(handle).store.rotate()
      return { epoch }
    })

    this.rpc.onSetActive(({ handle, active }) => {
      this._resolve(handle).setActive(active)
      return {}
    })

    this.rpc.onSuspend(async () => {
      await this.me.suspend()
      return {}
    })

    this.rpc.onResume(async () => {
      await this.me.resume()
      return {}
    })

    this.rpc.onJoin(async ({ parent, ref, invite }) => {
      if (this._resolve(parent) !== this.me) throw CeroError.UNSUPPORTED('nested handles')
      const child = await this.me._join(invite, ref)
      const id = child.id
      this.handles.set(id, child)
      return { id, type: ref, name: '' }
    })
  }

  /** Register add/open/close/leave RPC handlers for child handles. */
  _wireHandles() {
    this.rpc.onAddHandle(async ({ handle, ref, data }) => {
      const parent = this._resolve(handle)
      const info = parent.spec.meta.refs?.[ref] || parent.spec.handles?.[ref]
      if (!info) throw CeroError.UNKNOWN('handle type', ref)
      const wire = parent.spec.codec.decodeCreate(data) || {}
      // routes are functions and cannot cross the wire
      const opts = { name: wire.name, role: wire.role, accept: wire.noAccept ? false : undefined }
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
      const h = this.handles.get(handle)
      if (!h || h === this.me) return {}
      this._endWatches(handle)
      await this.me.store.call('del-handle', { id: handle })
      this.handles.delete(handle)
      await h.close()
      return {}
    })
  }

  /**
   * Look up a live handle by id, throwing if unknown. Binds the handle's
   * codec on first use.
   *
   * @param {string} id
   * @returns {any}
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
   */
  _refOf(id, name, local) {
    if (local) {
      const info = this.spec.meta.local?.refs?.[name]
      if (!info || info.internal) throw CeroError.UNKNOWN('local ref', name)
      const r = this.me.local?.[name]
      if (!r) throw CeroError.UNKNOWN('local ref', name)
      return { ref: r, codec: this.spec.local.codec }
    }
    const h = this._resolve(id)
    const r = h[name]
    if (!r) throw CeroError.UNKNOWN('ref', name)
    return { ref: r, codec: h.spec.codec }
  }

  /**
   * Snapshot the current identity for return to the client.
   *
   * @returns {Identity}
   */
  _identity() {
    const fs = this.me.fileServer
    return {
      id: this.me.id,
      deviceId: this.me.device?.id || '',
      fileBase: `http://127.0.0.1:${fs.port}`,
      fileToken: fs.server.token || ''
    }
  }

  /** Wire the on-demand `seed` handler — surfaces the recovery phrase only when asked. */
  _wireSeed() {
    this.rpc.onSeed(async () => {
      if (!this.me) throw CeroError.NOT_READY('Server', 'server')
      return { phrase: this.me.identity.toPhrase() }
    })
  }
}

/**
 * Construct a `Server`, wait for it to be ready, and return it.
 *
 * @param {any} ipc
 * @param {object} spec
 * @param {ServerOpts} opts
 * @returns {Promise<Server>}
 */
export async function serve(ipc, spec, opts) {
  const server = new Server(ipc, spec, opts)
  await server.ready()
  return server
}
