import { Readable } from 'streamx'

import { encodeId, decodeId } from '@cero-base/core/blobs/codec'
import { onAbort, subscribe } from '@cero-base/core/utils'

/**
 * @typedef {import('./refs.js').Ref} Ref
 * @typedef {import('@cero-base/core/database').HookContext} HookContext
 * @typedef {import('../handle/index.js').Context} Context
 * @typedef {import('@cero-base/core/database').Row} Row
 * @typedef {import('@cero-base/core/database').SingleResult} SingleResult
 * @typedef {import('@cero-base/core/database').ListResult} ListResult
 */

/**
 * Resolve a durable file id (+ optional name) to the read shape returned
 * everywhere: `{ id, name?, type, size, url }`.
 *
 * @param {Context} handle
 * @param {string} id
 * @param {string} [name]
 * @returns {{ id: string, type: string, size: number, url: string, name?: string }}
 */
function resolveFile(handle, id, name) {
  const { type, blobId } = decodeId(id)
  const file = { id, type, size: blobId.byteLength, url: handle._link(id) }
  if (name != null) file.name = name
  return file
}

/**
 * Insert (or overwrite by id) a row on `ref`.
 *
 * @param {Ref} ref
 * @param {Row} row
 * @returns {Promise<SingleResult>}
 */
