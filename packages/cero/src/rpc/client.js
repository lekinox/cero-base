import { Readable } from 'streamx'
import { RPCClient, bindCodec } from '@cero-base/core/rpc'
import c from 'compact-encoding'
import z32 from 'z32'
import { decodeId } from '@cero-base/core/blobs/codec'

import { Ref } from '../lib/refs.js'
import {
  put,
  set,
  get,
  del,
  count,
  watch,
  changes,
  call,
  open,
  rotate,
  bind,
  define
} from '../lib/operators.js'
import { t, schema } from '../lib/spec.js'

export { put, set, get, del, count, watch, changes, call, open, rotate, bind, define, t, schema }

/**
 * @typedef {import('@cero-base/core/rpc').RPCClient} BaseRPCClient
 *
 * @typedef {object} RefInfo
 * @property {'single'|'collection'|'action'|'handle'} [kind]
 * @property {string} [schema]
 * @property {string} [type]
 * @property {boolean} [internal]
 *
 * @typedef {import('@cero-base/core/rpc').Spec & { meta: { ns?: string, refs: Record<string, RefInfo>, local?: { refs: Record<string, RefInfo> }, handles?: Record<string, Spec> }, handles: Record<string, Spec> }} Spec  Built cero spec (schema + rpc + per-handle child specs).
 *
 * @typedef {{ data: any }} SingleResult
 * @typedef {{ data: any[], total: number, size: number }} ListResult
 * @typedef {{ data: any | null }} GetByIdResult
 *
 * @typedef {object} ClientIdentity
 * @property {string} id
 * @property {() => string|null} toPhrase
 *
 * @typedef {object} HandleStub
 * @property {string} id
 * @property {string} type
 * @property {string|null} name
 */

const blobIdEnc = {
  preencode(state, b) {
    c.uint.preencode(state, b.blockOffset)
    c.uint.preencode(state, b.blockLength)
    c.uint.preencode(state, b.byteOffset)
    c.uint.preencode(state, b.byteLength)
  },
  encode(state, b) {
    c.uint.encode(state, b.blockOffset)
    c.uint.encode(state, b.blockLength)
    c.uint.encode(state, b.byteOffset)
    c.uint.encode(state, b.byteLength)
  },
  decode(state) {
    return {
      blockOffset: c.uint.decode(state),
      blockLength: c.uint.decode(state),
      byteOffset: c.uint.decode(state),
      byteLength: c.uint.decode(state)
    }
  }
}

