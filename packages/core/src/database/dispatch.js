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
  OWNER,
  INVITE,
  REMOVE,
  ASSIGN,
  WRITE
} from '../lib/constants.js'
import {
  can,
  grants,
  outranks,
  admission,
  ownership,
  joining,
  checkFields,
  checkRequired,
  stamp
} from '../lib/utils.js'
import { CeroError } from '../lib/errors.js'
import { getEncoding } from '../lib/spec/index.js'
import { Identity } from '../identity/index.js'
import { Invite } from '../pairing/invite.js'

const Join = getEncoding('@cero/join')

// wire fields are variable-length: reject wrong sizes before sodium and hid throw on them
const isKey = (b) => b?.byteLength === 32
const isSig = (b) => b?.byteLength === 64

// member and device have their own set handlers, every other collection upserts via add-
export const BESPOKE = new Set(['member', 'device'])

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

  async function bump(view, name) {
    const value = ((await view.get(countersCol, { name }))?.value ?? 0) + 1
    await view.insert(countersCol, { name, value })
    return value
  }

  async function insert(view, name, op) {
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
  function operators(ctx, ts) {
    let n = 0
    // every peer must mint the same id: hash the applying op and a per-op counter
    const mint = () => z32.encode(crypto.hash([ctx.seed, c.encode(c.uint, n++)]).subarray(0, 16))
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
      put: (ref, row) => {
        const name = refName(ref)
        if (single(name)) return write(name, 'set', held(name, row, stamp(row, null, ts)))
        const stored = stamp({ ...row, id: row.id ?? mint() }, null, ts)
        return write(name, 'add', held(name, row, stored))
      },
      // an upsert, as the set operator appends it
      set: async (ref, row) => {
        const name = refName(ref)
        if (!single(name) && !row.id) throw CeroError.INVALID(`set('${name}') needs an id`)
        const verb = single(name) || BESPOKE.has(verbOf(name)) ? 'set' : 'add'
        const was = await current(name, row.id)
        return write(name, verb, held(name, row, stamp({ ...was, ...row }, was?.createdAt, ts)))
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
  // Resolves to the row that landed, which a before hook may have changed
  async function hooked(fns, { op, name, id = null, row = null, existing = null }, ctx, write) {
    if (!fns) {
      await write(row)
      return row
    }
    // never a clock: a derived row must stamp the same timestamp on every peer
    const ts = row?.updatedAt || existing?.updatedAt || 0
    const hctx = { op, name, row, existing, id, ...(await author(ctx)), ...operators(ctx, ts) }
    await fire(fns.before, hctx, true)
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

  function seat(ctx, writer, memberId, ts) {
    const row = { id: hid.encode(writer), memberId, createdAt: ts, updatedAt: ts }
    return save(ctx, 'put', 'devices', row)
  }

  // deleting a row that is not there changes nothing, and fires nothing
  async function drop(ctx, name, id) {
    const fns = pick('del', ctx)
    const existing = fns ? await ctx.view.get(col(name), { id }) : null
    const meta = { op: 'del', name, id, existing }
    await hooked(existing ? fns : null, meta, ctx, () => ctx.view.delete(col(name), { id }))
  }

  // a rule that errors must not diverge peers: a throw refuses exactly like a false verdict
  async function fire(fns, hctx, vote) {
    for (const fn of fns) {
      let verdict
      try {
        verdict = await fn(hctx)
      } catch (err) {
        throw CeroError.REFUSED('hook', err.message)
      }
      if (vote && verdict === false) throw CeroError.REFUSED('hook')
    }
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
      return hooked(fns, meta, ctx, (row) => ctx.view.insert(col(name), row))
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

  // an op's after hooks run once all its rows landed
  const add = (verb, fn) =>
    router.add(`@${ns}/${verb}`, async (op, ctx) => {
      const later = []
      await fn(op, { ...ctx, later })
      for (const run of later) await run()
    })

  add('add-writer', async (op, ctx) => {
    if (!isKey(op.master) || !isKey(op.writer) || !isSig(op.sig)) return
    if (!Identity.verify(op.master, admission(ctx.dbKey, op.writer, ctx.key), op.sig)) return
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
    await seat(ctx, op.writer, memberId, op.ts || 0)
  })

  add('del-writer', async (op, ctx) => {
    if (!isKey(op.writer)) return
    const target = await getDevice(ctx.view, hid.encode(op.writer))
    if (target?.memberId !== (await getSignerMember(ctx.view, ctx.key))) {
      if (!(await canRemoveMember(ctx.view, ctx.key, target?.memberId))) {
        throw CeroError.REFUSED('remove')
      }
    }
    await ctx.host.removeWriter(op.writer)
    await drop(ctx, 'devices', hid.encode(op.writer))
  })

  add('claim-writer', async (op, ctx) => {
    if (!isKey(op.identity) || !isKey(op.writer) || !isSig(op.sig)) return
    if (!Identity.verify(op.identity, ownership(ctx.dbKey, op.writer), op.sig)) return
    // from any other core a claim is inapplicable, not refused: it must not abort that writer's batch
    if (!b4a.equals(ctx.key, op.writer)) return
    const memberId = hid.encode(op.identity)
    if (!can(await getRole(ctx.view, op.identity), WRITE)) throw CeroError.REFUSED('write')
    if (await boundElsewhere(ctx.view, op.writer, memberId)) throw CeroError.REFUSED('member')
    await ctx.host.addWriter(op.writer, { isIndexer: true })
    await seat(ctx, op.writer, memberId, op.ts || 0)
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
    const next = isSelf ? { ...op } : { ...existing }
    next.key = existing.key
    next.role = existing.role
    next.createdAt = existing.createdAt
    next.updatedAt = op.updatedAt || existing.updatedAt

    if (op.role && op.role !== existing.role) {
      const r = await getSignerRole(ctx.view, ctx.key)
      if (!(can(r, ASSIGN) && grants(r, op.role) && outranks(r, existing.role))) {
        throw CeroError.REFUSED('assign')
      }
      next.role = op.role
    }
    const row = await save(ctx, 'set', 'members', next)
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
    if (op.id !== (await getSignerMember(ctx.view, ctx.key))) {
      const r = await getSignerRole(ctx.view, ctx.key)
      if (!can(r, REMOVE) || !outranks(r, existing.role)) throw CeroError.REFUSED('remove')
    } else if (existing.role === OWNER && (await orphans(ctx.view, op.id))) {
      throw CeroError.INVALID('the last owner cannot leave: hand the room to another owner first')
    }
    if (existing.key) await ctx.host.removeWriter(existing.key)
    // every device of the member goes with them, and any keys they were still owed
    for (const device of await ctx.view.find(`@${ns}/devices`, {}).toArray()) {
      if (device.memberId !== op.id) continue
      await ctx.host.removeWriter(hid.decode(device.id))
      await drop(ctx, 'devices', device.id)
      await drop(ctx, 'requests', device.id)
    }
    await drop(ctx, 'members', op.id)
    // an invite they could hold, or saw, does not bring them back
    const minted = (await ctx.view.get(countersCol, { name: 'invites' }))?.value ?? 0
    await ctx.view.insert(removals, { id: op.id, index: minted })
  })

  add('rotate-key', async (op, ctx) => {
    if (!op.wrapped?.byteLength) return
    // the commitment lets every member verify the sealed secret, so a rotator cannot split the room
    if (op.commit?.byteLength !== 32) return
    // the stamp is picked before any block is written, so epochs reorder freely; uniqueness is enforced here
    if (!Number.isInteger(op.stamp) || op.stamp <= 0 || op.stamp > 0xffffffff) return
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
    // never in a dry run: the announcement itself is appended under the old epoch
    if (!ctx.dryRun) {
      try {
        await onepoch(row)
      } catch (err) {
        onerror(err)
      }
    }
  })

  add('del-device', async (op, ctx) => {
    const existing = await getDevice(ctx.view, op.id)
    if (!existing) return
    if (existing.memberId !== (await getSignerMember(ctx.view, ctx.key))) {
      if (!(await canRemoveMember(ctx.view, ctx.key, existing.memberId))) {
        throw CeroError.REFUSED('remove')
      }
    }
    await ctx.host.removeWriter(hid.decode(existing.id))
    await drop(ctx, 'devices', op.id)
  })

  // a device row is the writer→role mapping, so memberId never comes off the wire; a core no
  // member owns writes none, or any stranger's optimistic node would plant a device in the room
  const bind = async (ctx) => {
    const { memberId } = await author(ctx)
    if (!memberId) throw CeroError.REFUSED('member')
    return memberId
  }
  // a device describes only itself: another's record, or a made-up id, would break removing it
  const selfOnly = (op, ctx) => {
    if (!ctx.key || op.id !== hid.encode(ctx.key)) throw CeroError.REFUSED('device')
  }
  add('add-device', async (op, ctx) => {
    selfOnly(op, ctx)
    await save(ctx, 'put', 'devices', { ...op, memberId: await bind(ctx) })
  })
  add('set-device', async (op, ctx) => {
    selfOnly(op, ctx)
    const memberId = await bind(ctx)
    const existing = await getDevice(ctx.view, op.id)
    const ts = op.updatedAt || 0
    await save(ctx, 'set', 'devices', {
      ...op,
      memberId,
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
  add('del-invite', async (op, ctx) => {
    const existing = await ctx.view.get(invites, { id: op.id })
    if (!existing) return
    const r = await getSignerRole(ctx.view, ctx.key)
    if (!can(r, REMOVE) || !capped(r, existing)) throw CeroError.REFUSED('invite')
    await spend(ctx, existing)
  })
  // its joins still waiting for a member go with it; admitted ones are still owed their keys
  async function spend(ctx, invite) {
    await drop(ctx, 'invites', invite.id)
    for (const request of await ctx.view.find(requests, {}).toArray()) {
      if (request.invite === invite.id && !request.admitted) await drop(ctx, 'requests', request.id)
    }
  }

  // the member, when new, and its device, seated when the member writes; its request stays until
  // a member delivered the keys. The invite is spent unless it is reusable
  async function admit(ctx, { invite, identity, writer, reply, role, ts }) {
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
    await seat(ctx, writer, memberId, ts)
    await save(ctx, 'put', 'requests', {
      ...request(invite, identity, writer, reply, ts),
      role,
      admitted: true
    })
    if (!invite.reuse) await spend(ctx, invite)
  }

  function request(invite, identity, writer, reply, ts) {
    const expires = invite.expires || 0
    const id = hid.encode(writer)
    return { id, identity, invite: invite.id, role: invite.role, reply, expires, createdAt: ts }
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

  // the joiner's own core asks in: the invite proves it may, its identity signs where the keys go
  add('join', async (op, ctx) => {
    const join = open(op.box)
    if (!join || !ctx.key) return
    if (!Invite.proven(join.invite, ctx.key, join.proof)) return
    const signed = joining(ctx.dbKey, join.invite, ctx.key, join.reply)
    if (!Identity.verify(join.identity, signed, join.signature)) return
    const invite = await ctx.view.get(invites, { id: b4a.toHex(join.invite) })
    if (!invite) return
    const ts = join.ts || 0
    const memberId = hid.encode(join.identity)
    const known = await getMember(ctx.view, memberId)
    const removal = known ? null : await ctx.view.get(removals, { id: memberId })
    if (removal && (invite.index ?? 0) <= removal.index) return
    if (invite.confirm && !known) {
      const waiting = request(invite, join.identity, ctx.key, join.reply, ts)
      return save(ctx, 'put', 'requests', waiting)
    }
    await admit(ctx, {
      invite,
      identity: join.identity,
      writer: ctx.key,
      reply: join.reply,
      role: invite.role,
      ts
    })
  })
  // a waiting join, admitted at a role within the invite's and the accepter's
  add('accept', async (op, ctx) => {
    const waiting = await ctx.view.get(requests, { id: op.id })
    if (!waiting || waiting.admitted) return
    const invite = await ctx.view.get(invites, { id: waiting.invite })
    const r = await getSignerRole(ctx.view, ctx.key)
    const role = op.role || invite?.role
    if (!invite || !can(r, INVITE) || !grants(r, role) || !grants(invite.role, role)) {
      throw CeroError.REFUSED('invite')
    }
    const { identity, reply, createdAt: ts = 0 } = waiting
    await admit(ctx, { invite, identity, writer: hid.decode(op.id), reply, role, ts })
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
      let refusal = null
      for (const node of nodes) {
        try {
          const seed = crypto.hash([node.key, node.value])
          await router.dispatch(node.value, {
            view: tx,
            host: deferred,
            key: node.key,
            dbKey,
            seed
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
      }
      await view.flush()
    }
  }
}
