import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import z32 from 'z32'
import hid from 'hypercore-id-encoding'

import {
  SINGLE,
  COLLECTION,
  ACTION,
  COUNTERS,
  VERSION,
  BUILT,
  OWED,
  EPOCHS,
  REMOVALS,
  REFUSALS,
  SPENT,
  ASKS,
  OWNER,
  INVITE,
  REMOVE,
  ASSIGN,
  WRITE
} from '../lib/constants.js'
import {
  can,
  isRank,
  grants,
  outranks,
  admission,
  joining,
  checkFields,
  checkRequired,
  stamp
} from '../lib/utils.js'
import { CeroError } from '../lib/errors.js'
import { getEncoding } from '../lib/spec/index.js'
import { decodeId } from '../blobs/codec.js'
import { Identity } from '../identity/index.js'
import { Invite } from '../pairing/invite.js'
import { keyPair } from '../mailbox/inbox.js'
import { wraps } from './encryption.js'

const Join = getEncoding('@cero/join')

// wire fields are variable-length: reject wrong sizes before sodium and hid throw on them
const isKey = (b) => b?.byteLength === 32

function sealed(wrapped) {
  try {
    c.decode(wraps, wrapped)
    return true
  } catch {
    return false
  }
}

// member and device have their own set handlers, every other collection upserts via add-
export const BESPOKE = new Set(['member', 'device'])

// what a member who may not write sets on her own row, as profileSync mirrors it
const PROFILE = ['name', 'avatar']
const profile = (row, op) => ({
  ...row,
  ...Object.fromEntries(PROFILE.filter((f) => f in op).map((f) => [f, op[f]]))
})

// the request type of each of Cero's routes that writes no ref's row
const REQUESTS = {
  'add-writer': 'writer',
  'del-writer': 'writer',
  join: 'join',
  accept: 'accept',
  deny: 'deny',
  'rotate-key': 'epoch',
  revoke: 'revoke',
  'ask-key': 'owed'
}

// the device keys a request stands on: its own, and those of the chain its join proved or a link
// wrote for it
export const chainOf = ({ key, proof }) => [...Identity.chain(proof).slice(1), key]

// the chain a link wrote, which a seat keeps and an answer carries: a join's proof signs its join,
// and alone verifies as nothing
export const linkOf = (proof) => (Identity.verify(proof, null) ? proof : null)

// where an identity stands in a handle, and where each state leads: one with none is over
const STATES = {
  asking: ['joining', 'denied', 'expired', 'cancelled'],
  joining: ['in', 'denied'],
  in: ['leaving', 'removed'],
  leaving: ['left', 'removed'],
  left: [],
  removed: [],
  denied: [],
  expired: [],
  cancelled: []
}

// on its way in: such a row is not deleted. A leave ends by deleting its row
const UNSETTLED = new Set(['asking', 'joining'])

// a handles row with no state is `in`. One that is over is asked again under another invite, and
// a denied one is let in under its own, by another device of the identity
function moves(was, row) {
  const to = row.state || 'in'
  if (!STATES[to]) return false
  if (!was) return true
  const from = was.state || 'in'
  if (from === to || STATES[from].includes(to)) return true
  if (STATES[from].length || !row.invite) return false
  if (to === 'asking') return row.invite !== was.invite
  return from === 'denied' && to === 'joining' && row.invite === was.invite
}

// a member who left, apart from one removed and from a revoked device, in the removals: ids never hold ':'
export const leftId = (memberId) => `left:${memberId}`

// what an identity's devices told a room of its device keys, in the removals too
export const toldId = (memberId) => `told:${memberId}`

/**
 * 32-byte keys back to back, or none when they are not that.
 *
 * @param {Uint8Array | null} [buf]
 * @returns {Uint8Array[]}
 */
export function keysOf(buf) {
  if (!buf?.byteLength || buf.byteLength % 32) return []
  return Array.from({ length: buf.byteLength / 32 }, (_, i) => buf.subarray(i * 32, i * 32 + 32))
}
const has = (keys, key) => keys.some((k) => b4a.equals(k, key))

// the chain a seat stands on, its identity first
export const seatChain = (device) => [
  hid.decode(device.memberId),
  ...keysOf(device.chain),
  device.key
]

/**
 * Build the hyperdispatch router for a spec: wires membership, builtin, and
 * spec-defined collection/action ops, returning the router plus an apply loop.
 *
 * @param {object} opts
 * @param {{ dispatch: { Router: Function, encode: (name: string, value: unknown, opts?: { version?: number }) => Uint8Array }, meta?: { refs?: Record<string, { kind?: string, internal?: boolean, own?: boolean, verb?: string, fields?: string[], required?: Record<string, string> }>, encoding?: Record<string, number> } }} opts.spec  Generated hyperdispatch spec.
 * @param {string} opts.ns  Namespace prefix for collection and op names.
 * @param {number} opts.start  The version of a database that holds no version row.
 * @param {() => number} opts.contract  This build's contract: an op whose effective stamp is past it is skipped.
 * @param {(stamp: number) => void} opts.onskip  Called with the effective stamp of each op skipped as past the contract.
 * @param {() => number[]} opts.build  The row describing this build, kept in the view it applies: its database, rules, contract and the lowest version it skipped.
 * @param {(err: Error) => void} opts.onerror  Called when a malformed node is skipped.
 * @param {() => Uint8Array | null} opts.key  The database key, null until the bee booted.
 * @param {(row: { epoch: number, stamp: number, wrapped: Uint8Array, commit: Uint8Array }) => Promise<void>} opts.onepoch  Per-peer side of an applied rotation (skipped in dry runs).
 * @param {() => { publicKey: Uint8Array, secretKey: Uint8Array } | null} opts.room  The keypair behind the database's address, which joins that name no invite are sealed to.
 * @param {boolean} [opts.root]  The identity's own database, where a device key past a removed one stands while seated.
 * @param {(phase: 'before' | 'after', op: string) => Function[]} opts.hooks  Registered hooks for an op, run inside its transaction.
 * @param {(name: string) => void} opts.touch  Marks a ref written by a hook, once its batch commits, so its watchers tick.
 * @param {(view: object, name: string, query?: string | import('./index.js').Query) => Promise<import('./index.js').SingleResult | import('./index.js').ListResult>} opts.read  Planned read against a given view, for a hook's `ctx.get`.
 * @returns {{ encode: (route: string, value: unknown, stamp: number) => Uint8Array, cut: (route: string, value: Record<string, unknown>, stamp: number) => Record<string, unknown>, dispatch: (value: Buffer, ctx: object) => Promise<void>, role: (view: object, writer: Uint8Array) => Promise<string | null>, stands: (view: object, chain: Uint8Array[], telling?: { removed?: Uint8Array, standing?: Uint8Array }) => Promise<boolean>, version: (view: object) => Promise<number>, built: (view: object) => Promise<Array<number | null> | null>, apply: (nodes: Array<{ value: Buffer, key: Buffer, version: number }>, view: object, host: object) => Promise<{ landed: Array<{ value: Buffer, key: Buffer, version: number }>, changed: boolean }> }}  `apply` takes each op with its author's stamp, runs it at its effective stamp, and resolves to the nodes that landed and whether they changed a row.
 */
