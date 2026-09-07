import b4a from 'b4a'
import { Readable } from 'streamx'

import { ROLE_PERMS, RANK, QUERY_RESERVED } from './constants.js'

// can() callers need the capability names, and constants.js is not public
export { WRITE, INVITE, ASSIGN, REMOVE } from './constants.js'

// binding the db key makes an admission unreplayable across rooms
const ADD_WRITER_TAG = b4a.from('cero/add-writer')
const CLAIM_WRITER_TAG = b4a.from('cero/claim-writer')

/** @type {(dbKey: Uint8Array, writer: Uint8Array, appender: Uint8Array) => Uint8Array} */
export function admission(dbKey, writer, appender) {
  return b4a.concat([ADD_WRITER_TAG, dbKey, writer, appender])
}

/** @type {(dbKey: Uint8Array, writer: Uint8Array) => Uint8Array} */
export function ownership(dbKey, writer) {
  return b4a.concat([CLAIM_WRITER_TAG, dbKey, writer])
}

/**
 * Whether `role` is granted `perm` under the default policy.
 *
 * @param {string} role
 * @param {string} perm
 * @returns {boolean}
 */
export function can(role, perm) {
  const perms = ROLE_PERMS[role]
  return !!perms && (perms.includes('*') || perms.includes(perm))
}

// an unknown role grants nothing; callers taking a role from an app must check it
export function isRank(role) {
  return RANK[role] != null
}

export function grants(a, b) {
  return RANK[a] != null && RANK[b] != null && RANK[a] >= RANK[b]
}
export function outranks(a, b) {
  return RANK[a] != null && RANK[b] != null && RANK[a] > RANK[b]
}

/**
 * Stream-of-snapshots primitive. Couples a `get` (returns the latest value) with a `watch`
 * (re-fires on change) and emits the newest snapshot every time `watch` ticks.
 *
 * @template T
 * @param {object} args
 * @param {() => Promise<T> | T} args.get
 * @param {(fn: () => void) => (() => void) | void} args.watch
 * @returns {import('streamx').Readable<T>}
 */
export function subscribe({ get, watch }) {
  let stop = null
  let last
  const stream = new Readable({
    destroy(cb) {
      Promise.resolve(stop?.()).then(() => cb(null), cb)
    }
  })

  const emit = (data) => {
    const snap = JSON.stringify(data)
    if (snap === last) return
    last = snap
    stream.push(data)
  }

  // one get() in flight; ticks mid-read fold into a single trailing re-read
  let running = false
  let dirty = false
  const push = async () => {
    if (stream.destroyed) return
    if (running) {
      dirty = true
      return
    }
    running = true
    try {
      do {
        dirty = false
        const data = await get()
        if (stream.destroyed) return
        emit(data)
      } while (dirty)
    } catch (e) {
      stream.destroy(e)
    } finally {
      running = false
    }
  }

  stop = watch(push)
  push()
  return stream
}

const fold = (s) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s/g, '')

// every term must be a substring of a searched field
export function searchHit(row, term, fields) {
  const terms = String(term).split(/\s+/).map(fold).filter(Boolean)
  // memberId is a random z32, it would produce spurious hits
  const keys = fields && fields.length ? fields : Object.keys(row).filter((k) => k !== 'memberId')
  const hay = keys.map((k) => (typeof row[k] === 'string' ? fold(row[k]) : '')).join(' ')
  return terms.every((t) => hay.includes(t))
}

/**
 * The in-memory query grammar over rows: equality on any non-reserved field,
 * id ranges, `search`, then `reverse` and `limit`.
 *
 * @param {any[]} rows
 * @param {Record<string, any>} [query]
 * @returns {any[]}
 */
export function filter(rows, query) {
  if (!query) return rows
  let out = rows
  for (const key of Object.keys(query)) {
    if (QUERY_RESERVED.has(key)) continue
    out = out.filter((r) => valueEq(r[key], query[key]))
  }
  if (query.gt !== undefined) out = out.filter((r) => r.id > query.gt)
  if (query.gte !== undefined) out = out.filter((r) => r.id >= query.gte)
  if (query.lt !== undefined) out = out.filter((r) => r.id < query.lt)
  if (query.lte !== undefined) out = out.filter((r) => r.id <= query.lte)
  if (query.search) out = out.filter((r) => searchHit(r, query.search, query.fields))
  if (query.reverse) out = [...out].reverse()
  if (query.limit !== undefined) out = out.slice(0, query.limit)
  return out
}

function valueEq(a, b) {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return b4a.equals(a, b)
  return a === b
}

/**
 * Run `cb` when `signal` aborts — or immediately if it already has.
 *
 * @param {AbortSignal | undefined} signal
 * @param {() => void} cb
 * @returns {(() => void) | undefined}
 */
export function onAbort(signal, cb) {
  if (!signal) return
  if (signal.aborted) return void cb()
  signal.addEventListener('abort', cb, { once: true })
  return () => signal.removeEventListener('abort', cb)
}
