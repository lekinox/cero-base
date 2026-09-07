import { Readable } from 'streamx'
import b4a from 'b4a'

import { encodeId, decodeId } from '@cero-base/core/blobs/codec'
import { CeroError } from '@cero-base/core/errors'
import { onAbort } from '@cero-base/core/utils'

/**
 * @typedef {import('./refs.js').Ref} Ref
 * @typedef {import('@cero-base/core/database').HookContext} HookContext
 * @typedef {import('../handle/index.js').CeroHandle} CeroHandle
 * @typedef {{ data: any }} SingleResult
 * @typedef {{ data: any[], total: number, size: number }} ListResult
 * @typedef {{ data: any | null }} GetByIdResult
 */

/**
 * Resolve a durable file id (+ optional name) to the read shape returned
 * everywhere: `{ id, name?, type, size, url }`.
 *
 * @param {object} handle
 * @param {string} id
 * @param {string} [name]
 * @returns {{ id: string, type: string, size: number, url: string, name?: string }}
 */
export function resolveFile(handle, id, name) {
  const { type, blobId } = decodeId(id)
  const file = { id, type, size: blobId.byteLength, url: handle.getLink(id) }
  if (name != null) file.name = name
  return file
}

/**
 * Insert (or overwrite by id) a row on `ref`.
 *
 * @param {Ref} ref
 * @param {Record<string, any>} row
 * @returns {Promise<SingleResult>}
 */
export function put(ref, row) {
  return ref.name === 'files' ? putFile(ref, row) : ref.handle.store.put(ref.name, row)
}

async function putFile(ref, row) {
  const handle = ref.handle
  if (handle.rpc) return handle.put('files', row)
  const { data, type, name = null } = row
  const blobs = handle.blobs // captured once — the instance carries its epoch stamp
  await blobs.ready()
  const blobId = await blobs.put(data)
  const id = encodeId(blobs.key, blobId, type)
  await handle.store.call('add-file', { id, name, stamp: blobs.stamp || 0 })
  return { data: resolveFile(handle, id, name) }
}

/**
 * Upsert a row on `ref` — merges with the existing row and preserves `createdAt`.
 *
 * @param {Ref} ref
 * @param {Record<string, any>} row
 * @param {{ upsert?: boolean }} [opts]
 * @returns {Promise<SingleResult>}
 */
export function set(ref, row, opts) {
  return ref.handle.store.set(ref.name, row, opts)
}

/**
 * Delete a row by id (collection refs), or wipe the row (single refs).
 *
 * @param {Ref} ref
 * @param {string} [id]
 * @returns {Promise<void>}
 */
export function del(ref, id) {
  return ref.handle.store.del(ref.name, id)
}

/**
 * Invoke an `action`-kind ref (a custom mutation declared in the schema).
 *
 * @param {Ref} ref
 * @param {Record<string, any>} [d]
 * @returns {Promise<any>}
 */
export function call(ref, d) {
  return ref.handle.store.call(ref.name, d)
}

const WRITES = { single: ['set'], collection: ['put', 'set', 'del'] }

/**
 * Rule that runs before a write to `ref` lands — at apply, on every peer, inside the op's
 * transaction. Return `false` to refuse it: the writer's own call rejects with `REFUSED`.
 * `ctx` is `{ op, name, row, existing, id, memberId, role, get, put, set, del }`; mutate
 * `ctx.row` to rewrite what is stored. `op` is the op as it applies, so an upsert on a
 * collection is a `put`. The four operators on `ctx` read and write the room as it stands at
 * this op, inside the transaction. Must be deterministic — read only `ctx`, never a clock or
 * local state — and registered before any op applies, in the process that owns the data. The
 * imported operators throw inside a hook; use the ones on `ctx`. Not available over RPC.
 *
 * @param {Ref} ref
 * @param {(ctx: HookContext) => unknown} fn
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {() => void}
 */
export function before(ref, fn, opts) {
  if (ref.type) return ref.handle._hookType(before, ref, fn, opts)
  const db = ref.handle.store
  const ops = WRITES[ref.kind] || ['set']
  const offs = ops.map((op) =>
    db.before(op, (ctx) => (ctx.name === ref.name ? fn(ctx) : undefined))
  )
  let stopAbort
  const off = () => {
    offs.forEach((unsub) => unsub())
    stopAbort?.()
  }
  stopAbort = onAbort(opts?.signal, off)
  return off
}

/**
 * Rule that runs after a write to `ref` lands — at apply, on every peer, inside the op's
 * transaction. Write derived rows through `ctx.put` / `ctx.set` / `ctx.del`; a throw refuses
 * the whole op. Same `ctx` and the same determinism and registration rules as `before`. Use
 * `changes(ref)` instead to observe writes locally.
 *
 * @param {Ref} ref
 * @param {(ctx: HookContext) => unknown} fn
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {() => void}
 */
export function after(ref, fn, opts) {
  if (ref.type) return ref.handle._hookType(after, ref, fn, opts)
  const db = ref.handle.store
  const ops = WRITES[ref.kind] || ['set']
  const offs = ops.map((op) => db.after(op, (ctx) => (ctx.name === ref.name ? fn(ctx) : undefined)))
  let stopAbort
  const off = () => {
    offs.forEach((unsub) => unsub())
    stopAbort?.()
  }
  stopAbort = onAbort(opts?.signal, off)
  return off
}

// handle refs read their rows from the parent's `handles` collection, filtered by type
const parentStore = (ref) => (ref.handle.root ? ref.handle.root.store : ref.handle.store)