// the same row-ops surface as a local handle, routed over the wire
const operators = {
  _local: false,

  /** @param {string} name @returns {RefInfo|undefined} */
  _refInfo(name) {
    const refs = this._local ? this.spec.meta.local?.refs : this.spec.meta.refs
    return refs?.[name]
  },

  /** @returns {any} */
  _codec() {
    return this._local ? this.spec.local.codec : this.spec.codec
  },

  /** @param {string} name @returns {string|undefined} */
  schemaOf(name) {
    return this._refInfo(name)?.schema
  },

  /**
   * Build a renderable URL for a file id using the base + token learned at init.
   *
   * @param {string} id
   * @returns {string}
   */
  url(id) {
    const root = this.parent || this
    const base = root._fileBase || ''
    const token = root._fileToken || ''
    const { coreKey, blobId, type } = decodeId(id)
    const key = z32.encode(coreKey)
    const blob = z32.encode(c.encode(blobIdEnc, blobId))
    const tp = type ? `&type=${encodeURIComponent(type)}` : ''
    const tok = token ? `&token=${token}` : ''
    return `${base}/?key=${key}&blob=${blob}${tp}${tok}`
  },

  /**
   * Augment a decoded row (or array of rows) to resolve file-typed fields to `{ id, type,
   * size, url }` objects.
   *
   * @param {string} name
   * @param {any} data
   * @returns {any}
   */
  _resolveFiles(name, data) {
    if (data == null) return data
    const info = this._refInfo(name)
    if (Array.isArray(data)) return data.map((row) => this._resolveRow(name, info, row))
    return this._resolveRow(name, info, data)
  },

  _resolveRow(name, info, row) {
    if (!row || typeof row !== 'object') return row
    if (info?.internal && info?.verb === 'file') {
      if (!row.id) return row
      try {
        const { type, blobId } = decodeId(row.id)
        return { ...row, type, size: blobId.byteLength, url: this.url(row.id) }
      } catch {
        return row
      }
    }
    const fileFields = info?.files
    if (!fileFields || !fileFields.length) return row
    const out = { ...row }
    for (const f of fileFields) {
      const v = out[f]
      if (v == null) continue
      try {
        const { type, blobId } = decodeId(v)
        out[f] = { id: v, type, size: blobId.byteLength, url: this.url(v) }
      } catch {
        // leave as-is if not a valid file id
      }
    }
    return out
  },

  /**
   * Insert a row over the wire.
   *
   * @param {string} name
   * @param {Record<string, any>} row
   * @returns {Promise<SingleResult>}
   */
  async put(name, row) {
    const codec = this._codec()
    const schema = this.schemaOf(name)
    if (name === 'files') {
      const res = await this.rpc.addFile({
        handle: this.id,
        data: row.data,
        name: row.name || '',
        type: row.type || ''
      })
      const decoded = codec.decodeRow(schema, res.data)
      return { data: this._resolveRow(name, this._refInfo(name), decoded) }
    }
    const input = row?.id ? row : { id: '', ...row }
    const res = await this.rpc.addRow({
      handle: this.id,
      ref: name,
      data: codec.encodeRow(schema, input),
      local: this._local
    })
    return { data: codec.decodeRow(schema, res.data) }
  },

  /**
   * Upsert a row over the wire. Pass `{ upsert: false }` to update-only.
   *
   * @param {string} name
   * @param {Record<string, any>} row
   * @param {{ upsert?: boolean }} [opts]
   * @returns {Promise<SingleResult>}
   */
  async set(name, row, opts) {
    const codec = this._codec()
    const schema = this.schemaOf(name)
    const res = await this.rpc.set({
      handle: this.id,
      ref: name,
      data: codec.encodeRow(schema, row),
      local: this._local,
      noUpsert: opts?.upsert === false || undefined
    })
    return { data: codec.decodeRow(schema, res.data) }
  },

  /**
   * Read a row (by id string) or a list (by query object). Mirrors the
   * `Storage.get` contract.
   *
   * @param {string} name
   * @param {string | Record<string, any>} [query]
   * @returns {Promise<SingleResult | ListResult | GetByIdResult>}
   */
  async get(name, query) {
    const codec = this._codec()
    const schema = this.schemaOf(name)
    if (typeof query === 'string') {
      const res = await this.rpc.getOne({
        handle: this.id,
        ref: name,
        id: query,
        local: this._local
      })
      const decoded = res.data ? codec.decodeRow(schema, res.data) : null
      return { data: this._resolveFiles(name, decoded) }
    }
    const res = await this.rpc.get({
      handle: this.id,
      ref: name,
      query: codec.encodeQuery(query),
      local: this._local
    })
    const info = this._refInfo(name)
    const raw =
      info?.kind === 'single'
        ? codec.decodeRow(schema, res.data)
        : codec.decodeRows(schema, res.data)
    return {
      data: this._resolveFiles(name, raw),
      total: res.total === -1 ? null : res.total,
      size: res.size
    }
  },

  /**
   * Delete a row by id.
   *
   * @param {string} name
   * @param {string} [id]
   * @returns {Promise<void>}
   */
  async del(name, id) {
    await this.rpc.del({ handle: this.id, ref: name, id, local: this._local })
  },

  /**
   * Count matching rows.
   *
   * @param {string} name
   * @param {Record<string, any>} [query]
   * @returns {Promise<{ data: number }>}
   */
  async count(name, query) {
    const codec = this._codec()
    const res = await this.rpc.count({
      handle: this.id,
      ref: name,
      query: codec.encodeQuery(query),
      local: this._local
    })
    return { data: res.count }
  },

  /**
   * Live snapshot stream. Re-emits the latest `get()` shape on every
   * underlying mutation. Destroy the stream to stop watching.
   *
   * @param {string} name
   * @param {Record<string, any>} [query]
   * @returns {import('streamx').Readable}
   */
  watch(name, query) {
    const refInfo = this._refInfo(name)
    const codec = this._codec()
    const schema = refInfo?.schema
    const wire = this.rpc.watch({
      handle: this.id,
      ref: name,
      query: codec.encodeQuery(query),
      local: this._local
    })
    const out = new Readable({
      predestroy() {
        wire.destroy()
      }
    })
    wire.on('data', (snap) => {
      const raw =
        refInfo.kind === 'single'
          ? (codec.decodeRow(schema, snap.data) ?? null)
          : codec.decodeRows(schema, snap.data)
      out.push({
        data: this._resolveFiles(name, raw),
        total: snap.total === -1 ? null : snap.total,
        size: snap.size
      })
    })
    // end exactly once whether the wire ends or the server destroys it (handle close)
    let ended = false
    const end = () => {
      if (ended || out.destroyed) return
      ended = true
      out.push(null)
    }
    wire.on('end', end)
    wire.on('close', end)
    // the channel tears the stream down on client close — that is an end,
    // not a failure
    wire.on('error', (err) => (err.code === 'CHANNEL_CLOSED' ? end() : out.destroy(err)))
    return out
  },

  /**
   * Delta subscription over the wire — same contract as the local operator: batches of `{
   * prev, next }` with file fields resolved, `reset` marks a full replay.
   */
  changes(name, query) {
    const refInfo = this._refInfo(name)
    const codec = this._codec()
    const schema = refInfo?.schema
    const wire = this.rpc.changes({
      handle: this.id,
      ref: name,
      query: codec.encodeQuery(query),
      local: this._local
    })
    const out = new Readable({
      predestroy() {
        wire.destroy()
      }
    })
    const pump = async () => {
      for await (const frame of wire) {
        const changes = []
        for (const { prev, next } of codec.decodeChanges(schema, frame.changes)) {
          changes.push({
            prev: prev && this._resolveFiles(name, prev),
            next: next && this._resolveFiles(name, next)
          })
        }
        out.push({ changes, reset: frame.reset === true })
      }
      if (!out.destroyed) out.push(null)
    }
    pump().catch((err) => {
      if (out.destroyed) return
      // both are ends, not failures
      if (err.code === 'PREMATURE_CLOSE' || err.code === 'CHANNEL_CLOSED') out.push(null)
      else out.destroy(err)
    })
    return out
  },

  /**
   * Invoke a named action ref over the wire.
   *
   * @param {string} op
   * @param {any} [data]
   * @returns {Promise<void>}
   */
  async call(op, data) {
    const schema = this.schemaOf(op)
    const codec = this._codec()
    const encoded = data ? codec.encodeAction({ [op]: { schema } }, op, data) : null
    await this.rpc.call({ handle: this.id, op, data: encoded })
  },

  /**
   * Mint a pairing invite for this handle.
   *
   * @param {{ role?: string }} [opts]
   * @returns {Promise<string>}
   */
  async invite({ role, expiresIn, reuse } = {}) {
    const { invite } = await this.rpc.invite({
      handle: this.id,
      role: role || '',
      expiresIn: expiresIn || 0,
      reuse: reuse === true
    })
    return invite
  },

  /**
   * Revoke a previously issued invite.
   *
   * @param {string} invite
   * @returns {Promise<boolean>}
   */
  async revoke(invite) {
    const { ok } = await this.rpc.revoke({ handle: this.id, invite })
    return ok
  },

  /**
   * Rotate this handle's encryption epoch on the server.
   *
   * @returns {Promise<{ epoch: number }>}
   */
  async rotate() {
    const { epoch } = await this.rpc.rotate({ handle: this.id })
    return { epoch }
  }
}

