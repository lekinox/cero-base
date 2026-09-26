import { Readable } from 'streamx'
import b4a from 'b4a'
import { RPCClient, bindCodec } from '@cero-base/core/rpc'
import { CeroError } from '@cero-base/core/errors'
import { checkFields, checkRequired } from '@cero-base/core/utils'
import c from 'compact-encoding'
import z32 from 'z32'
import { decodeId } from '@cero-base/core/blobs/codec'

import { Ref } from '../lib/refs.js'
import * as verbs from '../lib/operators.js'
import { t, schema } from '../lib/spec.js'

// hooks and batches take functions: they run where the data lives, never in the UI
const { before, after, tx, ...remote } = verbs

export const {
  put,
  set,
  get,
  del,
  watch,
  call,
  open,
  invite,
  revoke,
  rotate,
  accept,
  deny,
  leave,
  close,
  cancel,
  suspend,
  resume,
  activate,
  deactivate,
  phrase,
  nearby
} = remote
export { t, schema }

/**
 * @typedef {import('@cero-base/core/rpc').RPCClient} BaseRPCClient
 *
 * @typedef {import('../lib/spec.js').RefInfo} RefInfo
 * @typedef {import('../lib/spec.js').Spec} Spec
 * @typedef {import('../lib/spec.js').Row} Row
 * @typedef {import('../lib/operators.js').SingleResult} SingleResult
 * @typedef {import('../lib/operators.js').ListResult} ListResult
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

  /**
   * @param {string} name @returns {RefInfo|undefined}
   * @private
   */
  _refInfo(name) {
    const refs = this._local ? this.spec.meta.local?.refs : this.spec.meta.refs
    return refs?.[name]
  },

  /**
   * @returns {import('@cero-base/core/rpc').Codec}
   * @private
   */
  _codec() {
    return this._local ? this.spec.local.codec : this.spec.codec
  },

  /** @param {string} name @returns {string|undefined} */
  schemaOf(name) {
    return this._refInfo(name)?.schema
  },

  // the worker's file server, reached with the base and token learned at init
  /** @private */
  _link(id) {
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
   * @param {Row | Row[] | null} data
   * @returns {Row | Row[] | null}
   * @private
   */
  _resolveFiles(name, data) {
    if (data == null) return data
    const info = this._refInfo(name)
    if (Array.isArray(data)) return data.map((row) => this._resolveRow(name, info, row))
    return this._resolveRow(name, info, data)
  },

  /** @private */
  _resolveRow(name, info, row) {
    if (!row || typeof row !== 'object') return row
    if (info?.internal && info?.verb === 'file') {
      if (!row.id) return row
      try {
        const { type, blobId } = decodeId(row.id)
        return { ...row, type, size: blobId.byteLength, url: this._link(row.id) }
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
        out[f] = { id: v, type, size: blobId.byteLength, url: this._link(v) }
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
   * @param {Row} row
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
    const res = await this.rpc.addRow({
      handle: this.id,
      ref: name,
      data: this._encode(name, row, true).data,
      local: this._local
    })
    return { data: codec.decodeRow(schema, res.data) }
  },

  /**
   * Upsert a row over the wire. Pass `{ upsert: false }` to update-only.
   *
   * @param {string} name
   * @param {Row} row
   * @param {{ upsert?: boolean }} [opts]
   * @returns {Promise<SingleResult | null>}
   */
  async set(name, row, opts) {
    const codec = this._codec()
    const schema = this.schemaOf(name)
    const { data, fields } = this._encode(name, row, false)
    const res = await this.rpc.set({
      handle: this.id,
      ref: name,
      data,
      fields,
      local: this._local,
      noUpsert: opts?.upsert === false || undefined
    })
    return res.data ? { data: codec.decodeRow(schema, res.data) } : null
  },

  /**
   * Read a row (by id string) or a list (by query object). Mirrors the
   * `Storage.get` contract.
   *
   * @param {string} name
   * @param {string | Record<string, unknown>} [query]
   * @returns {Promise<SingleResult | ListResult>}
   */
  async get(name, query) {
    const one = typeof query === 'string' || this._refInfo(name)?.kind === 'single'
    const res = await this.rpc.get({
      handle: this.id,
      ref: name,
      query: toWire(query),
      local: this._local
    })
    return this._read(name, one, res)
  },

  /**
   * The typed row and the indexes of the declared fields it carries, checked as the worker
   * would: the encoder drops an undeclared field and fails on a missing required one.
   *
   * @param {string} name
   * @param {Row} row
   * @param {boolean} whole  A put's row; a set's may leave fields out.
   * @returns {{ data: Uint8Array, fields: number[] }}
   * @private
   */
  _encode(name, row, whole) {
    const info = this._refInfo(name)
    checkFields(name, info, row)
    if (whole) checkRequired(name, info, row)
    const declared = info?.fields || []
    const fields = Object.keys(row)
      .map((k) => declared.indexOf(k))
      .filter((i) => i !== -1)
    return { data: this._codec().encodeRow(this.schemaOf(name), filled(row, info)), fields }
  },

  /**
   * Decode a result: one row or null when `one`, the list with its counts otherwise.
   *
   * @param {string} name
   * @param {boolean} one
   * @param {{ data: Uint8Array | null, total?: number, size?: number }} res
   * @returns {SingleResult | ListResult}
   * @private
   */
  _read(name, one, res) {
    const codec = this._codec()
    const schema = this.schemaOf(name)
    if (one) return { data: this._resolveFiles(name, codec.decodeRow(schema, res.data) ?? null) }
    return {
      data: this._resolveFiles(name, codec.decodeRows(schema, res.data)),
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
   * Live snapshot stream. Re-emits the latest `get()` shape on every
   * underlying mutation. Destroy the stream to stop watching.
   *
   * @param {string} name
   * @param {string | Record<string, unknown>} [query]
   * @returns {import('streamx').Readable}
   */
  watch(name, query) {
    const one = typeof query === 'string' || this._refInfo(name)?.kind === 'single'
    const wire = this.rpc.watch({
      handle: this.id,
      ref: name,
      query: toWire(query),
      local: this._local
    })
    const out = new Readable({
      predestroy() {
        wire.destroy()
      }
    })
    wire.on('data', (snap) => out.push(this._read(name, one, snap)))
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
   * Invoke a named action ref over the wire.
   *
   * @param {string} op
   * @param {Row} [data]
   * @returns {Promise<void>}
   */
  async call(op, data) {
    const schema = this.schemaOf(op)
    const codec = this._codec()
    const encoded = data ? codec.encodeAction({ [op]: { schema } }, op, data) : null
    await this.rpc.call({ handle: this.id, op, data: encoded })
  },

  // the verbs in lib/operators.js land here, and cross to the worker

  /** @private */
  async _invite({ role, ttl, reuse, confirm, data } = {}) {
    const { invite } = await this.rpc.invite({
      handle: this.id,
      role: role || '',
      ttl: ttl ? String(ttl) : '',
      reuse: reuse === true,
      confirm: confirm === true,
      data: data || null
    })
    return invite
  },

  /** @private */
  async _revoke(invite) {
    const { ok } = await this.rpc.revoke({ handle: this.id, invite })
    return ok
  },

  /** @private */
  async _rotate() {
    const { epoch } = await this.rpc.rotate({ handle: this.id })
    return { epoch }
  },

  /** @private */
  async _answer(id, { accept, role, reason }) {
    await this.rpc.answer({ handle: this.id, id, accept, role: role || '', reason: reason || '' })
  },

  /** @private */
  async _leave() {
    await this.rpc.leave({ handle: this.id })
  },

  /** @private */
  async _cancel(invite) {
    return (await this.rpc.cancel({ invite })).ok
  },

  /** @private */
  async _suspend() {
    await this.rpc.suspend({ handle: this.id })
  },

  /** @private */
  async _resume() {
    await this.rpc.resume({ handle: this.id })
  },

  /** @private */
  async _active(on) {
    await this.rpc.setActive({ handle: this.id, active: on })
  },

  /** @private */
  async _phrase() {
    return (await this.rpc.seed({})).phrase || null
  },

  /** @private */
  async _nearby(mode) {
    const invite = typeof mode === 'string' ? mode : ''
    await this.rpc.nearby({ on: mode !== false, invite })
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
  me.device = device(res)
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
    /** @private */
    this._local = true
    const refs = client.spec.meta.local?.refs || {}
    const exposed = Object.fromEntries(Object.entries(refs).filter(([, info]) => !info.internal))
    Ref.attach(this, exposed)
  }

  /** Underlying RPC channel borrowed from the parent. */
  get rpc() {
    return this.parent.rpc
  }

  /**
   * The root's id: local ops resolve against the root's local store.
   *
   * @returns {string | null}
   */
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
   * @param {import('streamx').Duplex} ipc  Framed IPC stream (must be writable).
   * @param {Spec} spec  Compiled cero spec (schema + rpc + handles).
   * @param {{ onerror?: (err: Error) => void }} [opts]  Where the worker's background errors go; the console without one.
   */
  constructor(ipc, spec, { onerror } = {}) {
    super(ipc, spec)
    if (spec.local?.schema && !spec.local.codec) bindCodec(spec.local)
    Object.assign(this, operators)
    /** @private */
    this._onerror = onerror || ((err) => console.error(err))
    /** @type {string | null} */
    this.id = null
    /** @type {{ id: string, name: string | null } | null} */
    this.device = null
    this.store = this
    this.local = null
  }

  // the worker's background errors, delivered the way a local root delivers them
  /** @private */
  _pumpErrors() {
    const report = this._onerror
    const pump = async () => {
      for await (const { message, code, stack, reason } of this.rpc.errors({})) {
        report(
          Object.assign(
            new Error(message),
            code && { code },
            stack && { stack },
            reason && { reason }
          )
        )
      }
    }
    pump().catch((err) => {
      if (err.code !== 'PREMATURE_CLOSE' && err.code !== 'CHANNEL_CLOSED') report(err)
    })
  }

  /** @private */
  async _open() {
    await super._open()
    const res = await this.rpc.init({})
    const { id, fileBase, fileToken } = res
    this.id = id
    this.device = device(res)
    /** @private */
    this._fileBase = fileBase || ''
    /** @private */
    this._fileToken = fileToken || ''
    Ref.attach(this, /** @type {Spec} */ (this.spec).meta.refs)
    if (/** @type {Spec} */ (this.spec).meta.local?.refs) this.local = new LocalRefs(this)
    this._pumpErrors()
  }

  /**
   * Create a new child handle of the given type.
   *
   * @param {string} type
   * @param {{ name?: string | null }} [opts]
   * @returns {Promise<Handle>}
   * @private
   */
  async _create(type, opts = {}) {
    const stub = await this.rpc.addHandle({
      ref: type,
      handle: this.id,
      data: this.spec.codec.encodeCreate({ name: opts.name })
    })
    return new Handle(this, stub.id, stub.type, stub.name || null)
  }

  /**
   * Load an existing child handle by id.
   *
   * @param {string} type
   * @param {string} id
   * @returns {Promise<Handle>}
   * @private
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
   * @private
   */
  async _join(invite, type) {
    const stub = await this.rpc.join({ parent: this.id, ref: type, invite })
    if (stub.denied) throw CeroError.DENIED(stub.reason || null)
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
  }

  /** Underlying RPC channel borrowed from the parent. */
  get rpc() {
    return this.parent.rpc
  }

  close() {
    return this.parent.rpc.closeHandle({ handle: this.id })
  }
}

/**
 * Construct a `Client`, wait for `init` to complete, and return it.
 *
 * @param {import('streamx').Duplex} ipc
 * @param {Spec} spec
 * @param {{ onerror?: (err: Error) => void }} [opts]
 * @returns {Promise<Client>}
 */
export async function connect(ipc, spec, opts) {
  const client = new Client(ipc, spec, opts)
  await client.ready()
  return client
}

/**
 * Symmetric client entry. Mirrors the main `cero`, but `cero(ipc, spec)` connects to a
 * server (via `connect`) instead of opening a local store.
 *
 * @param {import('streamx').Duplex} ipc  Framed IPC duplex stream.
 * @param {Spec} spec  Built cero spec.
 * @param {{ onerror?: (err: Error) => void }} [opts]
 * @returns {Promise<Client>}
 */
export function cero(ipc, spec, opts) {
  return connect(ipc, spec, opts)
}
Object.assign(cero, remote, { connect, restore, t, schema })

// the same shape a local root has
function device({ deviceId, deviceName }) {
  return deviceId ? { id: deviceId, name: deviceName || null } : null
}

// the typed row carries an id and every required field: what a row leaves out is filled, the
// worker keeps only the fields sent
function filled(row, info) {
  let out = row.id === undefined ? { id: '', ...row } : row
  for (const key in info?.required) {
    if (out[key] == null) out = { ...out, [key]: ZERO[info.required[key]] }
  }
  return out
}

const ZERO = {
  string: '',
  file: '',
  json: null,
  uint: 0,
  int: 0,
  bool: false,
  bytes: b4a.alloc(0),
  fixed32: b4a.alloc(32),
  fixed64: b4a.alloc(64)
}

// c.any carries undefined as null, and in a query undefined is absent
function toWire(query) {
  if (query === undefined) return null
  const defined =
    query && typeof query === 'object'
      ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined))
      : query
  return c.encode(c.any, defined)
}
