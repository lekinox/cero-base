import fs from 'fs'

import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import HyperDB from 'hyperdb'
import ReadyResource from 'ready-resource'

import { ROCKS, BEE, SINGLE, COLLECTION, QUERY_RESERVED } from '../lib/constants.js'
import { genId } from '../lib/ids.js'
import { subscribe, filter, checkFields, checkRequired, stamp } from '../lib/utils.js'
import { CeroError } from '../lib/errors.js'

/**
 * @typedef {object} StorageOpts
 * @property {{ database: object, meta?: { ns?: string, refs?: Record<string, { kind?: string }> } }} spec
 * @property {'rocks' | 'bee'} backend
 * @property {import('hypercore-storage')} [root]  Pre-existing HypercoreStorage to reuse.
 * @property {import('corestore')} [store]         Pre-existing Corestore to reuse.
 * @property {Uint8Array} [storageKey]  32-byte key encrypting the backing core at rest (bee backend only).
 *
 * @typedef {{ name: string, kind: string }} Ref
 * @typedef {import('../database/index.js').Row} Row
 * @typedef {import('../database/index.js').SingleResult} SingleResult
 * @typedef {import('../database/index.js').ListResult} ListResult
 */

/**
 * Local, single-writer storage. Backed by either RocksDB (`rocks`) or a Hyperbee on top of
 * corestore (`bee`).
 */
export class Storage extends ReadyResource {
  /**
   * @param {string} dir
   * @param {StorageOpts} [opts]
   */
  constructor(dir, { spec, backend, root, store, storageKey } = {}) {
    super()
    if (!root && !store && (typeof dir !== 'string' || !dir)) {
      throw CeroError.REQUIRED('dir, root, or store')
    }
    if (!spec || !spec.database) throw CeroError.REQUIRED('spec.database')
    if (backend !== ROCKS && backend !== BEE) {
      throw CeroError.INVALID('backend must be "rocks" or "bee"')
    }
    if (storageKey && backend === ROCKS) {
      throw CeroError.INVALID('storageKey requires the bee backend')
    }
    if (storageKey && storageKey.byteLength !== 32) {
      throw CeroError.INVALID('storageKey must be 32 bytes')
    }

    this.dir = dir
    this.spec = spec
    this.backend = backend
    this.storageKey = storageKey || null
    this.ns = spec.meta?.ns || 'cero'
    this.refs = spec.meta?.refs || {}

    /** @private */
    this._cf = `${this.ns}/local`
    /** @private */
    this._ownsRoot = !root && !store
    /** @private */
    this._ownsStore = !store
    /** @type {import('hypercore-storage') | null} */
    this.root = root || null
    /** @type {import('corestore') | null} */
    this.store = store || null
    /** @type {import('hyperdb') | null} */
    this.db = null
    /** @private */
    this._writing = null
  }

  /** @private */
  async _open() {
    if (this._ownsRoot) {
      this.root = new HypercoreStorage(this.dir, { columnFamilies: [this._cf] })
      await this.root.ready()
      await fs.promises.chmod(this.dir, 0o700)
    }

    if (this._ownsStore) {
      this.store = new Corestore(this.root, { manifestVersion: 2 })
      await this.store.ready()
    }

    if (this.backend === ROCKS) {
      if (!this.root) {
        throw CeroError.INVALID('rocks backend requires a root storage, not store-only')
      }
      const cf = this.root.rocks.columnFamily(this._cf)
      this.db = HyperDB.rocks(cf, this.spec.database)
    } else {
      const core = this.store.get({ name: 'local', encryptionKey: this.storageKey })
      await core.ready()
      this.db = HyperDB.bee(core, this.spec.database, { extension: false, autoUpdate: true })
    }
    await this.db.ready()
  }

  /** @private */
  async _close() {
    if (this.db) {
      // after the writes already queued
      if (this.db.flush) await this._serial(() => this.db.flush())
      await this.db.close()
      this.db = null
    }
    if (this._ownsStore && this.store) {
      await this.store.close()
      this.store = null
    }
    if (this._ownsRoot && this.root) {
      await this.root.close()
      this.root = null
    }
  }

  /**
   * Insert (or overwrite by id) a row, stamping `id`/`createdAt`/`updatedAt`.
   *
   * @param {string} name
   * @param {Record<string, unknown>} row
   * @returns {Promise<SingleResult>}
   */
  async put(name, row) {
    this._guard()
    const ref = this._ref(name)
    checkFields(name, this.refs[name], row)
    const was = row.id == null ? null : await this._read(ref, row.id)
    const stored = stamp({ ...row, id: row.id ?? genId() }, was?.createdAt)
    checkRequired(name, this.refs[name], stored)
    await this._write(ref, stored)
    return { data: stored }
  }

  /**
   * Upsert by merging with the existing row, preserving `createdAt`.
   *
   * @param {string} name
   * @param {Record<string, unknown>} row
   * @param {{ upsert?: boolean }} [opts]
   * @returns {Promise<SingleResult | null>}
   */
  async set(name, row, { upsert = true } = {}) {
    this._guard()
    const ref = this._ref(name)
    checkFields(name, this.refs[name], row)
    const existing = await this._read(ref, row?.id)
    if (!upsert && !existing) return null
    /** @type {Row} */
    const stored = stamp({ ...existing, ...row }, existing?.createdAt)
    checkRequired(name, this.refs[name], stored)
    if (ref.kind === COLLECTION && !stored.id) stored.id = genId()
    await this._write(ref, stored)
    return { data: stored }
  }