/**
 * Re-initialize a `Client` from a recovery phrase. Closes the existing
 * local state and reseeds identity from the phrase.
 *
 * @param {Client} me
 * @param {string} phrase
 * @returns {Promise<Client>}
 */
export async function restore(me, phrase) {
  const res = await me.rpc.restore({ phrase })
  me.id = res.id
  me.deviceId = res.deviceId || null
  me.identity = { id: res.id, toPhrase: async () => (await me.rpc.seed({})).phrase || null }
  return me
}

/**
 * Per-device `local`-namespace surface on a Client.
 */
class LocalRefs {
  /** @param {Client} client */
  constructor(client) {
    Object.assign(this, operators)
    this.parent = client
    this.spec = client.spec
    this.store = this
    this._local = true
    const refs = client.spec.meta.local?.refs || {}
    const exposed = Object.fromEntries(Object.entries(refs).filter(([, info]) => !info.internal))
    Ref.attach(this, exposed)
  }

  /** Underlying RPC channel borrowed from the parent. */
  get rpc() {
    return this.parent.rpc
  }

  /** Root handle id (local ops are resolved against the root's local store). */
  get id() {
    return this.parent.id
  }
}

/**
 * IPC-side RPC client for cero. Wraps an `hrpc` channel and exposes the same
 * handle/ref/row API as a local cero instance, transparently routing every operation
 * across the wire.
 */