const normalize = (rows, name) => {
  const data = (rows || []).filter((r) => r.type === name)
  return { data, total: data.length, size: data.length }
}

function resolveResult(ref, res) {
  if (res == null || res.data == null) return res
  const data = Array.isArray(res.data)
    ? res.data.map((row) => resolveRow(ref, row))
    : resolveRow(ref, res.data)
  return { ...res, data }
}

function resolveRow(ref, row) {
  if (!row || typeof row !== 'object') return row
  if (ref.handle.rpc) return ref.handle._resolveRow(ref.name, ref.handle._refInfo(ref.name), row)
  const handle = ref.handle
  const resolve = (id, name, stamp) => {
    handle._registerBlobCore(id, stamp)
    return resolveFile(handle, id, name)
  }
  if (ref.name === 'files') {
    return { ...row, ...resolve(row.id, row.name, row.stamp) }
  }
  const fields = handle.store.refs?.[ref.name]?.files
  if (!fields || !fields.length) return row
  const out = { ...row }
  for (const f of fields) {
    const v = out[f]
    if (v == null) continue
    out[f] = resolve(v)
  }
  return out
}

/**
 * Read from `ref`. For data refs, dispatches to the underlying store.
 *
 * @param {Ref} ref
 * @param {string | Record<string, any>} [q]
 * @returns {Promise<SingleResult | ListResult | GetByIdResult>}
 */
export async function get(ref, q) {
  if (ref.kind === 'handle') {
    const { data } = await parentStore(ref).get('handles', q)
    return normalize(data, ref.name)
  }
  const res = await ref.handle.store.get(ref.name, q)
  return resolveResult(ref, res)
}

// a watch stream dies with its handle, or with the signal
const bindStream = (owner, stream, opts) => {
  const stopAbort = onAbort(opts?.signal, () => stream.destroy())
  // drop the abort listener once the stream ends
  if (stopAbort) stream.once('close', stopAbort)
  return owner.own ? owner.own(stream) : stream
}

/**
 * Live snapshot stream on `ref` — re-emits the latest `get()` result on every underlying
 * mutation.
 *
 * @param {Ref} ref
 * @param {Record<string, any>} [q]
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {import('streamx').Readable}
 */
export function watch(ref, q, opts) {
  const owner = ref.handle
  if (ref.kind !== 'handle') {
    const src = owner.store.watch(ref.name, q)
    const out = snapshotStream(src, (res) => resolveResult(ref, res))
    return bindStream(owner, out, opts)
  }
  const source = parentStore(ref).watch('handles', q)
  const out = snapshotStream(source, (snap) => normalize(snap?.data, ref.name))
  return bindStream(owner, out, opts)
}

/**
 * Delta subscription: batches of `{ prev, next }` row pairs instead of full snapshots —
 * lossless under backpressure, self-contained (the first batch, and any batch after a view
 * swap, replays current.
 */
export function changes(ref, q, opts) {
  const owner = ref.handle
  if (ref.kind === 'handle') throw CeroError.INVALID('changes does not support handle refs')
  const src = owner.store.changes(ref.name, q)
  let resume = null
  const wake = () => {
    const r = resume
    resume = null
    if (r) r()
  }
  const out = new Readable({
    read(cb) {
      wake()
      cb(null)
    },
    destroy(cb) {
      wake()
      src.destroy()
      cb(null)
    }
  })
  const pump = async () => {
    for await (const batch of src) {
      const changes = []
      for (const { prev, next } of batch.changes) {
        changes.push({
          prev: prev && resolveRow(ref, prev),
          next: next && resolveRow(ref, next)
        })
      }
      if (out.push({ ...batch, changes }) === false) {
        await new Promise((r) => {
          resume = r
        })
        if (out.destroyed) return
      }
    }
    out.push(null)
  }
  pump().catch((err) => {
    if (!out.destroyed) out.destroy(err)
  })
  return bindStream(owner, out, opts)
}

// snapshots are idempotent: a slow consumer gets only the newest
function snapshotStream(src, map) {
  let pending
  let wanted = false
  const out = new Readable({
    read(cb) {
      wanted = true
      flush()
      cb(null)
    },
    destroy(cb) {
      src.destroy()
      cb(null)
    }
  })
  const flush = () => {
    if (!wanted || pending === undefined || out.destroyed) return
    const snap = pending
    pending = undefined
    wanted = out.push(snap) !== false
  }
  src.on('data', (res) => {
    pending = map(res)
    flush()
  })
  src.on('end', () => out.push(null))
  src.on('error', (err) => out.destroy(err))
  return out
}

/**
 * Open (or create / join / load) a child handle through a `handle`-kind ref.
 *
 * @param {Ref} ref
 * @param {string | { invite?: string, id?: string, name?: string, routes?: any, role?: string, accept?: boolean } | undefined} [arg]
 * @returns {Promise<CeroHandle>}  The resolved child handle.
 */
export function open(ref, arg) {
  if (typeof arg === 'string') return ref.handle._join(arg, ref.name)
  if (arg && typeof arg.invite === 'string') return ref.handle._join(arg.invite, ref.name)
  if (arg && typeof arg.id === 'string') return ref.handle._load(ref.name, arg.id, arg)
  return ref.handle._create(ref.name, arg)
}

/**
 * Rotate a handle's encryption epoch. A fresh secret is sealed to every current member and
 * announced through the log — members removed before the rotation cannot decrypt anything
 * written after it.
 *
 * @param {any} handle
 * @returns {Promise<{ epoch: number }>}
 */
export function rotate(handle) {
  return handle.store.rotate()
}