export function makeDispatcher({
  spec,
  ns,
  start,
  contract,
  onskip,
  build,
  onerror,
  key,
  onepoch,
  room,
  root = false,
  hooks,
  touch,
  read
}) {
  const router = new spec.dispatch.Router()

  const col = (name) => `@${ns}/${name}`
  const countersCol = `@${ns}/${COUNTERS}`
  const removals = `@${ns}/${REMOVALS}`
  const refusals = `@${ns}/${REFUSALS}`
  const spent = `@${ns}/${SPENT}`
  const asks = `@${ns}/${ASKS}`
  const getMember = (view, id) => view.get(`@${ns}/members`, { id })
  const getDevice = (view, id) => view.get(`@${ns}/devices`, { id })

  const getSignerRole = async (view, writerKey) => {
    if (!writerKey) return null
    const d = await getDevice(view, hid.encode(writerKey))
    return d?.memberId ? ((await getMember(view, d.memberId))?.role ?? null) : null
  }
  const isIdentity = (id) => {
    try {
      return isKey(hid.decode(id))
    } catch {
      return false
    }
  }
  // a writer stays with the member it was admitted for: nothing moves it to another
  const boundElsewhere = async (view, writer, memberId) => {
    const device = await getDevice(view, hid.encode(writer))
    return !!device && device.memberId !== memberId
  }
  const getSignerMember = async (view, key) =>
    (key ? (await getDevice(view, hid.encode(key)))?.memberId : null) ?? null
  const canRemoveMember = async (view, signerKey, targetMemberId) => {
    const r = await getSignerRole(view, signerKey)
    if (!can(r, REMOVE)) return false
    const tRole = targetMemberId ? (await getMember(view, targetMemberId))?.role : null
    return !tRole || outranks(r, tRole)
  }
  // without this owner the others would have nobody who outranks them all
  const orphans = async (view, id) => {
    const others = (await view.find(`@${ns}/members`, {}).toArray()).filter((m) => m.id !== id)
    return others.length > 0 && !others.some((m) => m.role === OWNER)
  }

  // every peer mints the same ids: the node's seed and a count within it, past any id the
  // collection already holds, so no row written before can make a derived one an overwrite
  function minter(seed) {
    let n = 0
    return async (view, name) => {
      while (true) {
        const id = z32.encode(crypto.hash([seed, c.encode(c.uint, n++)]).subarray(0, 16))
        if (!(await view.get(name, { id }))) return id
      }
    }
  }

  async function bump(view, name) {
    const value = ((await view.get(countersCol, { name }))?.value ?? 0) + 1
    await view.insert(countersCol, { name, value })
    return value
  }

  // set where someone who may hold the keys is taken out, decided again by each rotation that lands
  const owe = (view, value = 1) => view.insert(countersCol, { name: OWED, value })

  // every reader decodes a file id it renders: one that does not decode never lands
  function checkFiles(name, row) {
    const fields = name === 'files' ? ['id'] : (spec.meta?.refs?.[name]?.files ?? [])
    for (const field of fields) {
      if (row[field] == null) continue
      try {
        decodeId(row[field])
      } catch (err) {
        throw CeroError.REFUSED('file', err.message)
      }
    }
  }

  async function insert(view, name, op) {
    checkFiles(name, op)
    if (name !== COUNTERS) {
      const existing = op.id != null ? await view.get(col(name), op) : null
      // an overwrite keeps when the row was first written, whatever the op carries
      if (existing?.createdAt) op.createdAt = existing.createdAt
      op.index = existing?.index ?? (await bump(view, name))
    }
    await view.insert(col(name), op)
  }

  // a ctx write runs no hooks: one writing its own ref would recurse
  const pick = (op, ctx) => {
    if (ctx.nested) return null
    const before = hooks('before', op)
    const after = hooks('after', op)
    return before.length || after.length ? { before, after } : null
  }

  const refName = (ref) => (typeof ref === 'string' ? ref : ref?.name)
  const single = (name) => spec.meta?.refs?.[name]?.kind === SINGLE
  // a name with no route, a counter or an epoch among them, fails to encode
  const verbOf = (name) => spec.meta?.refs?.[name]?.verb || name
  const stored = (view, name, id) =>
    single(name) ? view.findOne(col(name), {}) : view.get(col(name), { id })

  // the database's version: its row, or the start for a database that never wrote one
  const versionOf = async (view) => (await view.get(countersCol, { name: VERSION }))?.value ?? start

  // the build that applied a view, as the view holds it: null for an empty view, nulls for one a
  // build from before the row applied
  const built = async (view) => {
    const row = await Promise.all(
      BUILT.map(async (name) => (await view.get(countersCol, { name }))?.value ?? null)
    )
    if (row[0] === null && !(await view.findOne(`@${ns}/devices`, {}))) return null
    return row
  }

  // each route's request type, and for a ref's add and set the ref its row is stored in
  const routes = new Map()
  for (const [name, info] of Object.entries(spec.meta?.refs || {})) {
    if (info.live || info.kind === 'handle' || !info.schema) continue
    if (info.kind === ACTION) {
      routes.set(`@${ns}/${name}`, { type: info.schema, name: null })
      continue
    }
    for (const verb of ['add', 'set']) {
      routes.set(`@${ns}/${verb}-${info.verb || name}`, { type: info.schema, name })
    }
  }
  for (const [route, type] of Object.entries(REQUESTS)) {
    routes.set(`@${ns}/${route}`, { type: `@${ns}/${type}`, name: null })
  }
  const since = spec.meta?.since
  const upgrade = `@${ns}/upgrade`

  // the ref or action each route writes, as a refusal names it
  const things = new Map()
  for (const [name, info] of Object.entries(spec.meta?.refs || {})) {
    if (info.kind === ACTION) {
      things.set(`@${ns}/${name}`, name)
      continue
    }
    for (const verb of ['add', 'set', 'del']) {
      things.set(`@${ns}/${verb}-${info.verb || name}`, name)
    }
  }

  // the bytes a build at `stamp` writes; the upgrade is named at every version, as decode reads it
  function encode(route, value, stamp) {
    if (route !== upgrade) supported(route, value, stamp)
    return spec.dispatch.encode(route, value, { version: spec.meta?.encoding?.[stamp] })
  }

  // a write naming what its stamp does not have is refused on its device: left out, it would be
  // lost without a word
  function supported(route, value, stamp) {
    const name = things.get(route) ?? route
    if ((since?.routes[route] ?? 0) > stamp) throw CeroError.UNSUPPORTED(`'${name}'`)
    const fields = since?.types[routes.get(route)?.type] ?? {}
    for (const f of Object.keys(fields)) {
      if (fields[f] > stamp && value?.[f] != null) {
        throw CeroError.UNSUPPORTED(`'${f}' in '${name}'`)
      }
    }
  }

  // a row without the fields its stamp has none for, which apply keeps as stored
  function cut(route, value, stamp) {
    const fields = since?.types[routes.get(route)?.type] ?? {}
    return Object.fromEntries(Object.entries(value).filter(([f]) => (fields[f] ?? 0) <= stamp))
  }

  // what the op's author could not name, decided from its stamp and the schema before any hook
  // sees it: a route newer than the stamp, or one this build does not know, refuses its batch on
  // every build, and a newer field keeps what is stored
  async function decode(value, stamp, view) {
    let op
    try {
      op = spec.dispatch.decode(value)
    } catch (err) {
      if (err?.code !== 'HANDLER_NOT_FOUND_BY_ID') throw err
      throw CeroError.REFUSED('route', `${err.message}: a route this build does not know`)
    }
    // the op that moves the version is named at every version, or nothing could move it
    if (op.name === upgrade) return op
    if ((since?.routes[op.name] ?? 0) > stamp) {
      throw CeroError.REFUSED('route', `${op.name} is newer than its op`)
    }
    const route = routes.get(op.name)
    const fields = route ? since?.types[route.type] : null
    const newer = fields ? Object.keys(fields).filter((f) => fields[f] > stamp) : []
    if (newer.length === 0) return op
    const row = route.name ? await stored(view, route.name, op.value.id) : null
    for (const f of newer) op.value[f] = row?.[f] ?? null
    return op
  }

  // the operators developers know, bound to this op. A write is dispatched as the op's writer
  // would append it, so the same rank and `own` rules judge it
  function operators(ctx) {
    const current = (name, id) => stored(ctx.view, name, id)
    // held to the fields as a direct write is, before the encoder drops or chokes on one
    const held = (name, row, stored) => {
      checkFields(name, spec.meta?.refs?.[name], row)
      checkRequired(name, spec.meta?.refs?.[name], stored)
      return stored
    }
    // as of the op it runs in: what that op's stamp has no field for keeps what is stored
    const write = async (name, verb, row) => {
      ctx.touched?.push(name)
      const value = spec.dispatch.encode(`@${ns}/${verb}-${verbOf(name)}`, row)
      return router.dispatch(await decode(value, ctx.stamp, ctx.view), { ...ctx, nested: true })
    }
    return {
      get: (ref, query) => read(ctx.view, refName(ref), query),
      put: async (ref, row) => {
        const name = refName(ref)
        if (single(name)) return write(name, 'set', held(name, row, stamp(row, null, ctx.ts)))
        const id = row.id ?? (await ctx.mint(ctx.view, col(name)))
        const stored = stamp({ ...row, id }, null, ctx.ts)
        return write(name, 'add', held(name, row, stored))
      },
      // an upsert, as the set operator appends it
      set: async (ref, row) => {
        const name = refName(ref)
        if (!single(name) && !row.id) throw CeroError.INVALID(`set('${name}') needs an id`)
        const verb = single(name) || BESPOKE.has(verbOf(name)) ? 'set' : 'add'
        const was = await current(name, row.id)
        return write(name, verb, held(name, row, stamp({ ...was, ...row }, was?.createdAt, ctx.ts)))
      },
      del: (ref, id) => {
        const name = refName(ref)
        return write(name, 'del', { id: single(name) ? '' : id })
      }
    }
  }

  // the writer as the view stands, null for a core no member owns yet: a join, a claim, genesis
  async function author(ctx) {
    const memberId = await getSignerMember(ctx.view, ctx.key)
    const role = memberId ? ((await getMember(ctx.view, memberId))?.role ?? null) : null
    return role ? { memberId, role } : { memberId: null, role: null }
  }

  // hooks run inside the op's transaction on every peer, so their verdict is part of the op.
  // Resolves to the row that landed, which a before hook may have changed. With a `rule`, a
  // member's removal or change of rank: her rank allows it, as `meta.ranked` says, or a rule on
  // members answers 'grant' (never a bare true, every rule's "no objection"), and a false refuses
  // either. Decided before anything moves, so a refusal leaves her as she was
  async function hooked(fns, meta, ctx, write, rule = null) {
    if (!fns) {
      if (rule && !meta.ranked) throw CeroError.REFUSED(rule)
      await write(meta.row)
      return meta.row
    }
    const writer = await author(ctx)
    const base = { id: null, row: null, existing: null, ...meta }
    const hctx = { ...base, ...writer, ...operators(ctx) }
    const granted = await fire(fns.before, hctx, true)
    // a grant widens rank among the room's writers only: never for a reader, nor for someone who
    // is no member at all, whatever a rule wrote on ctx
    const grant = granted && Boolean(writer.memberId) && can(writer.role, WRITE)
    if (rule && !meta.ranked && !grant) throw CeroError.REFUSED(rule)
    await write(hctx.row)
    // once every row of the op landed: a join's after hooks write as a member
    ctx.later.push(async () => {
      Object.assign(hctx, await author(ctx))
      await fire(fns.after, hctx, false)
    })
    return hctx.row
  }

  // a builtin row lands as a schema ref's does, through its ref's hooks
  async function save(ctx, op, name, row) {
    const fns = pick(op, ctx)
    const existing = fns ? await ctx.view.get(col(name), { id: row.id }) : null
    const meta = { op, name, id: row.id, row, existing }
    return hooked(fns, meta, ctx, (r) => insert(ctx.view, name, r))
  }

  // a seat taken again, as a linked device's own claim does, keeps the chain its link wrote. With
  // it go the device keys of the proof it was `verified` with, which a removal told later is read by
  async function seat(ctx, writer, memberId, ts, key, proof, verified) {
    const id = hid.encode(writer)
    proof ??= (await getDevice(ctx.view, id))?.proof ?? null
    const keys = Identity.chain(verified).slice(1)
    const chain = keys.length ? b4a.concat(keys) : null
    const row = { id, memberId, createdAt: ts, updatedAt: ts, key, proof, chain }
    return save(ctx, 'put', 'devices', row)
  }

  // deleting a row that is not there changes nothing, and fires nothing
  async function drop(ctx, name, id) {
    const fns = pick('del', ctx)
    const existing = fns ? await ctx.view.get(col(name), { id }) : null
    const meta = { op: 'del', name, id, existing }
    await hooked(existing ? fns : null, meta, ctx, () => ctx.view.delete(col(name), { id }))
  }

  // a rule that errors must not diverge peers: a throw refuses exactly like a false verdict.
  // Resolves to whether one granted
  async function fire(fns, hctx, vote) {
    let granted = false
    for (const fn of fns) {
      let verdict
      try {
        verdict = await fn(hctx)
      } catch (err) {
        throw CeroError.REFUSED('hook', err.message)
      }
      if (vote && verdict === false) throw CeroError.REFUSED('hook')
      if (verdict === 'grant') granted = true
    }
    return granted
  }

  // a demoted member keeps its writer seat, so rows are gated by role; a writer with no
  // member row is not a member and writes nothing
  const requireWrite = async (ctx) => {
    if (!can(await getSignerRole(ctx.view, ctx.key), WRITE)) throw CeroError.REFUSED('write')
  }

  // own: the author may change their rows, anyone with REMOVE may moderate the rest
  const requireOwn = async (ctx, existing) => {
    if (existing?.memberId == null) return
    if (existing.memberId === (await getSignerMember(ctx.view, ctx.key))) return
    if (!can(await getSignerRole(ctx.view, ctx.key), REMOVE)) throw CeroError.REFUSED('own')
  }

  const upsert = (name, kind, own) => async (op, ctx) => {
    await requireWrite(ctx)
    op.memberId = await getSignerMember(ctx.view, ctx.key)
    if (kind !== COLLECTION) {
      const fns = pick('set', ctx)
      const existing = fns ? await ctx.view.findOne(col(name), {}) : null
      const meta = { op: 'set', name, row: op, existing }
      return hooked(fns, meta, ctx, (row) => {
        checkFiles(name, row)
        return ctx.view.insert(col(name), row)
      })
    }
    // add on an existing id is an overwrite, same ownership rule as set
    if (own) await requireOwn(ctx, await ctx.view.get(col(name), { id: op.id }))
    await save(ctx, 'put', name, op)
  }
  const update = (name, own) => async (op, ctx) => {
    await requireWrite(ctx)
    const existing = await ctx.view.get(col(name), { id: op.id })
    if (!existing) return
    if (own) await requireOwn(ctx, existing)
    // memberId is attribution: derived here, never merged off the wire
    const memberId = await getSignerMember(ctx.view, ctx.key)
    await save(ctx, 'set', name, { ...existing, ...op, memberId })
  }
  const remove = (name, own) => async (op, ctx) => {
    await requireWrite(ctx)
    const fns = pick('del', ctx)
    const existing = own || fns ? await ctx.view.get(col(name), { id: op.id }) : null
    if (own) await requireOwn(ctx, existing)
    const meta = { op: 'del', name, id: op.id, existing }
    return hooked(fns, meta, ctx, () => ctx.view.delete(col(name), op))
  }
  // only REFUSED aborts a batch: every peer derives it. A body that does not decode skips one node
  const isRefusal = (err) => err?.isCeroError === true && err.code === 'REFUSED'

  // an op's after hooks run once all its rows landed; its ctx writes count on its node's mint
  const add = (verb, fn) =>
    router.add(`@${ns}/${verb}`, async (op, ctx) => {
      const later = []
      await fn(op, { ...ctx, later, mint: ctx.mint ?? minter(ctx.seed) })
      for (const run of later) await run()
    })

  // a device seats only itself: the row's device key is the one its own proof ends at, and a
  // rotation seals to it
  add('add-writer', async (op, ctx) => {
    if (!isKey(op.master) || !isKey(op.writer) || !ctx.key) return
    if (!b4a.equals(op.writer, ctx.key)) return
    const signed = Identity.verify(op.proof, admission(ctx.dbKey, op.writer, ctx.key), op.master)
    if (!signed) return
    if (!(await stands(ctx.view, Identity.chain(op.proof)))) throw CeroError.REFUSED('removed')
    const { genesis } = ctx.host
    const memberId = hid.encode(op.master)
    const ts = op.ts || 0
    const known = await getMember(ctx.view, memberId)
    const made = genesis ? [] : await promised(ctx.view, op.master)
    // a member stands on what this device was promised, or every device she links would take a
    // row on one promise; who is no member yet, on any made to her
    const mine = made.find((row) => b4a.equals(row.key, signed.device))
    const owed = known ? mine : made[0]
    if (!genesis && !can(known?.role, INVITE) && !owed) throw CeroError.REFUSED('invite')
    // only a device of the signer's own identity: another member's device seats itself through
    // its join, or any key the signer holds would act as them.
    // Always an indexer: autobee gc's caught-up non-indexer sessions and they miss later appends
    if (op.memberId && op.memberId !== memberId) throw CeroError.REFUSED('member')
    if (await boundElsewhere(ctx.view, op.writer, memberId)) throw CeroError.REFUSED('member')
    // a promise kept: the member it was made to, at the role of the first one made. One made to
    // a member is kept at the role she holds
    const role = known ? known.role : made[0]?.role
    if (role && !known) {
      const member = { id: memberId, key: op.writer, role, createdAt: ts, updatedAt: ts }
      await save(ctx, 'put', 'members', member)
    }
    if (genesis || can(role, WRITE)) await ctx.host.addWriter(op.writer, { isIndexer: true })
    // a linked device's seat keeps the chain its promise carries. The promises stay: a member
    // who may invite settles one once it sees it kept
    await seat(ctx, op.writer, memberId, ts, signed.device, linkOf(mine?.proof), op.proof)
  })

  // a device goes with its seat and its key: by its own member, or one who may remove her
  async function unseat(ctx, id, device) {
    const by = await getSignerMember(ctx.view, ctx.key)
    if (device?.memberId !== by) {
      if (!(await canRemoveMember(ctx.view, ctx.key, device?.memberId))) {
        throw CeroError.REFUSED('remove')
      }
    }
    const may = can(await getSignerRole(ctx.view, ctx.key), REMOVE)
    await ctx.host.removeWriter(hid.decode(id))
    await revoke(ctx, device, by, may)
    await drop(ctx, 'devices', id)
    await ctx.view.delete(asks, { id })
    if (device) await owe(ctx.view)
    // with the seat go the keys its writer was still owed, and what its device key was promised:
    // a rotation is sealed to the promised
    const own = await ctx.view.get(requests, { id })
    await (device ? forget(ctx, own) : withdraw(ctx, own))
    const stood = (row) => chainOf(row).some((key) => b4a.equals(key, device.key))
    for (const row of device?.key ? await ctx.view.find(requests, {}).toArray() : []) {
      // waiting or promised: one admitted at its join has a seat of its own to lose
      if (row.admitted && !row.promised) continue
      if (stood(row)) await withdraw(ctx, row)
    }
    if (device && may) await shut(ctx)
  }
  // a removal by someone who may remove spends the invites that let in on their own: one the
  // removed held, or saw, brings nobody in after it. Those that wait for an accept stay. A promise
  // no device claimed goes too, its invite used up or not, unless a member accepted it
  async function shut(ctx) {
    for (const invite of await ctx.view.find(invites, {}).toArray()) {
      if (invite.secret && !invite.confirm) await spend(ctx, invite, 'removed')
    }
    for (const row of await ctx.view.find(requests, {}).toArray()) {
      if (!row.promised || row.accepted || (await ctx.view.get(invites, { id: row.invite }))) {
        continue
      }
      if ((await ctx.view.get(spent, { id: row.invite }))?.confirm) continue
      if (!(await sat(ctx.view, row))) await withdraw(ctx, row)
    }
  }
  // a request goes: a promise among them was handed the keys, so a rotation is owed
  async function forget(ctx, row) {
    if (!row) return
    await drop(ctx, 'requests', row.id)
    if (row.promised) await owe(ctx.view)
  }
  // a promise goes with the member or device it stood on: one no device claimed hears why, so
  // its claim ends
  async function withdraw(ctx, row) {
    if (!row?.promised || (await sat(ctx.view, row))) return forget(ctx, row)
    await forget(ctx, row)
    await refuse(ctx, row, 'removed')
  }
  add('del-writer', async (op, ctx) => {
    if (!isKey(op.writer)) return
    const id = hid.encode(op.writer)
    await unseat(ctx, id, await getDevice(ctx.view, id))
  })

  // a removed device's key, and any device it attests after, stays out: its chain is static, so
  // the removal is kept here, beside the members', with whether it spent the open invites
  async function revoke(ctx, device, by, spent) {
    if (!device?.key) return
    const minted = (await ctx.view.get(countersCol, { name: 'invites' }))?.value ?? 0
    await ctx.view.insert(removals, { id: hid.encode(device.key), index: minted, by, spent })
  }
  // a chain, its identity first, stands unless it passes a removed device key. A key its identity
  // removed, told or taken out by a device of hers, is passed by a key after it that stands: in
  // the root one seated, in a room one she told stands; one another member removed, or whose
  // record says not who, cuts whatever she told. With `telling`, as it will once she tells those
  // lists too
  async function stands(view, [identity, ...keys], telling) {
    const memberId = hid.encode(identity)
    const told = await view.get(removals, { id: toldId(memberId) })
    const removed = [...keysOf(told?.removed), ...keysOf(telling?.removed)]
    let cut = -1
    for (const [i, key] of keys.entries()) {
      const removal = await view.get(removals, { id: hid.encode(key) })
      if (removal && removal.by !== memberId) return false
      if (removal || has(removed, key)) cut = i
    }
    if (cut < 0) return true
    const standing = root
      ? (await view.find(`@${ns}/devices`, {}).toArray())
          .filter((d) => d.memberId === memberId && d.key)
          .map((d) => d.key)
      : keysOf(telling ? telling.standing : told?.standing)
    return keys.slice(cut + 1).some((key) => has(standing, key))
  }

  // a device tells the room which device keys of its identity are removed and which stand. For
  // its identity alone: the removed add up, the standing replace those told before, and the seats
  // of the identity whose chain no longer stands go, with the joins that wait or were promised
  // through one. Told by someone who may remove, a key no removal that spent the open invites
  // covers is a removal by her
  add('revoke', async (op, ctx) => {
    const device = ctx.key ? await getDevice(ctx.view, hid.encode(ctx.key)) : null
    if (!device?.memberId || !device.key) throw CeroError.REFUSED('device')
    if (!(await stands(ctx.view, seatChain(device)))) throw CeroError.REFUSED('removed')
    const { memberId } = device
    const id = toldId(memberId)
    const told = await ctx.view.get(removals, { id })
    const before = keysOf(told?.removed)
    const added = keysOf(op.removed).filter((key) => !has(before, key))
    const removed = [...before, ...added]
    let uncovered = false
    for (const key of told?.spent ? added : removed) {
      if (!(await ctx.view.get(removals, { id: hid.encode(key) }))?.spent) uncovered = true
    }
    const spends = uncovered && can(await getSignerRole(ctx.view, ctx.key), REMOVE)
    const standing = b4a.concat(keysOf(op.standing))
    const spent = spends || !uncovered
    const row = { id, index: 0, by: memberId, removed: b4a.concat(removed), standing, spent }
    await ctx.view.insert(removals, row)
    // a removed device that never sat here may hold the key through its identity's root
    if (added.length) await owe(ctx.view)
    for (const seated of await ctx.view.find(`@${ns}/devices`, {}).toArray()) {
      if (seated.memberId !== memberId || !seated.key) continue
      if (await stands(ctx.view, seatChain(seated))) continue
      await ctx.host.removeWriter(hid.decode(seated.id))
      await drop(ctx, 'devices', seated.id)
      await ctx.view.delete(asks, { id: seated.id })
      await owe(ctx.view)
      await forget(ctx, await ctx.view.get(requests, { id: seated.id }))
    }
    for (const row of await ctx.view.find(requests, {}).toArray()) {
      // waiting or promised: one admitted at its join has a seat of its own to lose
      if (row.admitted && !row.promised) continue
      if (!(await stands(ctx.view, [row.identity, ...chainOf(row)]))) await withdraw(ctx, row)
    }
    if (spends) await shut(ctx)
  })

  // the genesis batch names the creator; everyone after comes in through a signed join
  add('add-member', async (op, ctx) => {
    if (!isKey(op.key)) return
    // an existing member keeps its row: its rank changes only through set-member
    if (await getMember(ctx.view, op.id)) return
    if (!ctx.host.genesis) throw CeroError.REFUSED('member')
    // every member id is an identity key: rotation seals to it
    if (!isIdentity(op.id)) throw CeroError.REFUSED('member')
    await save(ctx, 'put', 'members', op)
  })

  add('set-member', async (op, ctx) => {
    const existing = await getMember(ctx.view, op.id)
    if (!existing) return
    // whose row it is decides what may change: your own is writable, another member's only
    // for an authorised role change. Key and provenance never come off the wire
    const isSelf = op.id === (await getSignerMember(ctx.view, ctx.key))
    const ranks = Boolean(op.role) && op.role !== existing.role
    if (!isSelf && !ranks) return
    const next = !isSelf
      ? { ...existing }
      : can(existing.role, WRITE)
        ? { ...op }
        : profile(existing, op)
    next.key = existing.key
    next.role = existing.role
    next.createdAt = existing.createdAt
    next.updatedAt = op.updatedAt || existing.updatedAt

    let row
    if (ranks) {
      // a rank cero has no name for is no rank, granted or not
      if (!isRank(op.role)) throw CeroError.INVALID(`'${op.role}' is not a role`)
      // the last owner keeps her rank, whatever a rule grants, as she is never removed
      if (existing.role === OWNER && (await orphans(ctx.view, op.id))) {
        throw CeroError.INVALID(
          'the last owner cannot be demoted: make another member an owner first'
        )
      }
      const r = await getSignerRole(ctx.view, ctx.key)
      next.role = op.role
      const ranked = can(r, ASSIGN) && grants(r, op.role) && outranks(r, existing.role)
      const meta = { op: 'set', name: 'members', id: op.id, row: next, existing, ranked }
      const write = (member) => insert(ctx.view, 'members', member)
      row = await hooked(pick('set', ctx), meta, ctx, write, 'assign')
    } else {
      row = await save(ctx, 'set', 'members', next)
    }
    // WRITE decides the writer seats: a demotion takes them, a promotion gives them back.
    // Device rows stay: an unresolvable writer would read as not yet enrolled and pass the gate
    const writes = can(row.role, WRITE)
    if (can(existing.role, WRITE) === writes) return
    const devices = await ctx.view.find(`@${ns}/devices`, {}).toArray()
    const seats = devices.filter((d) => d.memberId === row.id).map((d) => hid.decode(d.id))
    // only enrolled devices come back: a revoked writer has no device row
    if (writes) for (const key of seats) await ctx.host.addWriter(key, { isIndexer: true })
    else for (const key of row.key ? [row.key, ...seats] : seats) await ctx.host.removeWriter(key)
  })

  add('del-member', async (op, ctx) => {
    const existing = await getMember(ctx.view, op.id)
    if (!existing) {
      // taken out after she left: leaving first dodges nothing
      const left = await ctx.view.get(removals, { id: leftId(op.id) })
      if (left && can(await getSignerRole(ctx.view, ctx.key), REMOVE)) await shut(ctx)
      return
    }
    // leaving is hers: only someone else taking her out turns her older codes away
    const by = await getSignerMember(ctx.view, ctx.key)
    const leaving = op.id === by
    // every device of the member goes with them, and any keys they were still owed
    const vacate = async () => {
      if (existing.key) await ctx.host.removeWriter(existing.key)
      for (const device of await ctx.view.find(`@${ns}/devices`, {}).toArray()) {
        if (device.memberId !== op.id) continue
        await ctx.host.removeWriter(hid.decode(device.id))
        await drop(ctx, 'devices', device.id)
        await ctx.view.delete(asks, { id: device.id })
        await owe(ctx.view)
        await drop(ctx, 'requests', device.id)
      }
      for (const row of await promised(ctx.view, hid.decode(op.id))) await withdraw(ctx, row)
    }
    if (leaving) {
      if (existing.role === OWNER && (await orphans(ctx.view, op.id))) {
        throw CeroError.INVALID('the last owner cannot leave: make another member an owner first')
      }
      await vacate()
      await drop(ctx, 'members', op.id)
    } else {
      // the last owner stays, whatever a rule grants: without her nobody outranks the rest
      if (existing.role === OWNER && (await orphans(ctx.view, op.id))) {
        throw CeroError.INVALID(
          'the last owner cannot be removed: make another member an owner first'
        )
      }
      const r = await getSignerRole(ctx.view, ctx.key)
      const ranked = can(r, REMOVE) && outranks(r, existing.role)
      const meta = { op: 'del', name: 'members', id: op.id, existing, ranked }
      const write = async () => {
        await vacate()
        await ctx.view.delete(col('members'), { id: op.id })
      }
      await hooked(pick('del', ctx), meta, ctx, write, 'remove')
    }
    // an invite they could hold, or saw, does not bring them back on its own: after a removal it is turned away, after
    // leaving it waits for a member to accept her again, so leaving first never dodges a removal
    const minted = (await ctx.view.get(countersCol, { name: 'invites' }))?.value ?? 0
    await ctx.view.insert(removals, { id: leaving ? leftId(op.id) : op.id, index: minted, by })
    if (!leaving) await shut(ctx)
  })

  add('rotate-key', async (op, ctx) => {
    if (!op.wrapped?.byteLength) return
    // the commitment lets every member verify the sealed secret, so a rotator cannot split the database
    if (op.commit?.byteLength !== 32) return
    // the stamp is picked before any block is written, so epochs reorder freely; uniqueness is enforced here
    if (!Number.isInteger(op.stamp) || op.stamp <= 0 || op.stamp > 0xffffffff) return
    // envelopes that do not decode would stop every later audit
    if (!sealed(op.wrapped)) return
    const role = await getSignerRole(ctx.view, ctx.key)
    const aside = !can(role, REMOVE)
    // a reorder can take her rank after she wrote under her key: kept, what she wrote reads
    if (aside && !(can(role, WRITE) && (await asides(ctx.view)))) {
      throw CeroError.REFUSED('rotate', 'rotate requires the remove permission')
    }
    const rows = await ctx.view.find(`@${ns}/${EPOCHS}`, {}).toArray()
    const taken = rows.find((r) => r.stamp === op.stamp)
    // one key per stamp: a counted rotation always lands, and takes it from one set aside
    if (taken && (aside || !taken.aside)) return
    if (taken) await ctx.view.delete(`@${ns}/${EPOCHS}`, { epoch: taken.epoch })
    // sequence numbers order epochs; concurrent rotations get consecutive sequences, both readable
    const epoch = await bump(ctx.view, EPOCHS)
    const row = {
      epoch,
      stamp: op.stamp,
      wrapped: op.wrapped,
      createdAt: op.createdAt || 0,
      commit: op.commit,
      aside
    }
    await ctx.view.insert(`@${ns}/${EPOCHS}`, row)
    // sealed before a removal it crossed, it names a device taken out since: one more is owed
    if (!aside) await owe(ctx.view, (await outsider(ctx.view, op.wrapped)) ? 1 : 0)
    ctx.touched?.push(EPOCHS)
    // learned once its batch commits: a refused batch teaches no epoch, and a dry run commits nothing
    ctx.epochs?.push(row)
  })

  const asides = async (view) => since?.types[`@${ns}/epoch`]?.aside <= (await versionOf(view))

  // whether a rotation names a device with no seat and no promise where it lands. A promise row
  // is one that stands: a removal takes those on its key, and past its invite a member withdraws it
  async function outsider(view, wrapped) {
    for (const { id } of c.decode(wraps, wrapped)) {
      if (await getDevice(view, id)) continue
      if (!(await view.get(requests, { id }))?.promised) return true
    }
    return false
  }

  // only an owner moves the version, and only up: a lower one is no change and no error. The
  // genesis batch raises first, before the member row it writes, so all of it runs at the version
  add('upgrade', async (op, ctx) => {
    const owner = ctx.host.genesis || (await getSignerRole(ctx.view, ctx.key)) === OWNER
    if (!owner) throw CeroError.REFUSED('upgrade')
    if (op.version <= (await versionOf(ctx.view))) return
    await ctx.view.insert(countersCol, { name: VERSION, value: op.version })
  })

  add('del-device', async (op, ctx) => {
    const device = await getDevice(ctx.view, op.id)
    if (device) await unseat(ctx, op.id, device)
  })

  // a device row is the writer→role mapping, so memberId never comes off the wire; a core no
  // member owns writes none, or any stranger's optimistic node would plant a device in the database
  const bind = async (ctx) => {
    const { memberId } = await author(ctx)
    if (!memberId) throw CeroError.REFUSED('member')
    return memberId
  }
  // a device describes only itself: another's record, or a made-up id, would break removing it
  const selfOnly = (op, ctx) => {
    if (!ctx.key || op.id !== hid.encode(ctx.key)) throw CeroError.REFUSED('device')
  }
  // the device key and the chain stay what the admission proved, never what the row says
  add('add-device', async (op, ctx) => {
    selfOnly(op, ctx)
    const existing = await getDevice(ctx.view, op.id)
    const kept = { key: existing?.key, chain: existing?.chain }
    await save(ctx, 'put', 'devices', { ...op, memberId: await bind(ctx), ...kept })
  })
  // another device of its member renames it while it stands, and changes nothing else of the row
  add('set-device', async (op, ctx) => {
    const existing = await getDevice(ctx.view, op.id)
    const ts = op.updatedAt || 0
    if (ctx.key && existing && op.id !== hid.encode(ctx.key)) {
      const by = await getDevice(ctx.view, hid.encode(ctx.key))
      if (!by?.memberId || by.memberId !== existing.memberId) throw CeroError.REFUSED('device')
      if (existing.key && !(await stands(ctx.view, seatChain(existing)))) {
        throw CeroError.REFUSED('removed')
      }
      await save(ctx, 'set', 'devices', { ...existing, name: op.name, updatedAt: ts })
      return
    }
    selfOnly(op, ctx)
    const memberId = await bind(ctx)
    await save(ctx, 'set', 'devices', {
      ...op,
      memberId,
      key: existing?.key,
      chain: existing?.chain,
      createdAt: existing?.createdAt || op.createdAt || ts,
      updatedAt: ts
    })
  })

  // a device of a member who stands asks for the keys it lacks, from its own core whether it
  // writes or only reads: one row, at the address it asked with last, that only its own op closes
  add('ask-key', async (op, ctx) => {
    selfOnly(op, ctx)
    if (!isKey(op.reply)) return
    await bind(ctx)
    ctx.touched?.push(ASKS)
    await ctx.view.insert(asks, { id: op.id, reply: op.reply })
  })
  add('del-owed', async (op, ctx) => {
    selfOnly(op, ctx)
    ctx.touched?.push(ASKS)
    await ctx.view.delete(asks, op)
  })

  // any WRITE member mints an invite, its rank capped at admission; an existing row is never
  // overwritten, and altering or revoking one needs REMOVE
  const invites = `@${ns}/invites`
  const requests = `@${ns}/requests`
  // an invite grants at most its minter's rank, or the join it admits would grant more
  const capped = (r, record) => grants(r, record.role)
  add('add-invite', async (op, ctx) => {
    await requireWrite(ctx)
    if (await ctx.view.get(invites, { id: op.id })) throw CeroError.REFUSED('invite')
    if (!capped(await getSignerRole(ctx.view, ctx.key), op)) throw CeroError.REFUSED('invite')
    await save(ctx, 'put', 'invites', op)
  })
  add('set-invite', async (op, ctx) => {
    const r = await getSignerRole(ctx.view, ctx.key)
    const existing = await ctx.view.get(invites, { id: op.id })
    if (!existing) return
    const next = { ...existing, ...op }
    if (!can(r, REMOVE) || !capped(r, next)) throw CeroError.REFUSED('invite')
    await save(ctx, 'set', 'invites', next)
  })
  // a live invite is revoked; a spent one, deleted again, is forgotten
  add('del-invite', async (op, ctx) => {
    const r = await getSignerRole(ctx.view, ctx.key)
    const existing = await ctx.view.get(invites, { id: op.id })
    if (existing) {
      if (!can(r, REMOVE) || !capped(r, existing)) throw CeroError.REFUSED('invite')
      return spend(ctx, existing, 'revoked')
    }
    if (!(await ctx.view.get(spent, { id: op.id }))) return
    if (!can(r, REMOVE)) throw CeroError.REFUSED('invite')
    await ctx.view.delete(spent, { id: op.id })
  })
  // its joins still waiting for a member are turned away with it, and the promises made under it
  // withdrawn, unless it was used up by the join it let in; admitted ones are still owed their
  // keys. Its id stays, and its secret, so a later join with it is opened and hears why
  async function spend(ctx, invite, reason) {
    const expires = invite.expires || 0
    await drop(ctx, 'invites', invite.id)
    const { secret, confirm } = invite
    await ctx.view.insert(spent, { id: invite.id, reason, expires, secret, confirm })
    const kept = async (request) => {
      if (!request.admitted) return false
      if (!request.promised || reason === 'spent') return true
      // a removal withdraws what no device claimed: a promise kept waits for a member to settle it
      return reason === 'removed' && (request.accepted || sat(ctx.view, request))
    }
    for (const request of await ctx.view.find(requests, {}).toArray()) {
      if (request.invite !== invite.id || (await kept(request))) continue
      await forget(ctx, request)
      await refuse(ctx, request, reason)
    }
  }

  // a join turned away is answered at its reply address, under its invite. A writer with a request
  // hears through that: one of the two per writer, or a denial could race its keys. A spent
  // invite keeps the answer to its newest join alone, and a live one the newest to each identity
  // it turns away as removed, so nobody holding one fills the log
  async function refuse(
    ctx,
    { id, reply, expires, invite, identity = null },
    reason,
    last = false
  ) {
    if (await ctx.view.get(requests, { id })) return
    const rows = last ? await ctx.view.find(refusals, {}).toArray() : []
    const same = (row) =>
      identity ? row.identity && b4a.equals(row.identity, identity) : row.spent
    for (const row of rows) {
      if (row.invite === invite && same(row)) await ctx.view.delete(refusals, { id: row.id })
    }
    const row = { id, reply, reason, expires, invite, spent: last && !identity, identity }
    await ctx.view.insert(refusals, row)
  }
  // from the version that has an invite's secret, whatever stamp a join carries
  const bounded = async (view) => since?.types[`@${ns}/invite`]?.secret <= (await versionOf(view))
  // from the version whose requests say a member accepted them
  const marked = async (view) => since?.types[`@${ns}/request`]?.accepted <= (await versionOf(view))
  // from the version whose refusals record who joined
  const recorded = async (view) =>
    since?.types[`@${ns}/refusal`]?.identity <= (await versionOf(view))

  // the member, when new, and its device, seated when the member writes; its request stays until
  // a member delivered the keys. The invite is spent unless it is reusable
  async function admit(ctx, { invite, identity, key, writer, reply, role, ts, proof }) {
    const memberId = hid.encode(identity)
    if (await boundElsewhere(ctx.view, writer, memberId)) throw CeroError.REFUSED('member')
    if (invite.secret) {
      return promise(ctx, { invite, identity, key, writer, reply, role, ts, proof })
    }
    const member =
      (await getMember(ctx.view, memberId)) ??
      (await save(ctx, 'put', 'members', {
        id: memberId,
        key: writer,
        role,
        createdAt: ts,
        updatedAt: ts
      }))
    if (can(member.role, WRITE)) await ctx.host.addWriter(writer, { isIndexer: true })
    await seat(ctx, writer, memberId, ts, key, null, proof)
    await save(ctx, 'put', 'requests', {
      ...request(invite, identity, key, writer, reply, ts),
      role,
      admitted: true
    })
    if (!invite.reuse) await spend(ctx, invite, 'spent')
  }

  // a device of a member, linked by one of its devices: no member row, a seat under theirs with
  // the chain the linking device wrote
  async function admitDevice(ctx, { invite, memberId, key, proof, writer, reply, ts }) {
    if (await boundElsewhere(ctx.view, writer, memberId)) throw CeroError.REFUSED('member')
    const member = await getMember(ctx.view, memberId)
    if (invite.secret) {
      const identity = hid.decode(memberId)
      const { role } = member
      return promise(ctx, { invite, identity, key, writer, reply, role, ts, proof })
    }
    if (can(member.role, WRITE)) await ctx.host.addWriter(writer, { isIndexer: true })
    await seat(ctx, writer, memberId, ts, key, proof, proof)
    await save(ctx, 'put', 'requests', {
      ...request(invite, hid.decode(memberId), key, writer, reply, ts),
      role: member.role,
      admitted: true
    })
    if (!invite.reuse) await spend(ctx, invite, 'spent')
  }

  // let in through an invite with an address of its own: admitted, with no member and no seat
  // until a device of the identity, holding the keys, seats itself. With a link's chain for its
  // proof, that one device
  async function promise(ctx, { invite, identity, key, writer, reply, role, ts, proof }) {
    // only an accept hands a promise an invite that waits
    const accepted = !!invite.confirm && (await marked(ctx.view))
    await save(ctx, 'put', 'requests', {
      ...request(invite, identity, key, writer, reply, ts),
      role,
      admitted: true,
      promised: true,
      proof,
      ...(accepted && { accepted })
    })
    if (!invite.reuse) await spend(ctx, invite, 'spent')
  }

  // what an identity was promised, the first made first
  async function promised(view, identity) {
    const rows = await view.find(requests, {}).toArray()
    return rows
      .filter((row) => row.promised && b4a.equals(row.identity, identity))
      .sort((a, b) => a.index - b.index)
  }

  function request(invite, identity, key, writer, reply, ts) {
    const expires = invite.expires || 0
    const id = hid.encode(writer)
    const { role } = invite
    return { id, identity, key, invite: invite.id, role, reply, expires, createdAt: ts }
  }

  // null when it does not open: anyone may append a join. One that names its invite is sealed to
  // that invite's own address, and only its row, live or spent, has the secret; the name in the
  // clear is the one in the box
  async function open(view, { box, invite }) {
    const pair = invite ? await pairOf(view, b4a.toHex(invite)) : room()
    if (!pair || !box?.byteLength) return null
    try {
      const plain = crypto.decrypt(box, pair)
      const join = plain && c.decode(Join, plain)
      if (join && invite && !b4a.equals(join.invite, invite)) return null
      return join
    } catch {
      return null
    }
  }
  async function pairOf(view, id) {
    const row = (await view.get(invites, { id })) ?? (await view.get(spent, { id }))
    return row?.secret ? keyPair(row.secret) : null
  }

  // the joiner's own core asks in: the invite proves it may, its device signs where the keys go
  // and the proof's chain says whose device it is
  add('join', async (op, ctx) => {
    const join = await open(ctx.view, op)
    if (!join || !ctx.key) return
    if (!Invite.proven(join.invite, ctx.key, join.signature)) return
    const signed = Identity.verify(join.proof, joining(ctx.dbKey, join.invite, ctx.key, join.reply))
    if (!signed) return
    join.identity = signed.identity
    const id = hid.encode(ctx.key)
    const invite = await ctx.view.get(invites, { id: b4a.toHex(join.invite) })
    const record = invite ?? (await ctx.view.get(spent, { id: b4a.toHex(join.invite) }))
    // an invite with an address of its own is joined by name only
    if (record?.secret && !op.invite) return
    if (!invite) {
      // an invite the database never held could be anyone's: nobody answers it
      if (!record) return
      const turned = { id, reply: join.reply, expires: record.expires, invite: record.id }
      return refuse(ctx, turned, record.reason, await bounded(ctx.view))
    }
    const ts = join.ts || 0
    const memberId = hid.encode(join.identity)
    const known = await getMember(ctx.view, memberId)
    const removal = known ? null : await ctx.view.get(removals, { id: memberId })
    const out =
      (removal && (invite.index ?? 0) <= removal.index) ||
      !(await stands(ctx.view, Identity.chain(join.proof)))
    if (out) {
      const turned = { id, reply: join.reply, expires: invite.expires || 0, invite: invite.id }
      const last = await recorded(ctx.view)
      return refuse(ctx, { ...turned, identity: last ? join.identity : null }, 'removed', last)
    }
    await ctx.view.delete(refusals, { id })
    const gone = known ? null : await ctx.view.get(removals, { id: leftId(memberId) })
    const older = gone && (invite.index ?? 0) <= gone.index
    if ((invite.confirm || older) && !known) {
      const waiting = request(invite, join.identity, signed.device, ctx.key, join.reply, ts)
      // a promise it writes over was handed the keys
      if ((await ctx.view.get(requests, { id }))?.promised) await owe(ctx.view)
      return save(ctx, 'put', 'requests', { ...waiting, proof: join.proof })
    }
    await admit(ctx, {
      invite,
      identity: join.identity,
      key: signed.device,
      writer: ctx.key,
      reply: join.reply,
      role: invite.role,
      ts,
      proof: join.proof
    })
  })
  // a waiting join, admitted at a role within the invite's and the accepter's; with a proof, as a
  // device of the accepter's own identity, which its device attested
  add('accept', async (op, ctx) => {
    const waiting = await ctx.view.get(requests, { id: op.id })
    if (!waiting || waiting.admitted) return
    const live = await ctx.view.get(invites, { id: waiting.invite })
    // spent by this, it says a member let the join in, whatever it asked for itself
    const invite = live && (await marked(ctx.view)) ? { ...live, confirm: true } : live
    const r = await getSignerRole(ctx.view, ctx.key)
    const role = op.role || invite?.role
    if (!invite || !can(r, INVITE) || !grants(r, role) || !grants(invite.role, role)) {
      throw CeroError.REFUSED('invite')
    }
    const { identity, key, reply, proof, createdAt: ts = 0 } = waiting
    // a key removed since the join was made lets nobody in
    if (!(await stands(ctx.view, [identity, ...chainOf(waiting)]))) {
      throw CeroError.REFUSED('removed')
    }
    const writer = hid.decode(op.id)
    if (op.proof) {
      const memberId = await getSignerMember(ctx.view, ctx.key)
      const linked = Identity.verify(op.proof, null, hid.decode(memberId))
      if (!linked || !b4a.equals(linked.device, key)) throw CeroError.REFUSED('device')
      if (!(await stands(ctx.view, Identity.chain(op.proof)))) throw CeroError.REFUSED('removed')
      return admitDevice(ctx, { invite, memberId, key, proof: op.proof, writer, reply, ts })
    }
    await admit(ctx, { invite, identity, key, writer, reply, role, ts, proof })
  })
  // a waiting join is turned away by one who may invite; a promise is withdrawn by one who may
  // remove, since its joiner may hold the keys. Answered through the log like every refusal
  add('deny', async (op, ctx) => {
    const row = await ctx.view.get(requests, { id: op.id })
    if (!row || (row.admitted && !row.promised)) return
    const [perm, rule] = row.promised ? [REMOVE, 'remove'] : [INVITE, 'invite']
    if (!can(await getSignerRole(ctx.view, ctx.key), perm)) throw CeroError.REFUSED(rule)
    // a promise its device claimed is settled: nobody is turned away and no keys are owed
    if (row.promised && (await sat(ctx.view, row))) return drop(ctx, 'requests', row.id)
    await forget(ctx, row)
    await refuse(ctx, row, op.reason || '')
  })
  // the joiner's own core takes back its join while it waits: an accept that landed first stands
  add('cancel-join', async (op, ctx) => {
    selfOnly(op, ctx)
    const row = await ctx.view.get(requests, { id: op.id })
    if (row && !row.admitted) await drop(ctx, 'requests', row.id)
  })
  // only a join writes a request
  const joinsOnly = async () => {
    throw CeroError.REFUSED('request')
  }
  add('add-request', joinsOnly)
  add('set-request', joinsOnly)
  // a denial, or keys delivered. A promise dropped before the device it was made to sat under its
  // member is one withdrawn: its joiner may hold the keys, so it takes the right to remove, unless
  // a key of its chain was removed since
  add('del-request', async (op, ctx) => {
    const r = await getSignerRole(ctx.view, ctx.key)
    if (!can(r, INVITE)) throw CeroError.REFUSED('invite')
    const row = await ctx.view.get(requests, { id: op.id })
    if (!row) return
    const open = row.promised && !(await sat(ctx.view, row))
    const cut = open && !(await stands(ctx.view, [row.identity, ...chainOf(row)]))
    if (open && !can(r, REMOVE) && !cut) throw CeroError.REFUSED('remove')
    await drop(ctx, 'requests', op.id)
    if (open) await owe(ctx.view)
  })
  async function sat(view, { identity, key }) {
    const memberId = hid.encode(identity)
    const devices = await view.find(`@${ns}/devices`, {}).toArray()
    return devices.some((d) => d.memberId === memberId && d.key && b4a.equals(d.key, key))
  }
  // read by the joiner, or past its expiry with nobody waiting
  add('del-refusal', async (op, ctx) => {
    if (!can(await getSignerRole(ctx.view, ctx.key), INVITE)) throw CeroError.REFUSED('invite')
    await ctx.view.delete(refusals, { id: op.id })
  })

  add('add-file', async (op, ctx) => {
    await requireWrite(ctx)
    await requireOwn(ctx, await ctx.view.get(col('files'), { id: op.id }))
    const memberId = await getSignerMember(ctx.view, ctx.key)
    await save(ctx, 'put', 'files', {
      id: op.id,
      name: op.name ?? null,
      memberId,
      stamp: op.stamp ?? 0,
      from: op.from ?? null
    })
  })
  add('set-file', update('files', true))
  add('del-file', remove('files', true))

  // held to its states on every peer, so a device with an older picture writes over no newer one
  const held = (write) => async (op, ctx) => {
    const was = await ctx.view.get(col('handles'), { id: op.id })
    // a write naming no state keeps the row's, `in` on a new row: its device may read an older one
    if (!op.state) {
      if (was) Object.assign(op, { reason: was.reason, by: was.by, invite: was.invite })
      op.state = was?.state || 'in'
    }
    if (!moves(was, op)) throw CeroError.REFUSED('state')
    return write(op, ctx)
  }
  add('add-handle', held(upsert('handles', COLLECTION, false)))
  add('set-handle', held(update('handles', false)))
  add('del-handle', async (op, ctx) => {
    const was = await ctx.view.get(col('handles'), { id: op.id })
    if (UNSETTLED.has(was?.state)) throw CeroError.REFUSED('state')
    return remove('handles', false)(op, ctx)
  })

  for (const [name, info] of Object.entries(spec.meta?.refs || {})) {
    if (info.internal) continue
    if (info.kind === 'handle') continue
    if (info.kind === ACTION) {
      // an action does what its after hooks do; one with none here diverges this peer from those
      // that ran them, so it surfaces
      add(name, async (op, ctx) => {
        const fns = pick(name, ctx)
        if (!fns?.after.length) return onerror(CeroError.UNKNOWN('action hook', name))
        // an action is a write: a core no member owns, or a reader's optimistic op, runs none
        await requireWrite(ctx)
        await hooked(fns, { op: name, name, row: op }, ctx, () => {})
      })
      continue
    }
    if (info.kind === SINGLE) {
      add(`set-${name}`, upsert(name, SINGLE, false))
      // wipe the keyless single row (the dummy id in the op is ignored)
      add(`del-${name}`, async (op, ctx) => {
        await requireWrite(ctx)
        const fns = pick('del', ctx)
        const existing = fns ? await ctx.view.findOne(col(name), {}) : null
        return hooked(fns, { op: 'del', name, existing }, ctx, () => ctx.view.delete(col(name), {}))
      })
      continue
    }
    add(`set-${name}`, update(name, info.own))
    add(`add-${name}`, upsert(name, COLLECTION, info.own))
    add(`del-${name}`, remove(name, info.own))
  }

  return {
    encode,
    cut,
    dispatch: async (value, ctx) => router.dispatch(await decode(value, ctx.stamp, ctx.view), ctx),
    role: getSignerRole,
    stands,
    version: versionOf,
    built,
    async apply(nodes, view, host) {
      const dbKey = key()
      const before = await built(view)
      // a batch is one writer's contiguous run, so a refusal discards only that writer's ops
      const tx = view.transaction()
      // host calls survive a discarded transaction, so they replay once the batch commits
      const calls = []
      const deferred = Object.create(host)
      deferred.addWriter = (...args) => void calls.push(['addWriter', args])
      deferred.removeWriter = (...args) => void calls.push(['removeWriter', args])
      const epochs = []
      // refs hooks wrote, marked once their batch commits: a discarded batch, or a dry run, wakes nobody
      const touched = []
      let refusal = null
      let changed = false
      const landed = []
      for (const node of nodes) {
        // the version as it stands at this node, an upgrade earlier in the batch included
        const stamp = Math.min(node.version, await versionOf(tx))
        // replayed once this build reaches it
        if (stamp > contract()) {
          onskip(stamp)
          continue
        }
        try {
          const seed = crypto.hash([node.key, c.encode(c.uint, node.length), node.value])
          // never a clock: the node's time is the same on every peer
          await router.dispatch(await decode(node.value, stamp, tx), {
            view: tx,
            host: deferred,
            key: node.key,
            dbKey,
            seed,
            ts: node.timestamp,
            stamp,
            epochs,
            touched
          })
          landed.push(node)
        } catch (err) {
          // anything but a refusal skips one node, so an older peer never drops a batch its newer neighbour applies
          if (!isRefusal(err)) {
            onerror(err)
            continue
          }
          refusal = err
          break
        }
      }
      if (refusal) {
        await tx.close()
        onerror(refusal)
      } else {
        changed = tx.updated()
        // a view another build applied keeps its row until this device applies the log again; what
        // it skipped follows this device, since a reorder takes it back in the view alone
        const own = build()
        const ours = !before || before.slice(0, 3).every((n, i) => n === own[i])
        for (let i = 0; ours && i < BUILT.length; i++) {
          if (before?.[i] === own[i]) continue
          await tx.insert(countersCol, { name: BUILT[i], value: own[i] })
        }
        await tx.flush()
        if (changed) for (const name of touched) touch(name)
        // before apply() returns: autobee clears host.applying right after, and addWriter reads it
        for (const [fn, args] of calls) await host[fn](...args)
        for (const row of epochs) {
          try {
            await onepoch(row)
          } catch (err) {
            onerror(err)
          }
        }
      }
      await view.flush()
      return { landed: refusal ? [] : landed, changed }
    }
  }
}