export class Client extends RPCClient {
  /**
   * @param {any} ipc   Framed IPC stream (must be writable).
   * @param {Spec} spec  Compiled cero spec (schema + rpc + handles).
   */
  constructor(ipc, spec) {
    super(ipc, spec)
    if (spec.local?.schema && !spec.local.codec) bindCodec(spec.local)
    Object.assign(this, operators)
    this.id = null
    this.deviceId = null
    this.store = this
    this.local = null
  }

  async _open() {
    await super._open()
    const { id, deviceId, fileBase, fileToken } = await this.rpc.init({})
    this.id = id
    this.deviceId = deviceId || null
    this._fileBase = fileBase || ''
    this._fileToken = fileToken || ''
    this.identity = { id, toPhrase: async () => (await this.rpc.seed({})).phrase || null }
    Ref.attach(this, /** @type {Spec} */ (this.spec).meta.refs)
    bind(this, null)
    if (/** @type {Spec} */ (this.spec).meta.local?.refs) this.local = new LocalRefs(this)
  }

  /**
   * Create a new child handle of the given type.
   *
   * @param {string} type
   * @param {Record<string, any>} [opts]
   * @returns {Promise<Handle>}
   */
  async _create(type, opts = {}) {
    // routes are functions and cannot cross the wire
    const wire = { ...opts, noAccept: opts.accept === false || undefined }
    const stub = await this.rpc.addHandle({
      ref: type,
      handle: this.id,
      data: this.spec.codec.encodeCreate(wire)
    })
    return new Handle(this, stub.id, stub.type, stub.name || null)
  }

  /**
   * Load an existing child handle by id.
   *
   * @param {string} type
   * @param {string} id
   * @returns {Promise<Handle>}
   */
  async _load(type, id) {
    const stub = await this.rpc.openHandle({ parent: this.id, row: id })
    return new Handle(this, stub.id, stub.type, stub.name || null)
  }

  /**
   * Join a child handle via invite.
   *
   * @param {string} invite
   * @param {string} type
   * @returns {Promise<Handle>}
   */
  async _join(invite, type) {
    const stub = await this.rpc.join({ parent: this.id, ref: type, invite })
    return new Handle(this, stub.id, stub.type, stub.name || null)
  }
}

/**
 * Client-side proxy for a remote handle. Exposes the same row-ops surface as `Client` but
 * scoped to a single child handle id, and routes every call through the parent's RPC
 * channel.
 */
class Handle {
  /**
   * @param {Client} parent
   * @param {string} id
   * @param {string} type
   * @param {string|null} name
   */
  constructor(parent, id, type, name) {
    Object.assign(this, operators)
    this.parent = parent
    this.id = id
    this.type = type
    this.name = name
    this.spec = /** @type {Spec} */ (parent.spec).handles[type]
    if (!this.spec.codec) bindCodec(this.spec)
    this.store = this
    Ref.attach(this, this.spec.meta.refs)
    bind(this, this.type)
  }

  /** Underlying RPC channel borrowed from the parent. */
  get rpc() {
    return this.parent.rpc
  }

  /** Tear down the remote handle without leaving the room. */
  close() {
    return this.parent.rpc.closeHandle({ handle: this.id })
  }

  /** Tear down the remote handle and drop membership. */
  leave() {
    return this.parent.rpc.leave({ handle: this.id })
  }
}

/**
 * Construct a `Client`, wait for `init` to complete, and return it.
 *
 * @param {any} ipc
 * @param {object} spec
 * @returns {Promise<Client>}
 */
export async function connect(ipc, spec) {
  const client = new Client(ipc, spec)
  await client.ready()
  return client
}

/**
 * Symmetric client entry. Mirrors the main `cero`, but `cero(ipc, spec)` connects to a
 * server (via `connect`) instead of opening a local store.
 *
 * @param {any} ipc    Framed IPC duplex stream.
 * @param {any} spec   Built cero spec.
 * @returns {Promise<Client>}
 */
export function cero(ipc, spec) {
  return connect(ipc, spec)
}
cero.connect = connect
cero.restore = restore
cero.t = t
cero.put = put
cero.set = set
cero.get = get
cero.del = del
cero.count = count
cero.watch = watch
cero.changes = changes
cero.call = call
cero.open = open
cero.rotate = rotate
cero.bind = bind
cero.define = define
cero.schema = schema