export async function put(ref, row) {
  await opened(ref.handle)
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
 * @param {Row} row
 * @param {{ upsert?: boolean }} [opts]
 * @returns {Promise<SingleResult>}
 */
export async function set(ref, row, opts) {
  await opened(ref.handle)
  return ref.handle.store.set(ref.name, row, opts)
}

/**
 * Delete a row by id (collection refs), or wipe the row (single refs).
 *
 * @param {Ref} ref
 * @param {string} [id]
 * @returns {Promise<void>}
 */
export async function del(ref, id) {
  await opened(ref.handle)
  return ref.handle.store.del(ref.name, id)
}

/**
 * Invoke an `action`-kind ref (a custom mutation declared in the schema).
 *
 * @param {Ref} ref
 * @param {Row} [d]
 * @returns {Promise<void>}
 */
export async function call(ref, d) {
  await opened(ref.handle)
  return ref.handle.store.call(ref.name, d)
}

// an extension's setup runs while the root opens: what it reads or writes waits for the open
function opened(handle) {
  return handle.opened === false ? handle.ready() : null
}

const WRITES = { single: ['set', 'del'], collection: ['put', 'set', 'del'] }

/**
 * Rule that runs before a write to `ref` lands, or before an action does: at apply, on every
 * peer, inside the op's transaction. Return `false` to refuse it: the writer's own call rejects
 * with `REFUSED`. `ctx` is `{ op, name, row, existing, id, memberId, role, get, put, set, del }`;
 * mutate `ctx.row` to rewrite what is stored. `op` is the op as it applies, so an upsert on a
 * collection is a `put`. The four operators on `ctx` read and write the room as it stands at this
 * op, inside the transaction. Must be deterministic: read only `ctx`, never a clock or local
 * state. On a type ref (`me.room.notes`) it reaches every room of the type before the room
 * opens; register in an extension's `setup` to see every op the root applies too. The imported
 * operators throw inside a hook; use the ones on `ctx`. Not available over RPC.
 *
 * @param {Ref} ref
 * @param {(ctx: HookContext) => unknown} fn
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {() => void}
 */
export function before(ref, fn, opts) {
  return hook('before', ref, fn, opts)
}

/**
 * Rule that runs after a write to `ref` lands, at apply, on every peer, inside the op's
 * transaction. On an action it is what the action does. Write derived rows through `ctx.put` /
 * `ctx.set` / `ctx.del`; a throw refuses the whole op. Same `ctx`, determinism and reach as
 * `before`. Use `watch(ref)` instead to observe writes locally.
 *
 * @param {Ref} ref
 * @param {(ctx: HookContext) => unknown} fn
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {() => void}
 */
export function after(ref, fn, opts) {
  return hook('after', ref, fn, opts)
}

// a write hook runs on each write op and keeps to its ref; an action is an op of its own
function hook(phase, ref, fn, opts) {
  if (ref.type) {
    return ref.handle._hookType(ref, (room) => hook(phase, room[ref.name], fn), opts)
  }
  const db = ref.handle.store
  const offs =
    ref.kind === 'action'
      ? [db[phase](ref.name, fn)]
      : (WRITES[ref.kind] || ['set']).map((op) =>
          db[phase](op, (ctx) => (ctx.name === ref.name ? fn(ctx) : undefined))
        )
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
 * @param {string | Record<string, unknown>} [q]
 * @returns {Promise<SingleResult | ListResult>}
 */
export async function get(ref, q) {
  await opened(ref.handle)
  const live = ref.handle._live?.[ref.name]
  if (live) return live.get(q)
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
 * Read a ref as it changes. Each item is what `get(ref, query)` returns now; a slow reader gets
 * only the newest. With `changes: true` in the query each item also carries `changes`, the
 * `{ prev, next }` rows that changed since the item before, so a slow reader gets fewer items,
 * never fewer changes, and `reset`, set on the first item, whose changes list every row with
 * `prev: null`.
 *
 * @param {Ref} ref
 * @param {Record<string, unknown> & { changes?: boolean }} [query]
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {import('streamx').Readable}
 */
export function watch(ref, query, opts) {
  const { changes, ...q } = query || {}
  const owner = ref.handle
  const from = owner.opened === false ? owner.ready().then(() => source(ref, q)) : source(ref, q)
  const diff = changes ? differ(ref.kind === 'single') : null
  return bindStream(owner, snapshotStream(from, diff), opts)
}

function source(ref, q) {
  const live = ref.handle._live?.[ref.name]
  if (live) {
    return { src: subscribe({ get: () => live.get(q), watch: live.watch }), map: (res) => res }
  }
  if (ref.kind === 'handle') {
    return {
      src: parentStore(ref).watch('handles', q),
      map: (snap) => normalize(snap?.data, ref.name)
    }
  }
  return { src: ref.handle.store.watch(ref.name, q), map: (res) => resolveResult(ref, res) }
}

// snapshots are idempotent: a slow reader gets only the newest
function snapshotStream(from, diff) {
  let src = null
  let pending
  let wanted = false
  const out = new Readable({
    read(cb) {
      wanted = true
      flush()
      cb(null)
    },
    destroy(cb) {
      src?.destroy()
      cb(null)
    }
  })
  const flush = () => {
    if (!wanted || pending === undefined || out.destroyed) return
    const snap = pending
    pending = undefined
    wanted = out.push(diff ? diff(snap) : snap) !== false
  }
  const attach = ({ src: s, map }) => {
    if (out.destroyed) return s.destroy()
    src = s
    src.on('data', (res) => {
      pending = map(res)
      flush()
    })
    src.on('end', () => out.push(null))
    src.on('error', (err) => out.destroy(err))
  }
  if (from.then) from.then(attach, (err) => out.destroy(err))
  else attach(from)
  return out
}

// each item against the last one this reader got, so skipped snapshots fold into the next
function differ(single) {
  let last
  return (snap) => {
    const prev = last
    last = snap.data
    const changes = single ? diffOne(prev ?? null, snap.data) : diffRows(prev || [], snap.data)
    return { ...snap, changes, reset: prev === undefined }
  }
}

function diffOne(prev, next) {
  return same(prev, next) ? [] : [{ prev, next }]
}

function diffRows(prev, next) {
  const was = new Map(prev.map((row) => [row.id, row]))
  const changes = []
  for (const row of next) {
    const before = was.get(row.id) ?? null
    was.delete(row.id)
    if (!same(before, row)) changes.push({ prev: before, next: row })
  }
  for (const row of was.values()) changes.push({ prev: row, next: null })
  return changes
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Open (or create / join / load) a child handle through a `handle`-kind ref.
 *
 * @param {Ref} ref
 * @param {string | { invite?: string, id?: string, name?: string } | undefined} [arg]
 * @returns {Promise<Context>}  The resolved child handle.
 */
export function open(ref, arg) {
  if (typeof arg === 'string') return ref.handle._join(arg, ref.name)
  if (arg && typeof arg.invite === 'string') return ref.handle._join(arg.invite, ref.name)
  if (arg && typeof arg.id === 'string') return ref.handle._load(ref.name, arg.id)
  return ref.handle._create(ref.name, arg)
}

/**
 * Mint an invite code into a room.
 *
 * @param {Context} ctx
 * @param {import('@cero-base/core/pairing').InviteOpts} [opts]
 * @returns {Promise<string>}
 */
export function invite(ctx, opts) {
  return ctx._invite(opts)
}

/**
 * Kill an invite, for every member.
 *
 * @param {Context} ctx
 * @param {string} code
 * @returns {Promise<boolean>}  Whether it was live.
 */
export function revoke(ctx, code) {
  return ctx._revoke(code)
}

/**
 * Re-key a room now: a new epoch sealed to its members, so one removed before it reads nothing
 * written after. Needs the remove permission. A removal also re-keys on its own shortly after it
 * lands; this is the one to await.
 *
 * @param {Context} ctx
 * @returns {Promise<{ epoch: number }>}
 */
export function rotate(ctx) {
  return ctx._rotate()
}

/**
 * Write atomically: every write `fn` makes through `tx`, the context it is handed, lands as one
 * batch, or none does. Reads through `tx` see the room as it was before the batch. Not available
 * over RPC.
 *
 * @template T
 * @param {Context} ctx
 * @param {(tx: Context) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function tx(ctx, fn) {
  return ctx._tx(fn)
}

/**
 * Let in a join waiting on a `confirm` invite. `role` is the invite's by default, never above it.
 *
 * @param {Context} ctx
 * @param {{ id: string }} request  A row of `ctx.requests`.
 * @param {{ role?: string }} [opts]
 * @returns {Promise<void>}
 */
export function accept(ctx, request, { role } = {}) {
  return ctx._answer(request.id, { accept: true, role })
}

/**
 * Turn away a join waiting on a `confirm` invite. The joiner's `open` rejects with `DENIED`.
 *
 * @param {Context} ctx
 * @param {{ id: string }} request  A row of `ctx.requests`.
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
export function deny(ctx, request, reason = '') {
  return ctx._answer(request.id, { accept: false, reason })
}

/**
 * Quit a room for good: it leaves your list and closes on this device.
 *
 * @param {Context} ctx
 * @returns {Promise<void>}
 */
export function leave(ctx) {
  return ctx._leave()
}

/**
 * Stop using a context on this device; everything stays. Closing the root closes it all.
 *
 * @param {Context} ctx
 * @returns {Promise<void>}
 */
export function close(ctx) {
  return ctx.close()
}

/**
 * Give up a join still waiting for an answer, for good: it is not resumed on the next boot.
 *
 * @param {Context} me
 * @param {string} code
 * @returns {Promise<boolean>}  Whether a join was waiting.
 */
export function cancel(me, code) {
  return me._cancel(code)
}

/**
 * The app goes to the background: networking, storage and the Bluetooth radio pause together,
 * and every context reports `status.suspended`. On `me` only.
 *
 * @param {Context} me
 * @returns {Promise<void>}
 */
export function suspend(me) {
  return me._suspend()
}

/**
 * The app is back in the foreground: everything `suspend` paused resumes. On `me` only.
 *
 * @param {Context} me
 * @returns {Promise<void>}
 */
export function resume(me) {
  return me._resume()
}

/**
 * Mark a room as the one in use: it ranks first on the swarm, searching and announcing. Rooms are
 * otherwise ranked by their last update.
 *
 * @param {Context} room
 * @returns {Promise<void>}
 */
export async function activate(room) {
  return room._active(true)
}

/**
 * Take a room off the swarm until something lands in it.
 *
 * @param {Context} room
 * @returns {Promise<void>}
 */
export async function deactivate(room) {
  return room._active(false)
}

/**
 * Reveal the recovery phrase.
 *
 * @param {Context} me
 * @returns {Promise<string>}
 */
export function phrase(me) {
  return me._phrase()
}

/**
 * Choose what the device's Bluetooth radio does: find the mesh (`true`), nothing (`false`), or
 * hold one invite's rendezvous (its code) so a joiner in range finds this device with no internet,
 * until the next call or the invite expires.
 *
 * @param {Context} ctx
 * @param {boolean | string} mode
 * @returns {Promise<void>}
 */
export function nearby(ctx, mode) {
  return ctx._nearby(mode)
}
