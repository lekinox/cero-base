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
  EPOCHS,
  REMOVALS,
  REFUSALS,
  SPENT,
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

// a member who left, apart from one removed and from a revoked device, in the removals: ids never hold ':'
export const leftId = (memberId) => `left:${memberId}`

/**
 * Build the hyperdispatch router for a spec: wires membership, builtin, and
 * spec-defined collection/action ops, returning the router plus an apply loop.
 *
 * @param {object} opts
 * @param {{ dispatch: { Router: Function, encode: (name: string, value: unknown) => Uint8Array }, meta?: { refs?: Record<string, { kind?: string, internal?: boolean, own?: boolean, verb?: string, fields?: string[], required?: Record<string, string> }> } }} opts.spec  Generated hyperdispatch spec.
 * @param {string} opts.ns  Namespace prefix for collection and op names.
 * @param {(err: Error) => void} opts.onerror  Called when a malformed node is skipped.
 * @param {() => Uint8Array | null} opts.key  The database key, null until the bee booted.
 * @param {(row: { epoch: number, stamp: number, wrapped: Uint8Array, commit: Uint8Array }) => Promise<void>} opts.onepoch  Per-peer side of an applied rotation (skipped in dry runs).
 * @param {() => { publicKey: Uint8Array, secretKey: Uint8Array } | null} opts.room  The keypair behind the database's address, which joins are sealed to.
 * @param {(phase: 'before' | 'after', op: string) => Function[]} opts.hooks  Registered hooks for an op, run inside its transaction.
 * @param {(name: string) => void} opts.touch  Marks a ref written by a hook, so its watchers tick.
 * @param {(view: object, name: string, query?: string | import('./index.js').Query) => Promise<import('./index.js').SingleResult | import('./index.js').ListResult>} opts.read  Planned read against a given view, for a hook's `ctx.get`.
 * @returns {{ dispatch: (value: Buffer, ctx: object) => Promise<void>, apply: (nodes: Array<{ value: Buffer, key: Buffer }>, view: object, host: object) => Promise<void> }}
 */