  /**
   * Delete by id (collection) or wipe the whole single-row table.
   *
   * @param {string} name
   * @param {string} [id]
   * @returns {Promise<void>}
   */
  async del(name, id) {
    this._guard()
    const ref = this._ref(name)
    const col = this._col(ref)
    await this._serial(async () => {
      await this.db.delete(col, id != null ? { id } : {})
      await this.db.flush()
    })
  }

  /**
   * Read a row. With no `query`: list all (collection) or fetch the one
   * record (single). With a string id: fetch that specific row.
   *
   * @param {string} name
   * @param {string | Record<string, unknown>} [query]
   * @returns {Promise<SingleResult | ListResult>}
   */
  async get(name, query) {
    this._guard()
    const ref = this._ref(name)
    const col = this._col(ref)

    if (ref.kind === SINGLE) return { data: await this.db.findOne(col, {}) }

    if (typeof query === 'string') {
      return { data: (await this.db.get(col, { id: query })) ?? null }
    }

    // hyperdb ignores equality fields and search, apply them here
    const eq = Object.keys(query || {}).filter((k) => !QUERY_RESERVED.has(k))
    if (eq.length || query?.search) {
      const rows = await this.db.find(col, {}).toArray()
      const matched = filter(rows, { ...query, limit: undefined })
      const data = query.limit != null ? matched.slice(0, query.limit) : matched
      return { data, total: matched.length, size: data.length }
    }

    const data = await this.db.find(col, range(query)).toArray()
    // a full page leaves the count unknown unless asked, so a limited read stops at the page
    const full = query?.limit != null && data.length >= query.limit
    if (!full) return { data, total: data.length, size: data.length }
    const all = query.total
      ? await this.db.find(col, range({ ...query, limit: undefined })).toArray()
      : null
    return { data, total: all?.length ?? null, size: data.length }
  }

  /**
   * Live snapshot stream — re-emits the latest `get()` result on every
   * underlying mutation. Destroy the stream to stop watching.
   *
   * @param {string} name
   * @param {Record<string, unknown>} [query]
   * @returns {import('streamx').Readable}
   */
  watch(name, query) {
    this._guard()
    this._ref(name)
    // close nulls this.db, a teardown after it unwatches the db it watched
    const db = this.db
    return subscribe({
      get: () => this.get(name, query),
      watch: (fn) => {
        db.watch(fn)
        return () => db.unwatch(fn)
      }
    })
  }

  /** @private */
  _guard() {
    if (this.closing || this.closed) throw CeroError.CLOSED('Storage')
    if (!this.db) throw CeroError.NOT_READY('Storage', 'storage')
  }

  /**
   * @param {string} name @returns {Ref}
   * @private
   */
  _ref(name) {
    if (typeof name !== 'string' || !name) {
      throw CeroError.INVALID('name must be a non-empty string')
    }
    const ref = this.refs[name]
    if (!ref) throw CeroError.UNKNOWN('ref', name)
    return { name, kind: ref.kind || COLLECTION }
  }

  /**
   * @param {Ref} ref @returns {string}
   * @private
   */
  _col(ref) {
    return `@${this.ns}/${ref.name}`
  }

  /**
   * @param {Ref} ref @param {string} [id] @returns {Promise<Row | null>}
   * @private
   */
  async _read(ref, id) {
    if (ref.kind === SINGLE) return this.db.findOne(this._col(ref), {})
    if (id == null) return null
    return (await this.db.get(this._col(ref), { id })) ?? null
  }

  /**
   * @param {Ref} ref @param {Row} row @returns {Promise<void>}
   * @private
   */
  async _write(ref, row) {
    await this._serial(async () => {
      await this.db.insert(this._col(ref), row)
      await this.db.flush()
    })
  }

  // one write at a time: hyperdb refuses a flush while another write is in progress
  /** @private */
  async _serial(write) {
    const previous = this._writing
    const current = (async () => {
      try {
        await previous
      } catch {}
      await write()
    })()
    this._writing = current
    await current
  }

  /**
   * Construct a RocksDB-backed Storage.
   *
   * @param {string} dir
   * @param {Omit<StorageOpts, 'backend'>} opts
   */
  static rocks(dir, opts) {
    return new Storage(dir, { ...opts, backend: ROCKS })
  }

  /**
   * Construct a Hyperbee-backed Storage.
   *
   * @param {string} dir
   * @param {Omit<StorageOpts, 'backend'>} opts
   */
  static bee(dir, opts) {
    return new Storage(dir, { ...opts, backend: BEE })
  }
}

// hyperdb bounds are records, a bare id must be wrapped
function range({ gt, gte, lt, lte, reverse, limit } = {}) {
  const id = (v) => (v === undefined ? undefined : { id: v })
  return { gt: id(gt), gte: id(gte), lt: id(lt), lte: id(lte), reverse, limit }
}