export function makeDispatcher({ spec, ns, onerror, key, onepoch, room, hooks, touch, read }) {
  const router = new spec.dispatch.Router()

  const col = (name) => `@${ns}/${name}`
  const countersCol = `@${ns}/${COUNTERS}`
  const removals = `@${ns}/${REMOVALS}`
  const refusals = `@${ns}/${REFUSALS}`
  const spent = `@${ns}/${SPENT}`
  const getMember = (view, id) => view.get(`@${ns}/members`, { id })
  const getDevice = (view, id) => view.get(`@${ns}/devices`, { id })

  const getRole = async (view, identityKey) =>
    identityKey ? ((await getMember(view, hid.encode(identityKey)))?.role ?? null) : null

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

  // the operators developers know, bound to this op. A write is dispatched as the op's writer
  // would append it, so the same rank and `own` rules judge it
  function operators(ctx) {
    const current = (name, id) =>
      single(name) ? ctx.view.findOne(col(name), {}) : ctx.view.get(col(name), { id })
    // held to the fields as a direct write is, before the encoder drops or chokes on one
    const held = (name, row, stored) => {
      checkFields(name, spec.meta?.refs?.[name], row)
      checkRequired(name, spec.meta?.refs?.[name], stored)
      return stored
    }
    const write = (name, verb, row) => {
      touch(name)
      const value = spec.dispatch.encode(`@${ns}/${verb}-${verbOf(name)}`, row)
      return router.dispatch(value, { ...ctx, nested: true })
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

  // a seat taken again, as a linked device's own claim does, keeps the chain its link wrote
  async function seat(ctx, writer, memberId, ts, key, proof = null) {
    const id = hid.encode(writer)
    proof ??= (await getDevice(ctx.view, id))?.proof ?? null
    return save(ctx, 'put', 'devices', { id, memberId, createdAt: ts, updatedAt: ts, key, proof })
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
  // only REFUSED aborts a batch: every peer derives it. Decode failures and unknown routes skip one node
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
    if (await revoked(ctx.view, op.proof)) throw CeroError.REFUSED('removed')
    const { genesis } = ctx.host
    const inviter = await getRole(ctx.view, op.master)
    if (!genesis && !can(inviter, INVITE)) throw CeroError.REFUSED('invite')
    // only a device of the signer's own identity: another member's device seats itself through
    // its join, or any key the signer holds would act as them.
    // Always an indexer: autobee gc's caught-up non-indexer sessions and they miss later appends
    const memberId = hid.encode(op.master)
    if (op.memberId && op.memberId !== memberId) throw CeroError.REFUSED('member')
    if (await boundElsewhere(ctx.view, op.writer, memberId)) throw CeroError.REFUSED('member')
    await ctx.host.addWriter(op.writer, { isIndexer: true })
    await seat(ctx, op.writer, memberId, op.ts || 0, signed.device)
  })

  // a device goes with its seat and its key: by its own member, or one who may remove her
  async function unseat(ctx, id, device) {
    if (device?.memberId !== (await getSignerMember(ctx.view, ctx.key))) {
      if (!(await canRemoveMember(ctx.view, ctx.key, device?.memberId))) {
        throw CeroError.REFUSED('remove')
      }
    }
    await ctx.host.removeWriter(hid.decode(id))
    await revoke(ctx, device)
    await drop(ctx, 'devices', id)
  }
  add('del-writer', async (op, ctx) => {
    if (!isKey(op.writer)) return
    const id = hid.encode(op.writer)
    await unseat(ctx, id, await getDevice(ctx.view, id))
  })

  // a removed device's key, and any device it attests after, stays out: its chain is static, so
  // the removal is kept here, beside the members'
  async function revoke(ctx, device) {
    if (!device?.key) return
    const minted = (await ctx.view.get(countersCol, { name: 'invites' }))?.value ?? 0
    await ctx.view.insert(removals, { id: hid.encode(device.key), index: minted })
  }
  // the devices of the chain, not the identity it starts with: a member's removal is ordered by
  // its invites, a device's is for good
  async function revoked(view, proof) {
    for (const key of Identity.chain(proof).slice(1)) {
      if (await view.get(removals, { id: hid.encode(key) })) return true
    }
    return false
  }

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
    const next = isSelf ? { ...op } : { ...existing }
    next.key = existing.key
    next.role = existing.role
    next.createdAt = existing.createdAt
    next.updatedAt = op.updatedAt || existing.updatedAt

    let row
    if (op.role && op.role !== existing.role) {
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
    if (!existing) return
    // leaving is hers: only someone else taking her out turns her older codes away
    const leaving = op.id === (await getSignerMember(ctx.view, ctx.key))
    // every device of the member goes with them, and any keys they were still owed
    const vacate = async () => {
      if (existing.key) await ctx.host.removeWriter(existing.key)
      for (const device of await ctx.view.find(`@${ns}/devices`, {}).toArray()) {
        if (device.memberId !== op.id) continue
        await ctx.host.removeWriter(hid.decode(device.id))
        await drop(ctx, 'devices', device.id)
        await drop(ctx, 'requests', device.id)
      }
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
    // leaving it waits for a member to accept her again, so leaving first never dodges a removal. Either row re-keys
    // the handle at its first removal (rotation.js)
    const minted = (await ctx.view.get(countersCol, { name: 'invites' }))?.value ?? 0
    await ctx.view.insert(removals, { id: leaving ? leftId(op.id) : op.id, index: minted })
  })

  add('rotate-key', async (op, ctx) => {
    if (!op.wrapped?.byteLength) return
    // the commitment lets every member verify the sealed secret, so a rotator cannot split the database
    if (op.commit?.byteLength !== 32) return
    // the stamp is picked before any block is written, so epochs reorder freely; uniqueness is enforced here
    if (!Number.isInteger(op.stamp) || op.stamp <= 0 || op.stamp > 0xffffffff) return
    // envelopes that do not decode would stop every later audit
    if (!sealed(op.wrapped)) return
    if (!can(await getSignerRole(ctx.view, ctx.key), REMOVE)) {
      throw CeroError.REFUSED('rotate', 'rotate requires the remove permission')
    }
    const rows = await ctx.view.find(`@${ns}/${EPOCHS}`, {}).toArray()
    if (rows.some((r) => r.stamp === op.stamp)) return
    // sequence numbers order epochs; concurrent rotations get consecutive sequences, both readable
    const epoch = await bump(ctx.view, EPOCHS)
    const row = {
      epoch,
      stamp: op.stamp,
      wrapped: op.wrapped,
      createdAt: op.createdAt || 0,
      commit: op.commit
    }
    await ctx.view.insert(`@${ns}/${EPOCHS}`, row)
    touch(EPOCHS)
    // learned once its batch commits: a refused batch teaches no epoch, and a dry run commits nothing
    ctx.epochs?.push(row)
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
  // the device key stays what the admission proved, never what the row says
  add('add-device', async (op, ctx) => {
    selfOnly(op, ctx)
    const existing = await getDevice(ctx.view, op.id)
    await save(ctx, 'put', 'devices', { ...op, memberId: await bind(ctx), key: existing?.key })
  })
  add('set-device', async (op, ctx) => {
    selfOnly(op, ctx)
    const memberId = await bind(ctx)
    const existing = await getDevice(ctx.view, op.id)
    const ts = op.updatedAt || 0
    await save(ctx, 'set', 'devices', {
      ...op,
      memberId,
      key: existing?.key,
      createdAt: existing?.createdAt || op.createdAt || ts,
      updatedAt: ts
    })
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
  // its joins still waiting for a member are turned away with it; admitted ones are still owed
  // their keys. Its id stays, so a later join with it hears why
  async function spend(ctx, invite, reason) {
    const expires = invite.expires || 0
    await drop(ctx, 'invites', invite.id)
    await ctx.view.insert(spent, { id: invite.id, reason, expires })
    for (const request of await ctx.view.find(requests, {}).toArray()) {
      if (request.invite !== invite.id || request.admitted) continue
      await drop(ctx, 'requests', request.id)
      await refuse(ctx, request, reason)
    }
  }

  // a join turned away is answered at its reply address. A writer with a request hears through
  // that: one of the two per writer, or a denial could race its keys
  async function refuse(ctx, { id, reply, expires }, reason) {
    if (await ctx.view.get(requests, { id })) return
    await ctx.view.insert(refusals, { id, reply, reason, expires })
  }

  // the member, when new, and its device, seated when the member writes; its request stays until
  // a member delivered the keys. The invite is spent unless it is reusable
  async function admit(ctx, { invite, identity, key, writer, reply, role, ts }) {
    const memberId = hid.encode(identity)
    if (await boundElsewhere(ctx.view, writer, memberId)) throw CeroError.REFUSED('member')
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
    await seat(ctx, writer, memberId, ts, key)
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
    if (can(member.role, WRITE)) await ctx.host.addWriter(writer, { isIndexer: true })
    await seat(ctx, writer, memberId, ts, key, proof)
    await save(ctx, 'put', 'requests', {
      ...request(invite, hid.decode(memberId), key, writer, reply, ts),
      role: member.role,
      admitted: true
    })
    if (!invite.reuse) await spend(ctx, invite, 'spent')
  }

  function request(invite, identity, key, writer, reply, ts) {
    const expires = invite.expires || 0
    const id = hid.encode(writer)
    const { role } = invite
    return { id, identity, key, invite: invite.id, role, reply, expires, createdAt: ts }
  }

  // null when it does not open: anyone may append a join
  function open(box) {
    const pair = room()
    if (!pair || !box?.byteLength) return null
    try {
      const plain = crypto.decrypt(box, pair)
      return plain && c.decode(Join, plain)
    } catch {
      return null
    }
  }

  // the joiner's own core asks in: the invite proves it may, its device signs where the keys go
  // and the proof's chain says whose device it is
  add('join', async (op, ctx) => {
    const join = open(op.box)
    if (!join || !ctx.key) return
    if (!Invite.proven(join.invite, ctx.key, join.signature)) return
    const signed = Identity.verify(join.proof, joining(ctx.dbKey, join.invite, ctx.key, join.reply))
    if (!signed) return
    join.identity = signed.identity
    const id = hid.encode(ctx.key)
    const invite = await ctx.view.get(invites, { id: b4a.toHex(join.invite) })
    if (!invite) {
      // an invite the database never held could be anyone's: nobody answers it
      const record = await ctx.view.get(spent, { id: b4a.toHex(join.invite) })
      if (!record) return
      return refuse(ctx, { id, reply: join.reply, expires: record.expires }, record.reason)
    }
    const ts = join.ts || 0
    const memberId = hid.encode(join.identity)
    const known = await getMember(ctx.view, memberId)
    const removal = known ? null : await ctx.view.get(removals, { id: memberId })
    const out =
      (removal && (invite.index ?? 0) <= removal.index) || (await revoked(ctx.view, join.proof))
    if (out) return refuse(ctx, { id, reply: join.reply, expires: invite.expires || 0 }, 'removed')
    await ctx.view.delete(refusals, { id })
    const gone = known ? null : await ctx.view.get(removals, { id: leftId(memberId) })
    const older = gone && (invite.index ?? 0) <= gone.index
    if ((invite.confirm || older) && !known) {
      const waiting = request(invite, join.identity, signed.device, ctx.key, join.reply, ts)
      return save(ctx, 'put', 'requests', waiting)
    }
    await admit(ctx, {
      invite,
      identity: join.identity,
      key: signed.device,
      writer: ctx.key,
      reply: join.reply,
      role: invite.role,
      ts
    })
  })
  // a waiting join, admitted at a role within the invite's and the accepter's; with a proof, as a
  // device of the accepter's own identity, which its device attested
  add('accept', async (op, ctx) => {
    const waiting = await ctx.view.get(requests, { id: op.id })
    if (!waiting || waiting.admitted) return
    const invite = await ctx.view.get(invites, { id: waiting.invite })
    const r = await getSignerRole(ctx.view, ctx.key)
    const role = op.role || invite?.role
    if (!invite || !can(r, INVITE) || !grants(r, role) || !grants(invite.role, role)) {
      throw CeroError.REFUSED('invite')
    }
    const { identity, key, reply, createdAt: ts = 0 } = waiting
    const writer = hid.decode(op.id)
    if (op.proof) {
      const memberId = await getSignerMember(ctx.view, ctx.key)
      const linked = Identity.verify(op.proof, null, hid.decode(memberId))
      if (!linked || !b4a.equals(linked.device, key)) throw CeroError.REFUSED('device')
      if (await revoked(ctx.view, op.proof)) throw CeroError.REFUSED('removed')
      return admitDevice(ctx, { invite, memberId, key, proof: op.proof, writer, reply, ts })
    }
    await admit(ctx, { invite, identity, key, writer, reply, role, ts })
  })
  // answered through the log like every refusal; a deny that lost the race to an accept is nothing
  add('deny', async (op, ctx) => {
    const waiting = await ctx.view.get(requests, { id: op.id })
    if (!waiting || waiting.admitted) return
    if (!can(await getSignerRole(ctx.view, ctx.key), INVITE)) throw CeroError.REFUSED('invite')
    await drop(ctx, 'requests', op.id)
    await refuse(ctx, waiting, op.reason || '')
  })
  // only a join writes a request
  const joinsOnly = async () => {
    throw CeroError.REFUSED('request')
  }
  add('add-request', joinsOnly)
  add('set-request', joinsOnly)
  // a denial, or keys delivered
  add('del-request', async (op, ctx) => {
    if (!can(await getSignerRole(ctx.view, ctx.key), INVITE)) throw CeroError.REFUSED('invite')
    await drop(ctx, 'requests', op.id)
  })
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

  add('add-handle', upsert('handles', COLLECTION, false))
  add('set-handle', update('handles', false))
  add('del-handle', remove('handles', false))

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
    dispatch: (value, ctx) => router.dispatch(value, ctx),
    async apply(nodes, view, host) {
      const dbKey = key()
      // a batch is one writer's contiguous run, so a refusal discards only that writer's ops
      const tx = view.transaction()
      // host calls survive a discarded transaction, so they replay once the batch commits
      const calls = []
      const deferred = Object.create(host)
      deferred.addWriter = (...args) => void calls.push(['addWriter', args])
      deferred.removeWriter = (...args) => void calls.push(['removeWriter', args])
      const epochs = []
      let refusal = null
      for (const node of nodes) {
        try {
          const seed = crypto.hash([node.key, c.encode(c.uint, node.length), node.value])
          // never a clock: the node's time is the same on every peer
          await router.dispatch(node.value, {
            view: tx,
            host: deferred,
            key: node.key,
            dbKey,
            seed,
            ts: node.timestamp,
            epochs
          })
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
        await tx.flush()
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
    }
  }
}
