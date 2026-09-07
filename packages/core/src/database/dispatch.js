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
  INVITE,
  REMOVE,
  ASSIGN,
  WRITE
} from '../lib/constants.js'
import { can, grants, outranks, admission, ownership } from '../lib/utils.js'
import { CeroError } from '../lib/errors.js'
import { Identity } from '../identity/index.js'

// wire fields are variable-length: reject wrong sizes before sodium and hid throw on them
const isKey = (b) => b?.byteLength === 32
const isSig = (b) => b?.byteLength === 64

/**
 * Build the hyperdispatch router for a spec: wires membership, builtin, and
 * spec-defined collection/action ops, returning the router plus an apply loop.
 *
 * @param {object} opts
 * @param {{ dispatch: { Router: Function }, meta?: { refs?: Record<string, { kind?: string, builtin?: boolean, verb?: string }> } }} opts.spec  Generated hyperdispatch spec.
 * @param {string} opts.ns  Namespace prefix for collection and op names.
 * @param {Record<string, Function>} opts.routes  Custom action handlers keyed by route name.
 * @param {(err: Error) => void} opts.onerror  Called when a malformed node is skipped.
 * @param {() => Uint8Array | null} opts.key  The database key, null until the bee booted.
 * @param {(row: { epoch: number, stamp: number, wrapped: Uint8Array, commit: Uint8Array }) => Promise<void>} opts.onepoch  Per-peer side of an applied rotation (skipped in dry runs).
 * @param {(phase: 'before' | 'after', op: string) => Function[]} [opts.hooks]  Registered hooks for an op, run inside its transaction.
 * @param {(name: string) => void} [opts.touch]  Marks a ref written by a hook, so its watchers tick.
 * @param {(view: object, name: string, query?: any) => Promise<any>} [opts.read]  Planned read against a given view, for a hook's `ctx.get`.
 * @param {(fn: Function) => Function} [opts.inHook]  Wraps a route so operators called inside it throw, like a hook.
 * @returns {{ dispatch: (value: Buffer, ctx: object) => Promise<void>, apply: (nodes: Array<{ value: Buffer, key: Buffer }>, view: object, host: object) => Promise<void> }}
 */
export function makeDispatcher({
  spec,
  ns,
  routes,
  onerror,
  key,
  onepoch,
  hooks,
  touch,
  read,
  inHook = (fn) => fn
}) {
  const router = new spec.dispatch.Router()

  const countersCol = `@${ns}/${COUNTERS}`
  const getMember = (view, id) => view.get(`@${ns}/members`, { id })
  const getDevice = (view, id) => view.get(`@${ns}/devices`, { id })

  const getRole = async (view, identityKey) =>
    identityKey ? ((await getMember(view, hid.encode(identityKey)))?.role ?? null) : null

  const getSignerRole = async (view, writerKey) => {
    if (!writerKey) return null
    const d = await getDevice(view, hid.encode(writerKey))
    return d?.memberId ? ((await getMember(view, d.memberId))?.role ?? null) : null
  }
  const isGenesis = async (view) => !(await view.findOne(`@${ns}/members`, {}))
  const getSignerMember = async (view, key) =>
    (key ? (await getDevice(view, hid.encode(key)))?.memberId : null) ?? null
  const canRemoveMember = async (view, signerKey, targetMemberId) => {
    const r = await getSignerRole(view, signerKey)
    if (!can(r, REMOVE)) return false
    const tRole = targetMemberId ? (await getMember(view, targetMemberId))?.role : null
    return !tRole || outranks(r, tRole)
  }

  async function insert(view, name, col, op) {
    if (name !== COUNTERS) {
      const existing = op.id != null ? await view.get(col, op) : null
      if (existing && existing.index != null) {
        op.index = existing.index
      } else {
        const counter = (await view.get(countersCol, { name })) ?? { name, value: 0 }
        op.index = counter.value + 1
        await view.insert(countersCol, { name, value: op.index })
      }
    }
    await view.insert(col, op)
  }

  const pick = (op) => {
    if (!hooks || !op) return null
    const before = hooks('before', op)
    const after = hooks('after', op)
    return before.length || after.length ? { before, after } : null
  }

  const refName = (ref) => (typeof ref === 'string' ? ref : ref?.name)
  const single = (name) => spec.meta?.refs?.[name]?.kind === SINGLE

  // the operators developers know, bound to the open transaction and this op's stamps
  function operators(view, memberId, ts, seed) {
    let n = 0
    // every peer must mint the same id: hash the applying op and a per-op counter
    const mint = () => z32.encode(crypto.hash([seed, c.encode(c.uint, n++)]).subarray(0, 16))
    const col = (name) => `@${ns}/${name}`
    const current = (name, id) =>
      single(name) ? view.findOne(col(name), {}) : view.get(col(name), { id })
    const stamp = (row, was) => ({
      ...was,
      createdAt: was?.createdAt ?? ts,
      ...row,
      updatedAt: row.updatedAt ?? ts,
      memberId
    })
    const store = (name, row) => {
      touch?.(name)
      return single(name) ? view.insert(col(name), row) : insert(view, name, col(name), row)
    }
    return {
      get: (ref, query) => read(view, refName(ref), query),
      put: (ref, row) => {
        const name = refName(ref)
        return store(name, stamp(single(name) ? row : { ...row, id: row.id ?? mint() }, null))
      },
      set: async (ref, row) => {
        const name = refName(ref)
        if (!single(name) && !row.id) throw CeroError.INVALID(`set('${name}') needs an id`)
        return store(name, stamp(row, await current(name, row.id)))
      },
      del: (ref, id) => {
        const name = refName(ref)
        touch?.(name)
        return view.delete(col(name), single(name) ? {} : { id })
      }
    }
  }

  // hooks run inside the op's transaction on every peer, so their verdict is part of the op
  // a rule never meets a nameless writer: an admitted core with no member row is refused
  // where a hook or route would have to judge it
  async function signer(ctx) {
    const memberId = await getSignerMember(ctx.view, ctx.key)
    const role = memberId ? (await getMember(ctx.view, memberId))?.role : null
    if (!memberId || !role) throw CeroError.REFUSED('member')
    return { memberId, role }
  }

  async function hooked(fns, { op, name, id = null, row = null, existing = null }, ctx, write) {
    if (!fns) return write(row)
    const { memberId, role } = await signer(ctx)
    // never a clock: a derived row must stamp the same timestamp on every peer
    const ts = row?.updatedAt || existing?.updatedAt || 0
    const hctx = {
      op,
      name,
      row,
      existing,
      id,
      memberId,
      role,
      ...operators(ctx.view, memberId, ts, ctx.seed)
    }
    await fire(fns.before, hctx, true)
    await write(hctx.row)
    await fire(fns.after, hctx, false)
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

  const upsert = (name, col, kind, own, hook) => async (op, ctx) => {
    await requireWrite(ctx)
    const d = ctx.key && (await getDevice(ctx.view, hid.encode(ctx.key)))
    op.memberId = d?.memberId || null
    const fns = pick(hook)
    if (kind !== COLLECTION) {
      const existing = fns ? await ctx.view.findOne(col, {}) : null
      const meta = { op: hook, name, row: op, existing }
      return hooked(fns, meta, ctx, (row) => ctx.view.insert(col, row))
    }
    const existing = own || fns ? await ctx.view.get(col, { id: op.id }) : null
    // add on an existing id is an overwrite, same ownership rule as set
    if (own) await requireOwn(ctx, existing)
    const meta = { op: hook, name, id: op.id, row: op, existing }
    await hooked(fns, meta, ctx, (row) => insert(ctx.view, name, col, row))
  }
  const update = (name, col, own, hook) => async (op, ctx) => {
    await requireWrite(ctx)
    const existing = await ctx.view.get(col, { id: op.id })
    if (!existing) return
    if (own) await requireOwn(ctx, existing)
    // memberId is attribution: derived here, never merged off the wire
    const d = ctx.key && (await getDevice(ctx.view, hid.encode(ctx.key)))
    const merged = { ...existing, ...op, memberId: d?.memberId || null }
    const meta = { op: hook, name, id: op.id, row: merged, existing }
    await hooked(pick(hook), meta, ctx, (row) => insert(ctx.view, name, col, row))
  }
  const remove = (name, col, own, hook) => async (op, ctx) => {
    await requireWrite(ctx)
    const fns = pick(hook)
    const existing = own || fns ? await ctx.view.get(col, { id: op.id }) : null
    if (own) await requireOwn(ctx, existing)
    const meta = { op: hook, name, id: op.id, existing }
    return hooked(fns, meta, ctx, () => ctx.view.delete(col, op))
  }
  // only REFUSED aborts a batch: every peer derives it. Decode failures and unknown routes skip one node
  const isRefusal = (err) => err?.isCeroError === true && err.code === 'REFUSED'

  const add = (verb, fn) => router.add(`@${ns}/${verb}`, fn)

  add('add-writer', async (op, ctx) => {
    if (!isKey(op.master) || !isKey(op.writer) || !isSig(op.sig)) return
    if (!Identity.verify(op.master, admission(ctx.dbKey, op.writer, ctx.key), op.sig)) return
    const genesis = await isGenesis(ctx.view)
    const inviter = await getRole(ctx.view, op.master)
    if (!genesis && !can(inviter, INVITE)) throw CeroError.REFUSED('invite')
    // the rank is add-member's decision in the same transaction: a refused grant discards this admission.
    // Always an indexer: autobee gc's caught-up non-indexer sessions and they miss later appends
    // a writer belongs to a member: its own identity, or the member named by the op
    const memberId = op.memberId || hid.encode(op.master)
    if (op.memberId && !(await getMember(ctx.view, op.memberId))) {
      throw CeroError.REFUSED('member')
    }
    await ctx.host.addWriter(op.writer, { isIndexer: true })
    const ts = op.ts || 0
    await insert(ctx.view, 'devices', `@${ns}/devices`, {
      id: hid.encode(op.writer),
      memberId,
      createdAt: ts,
      updatedAt: ts
    })
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
    await ctx.view.delete(`@${ns}/devices`, { id: hid.encode(op.writer) })
  })

  add('claim-writer', async (op, ctx) => {
    if (!isKey(op.identity) || !isKey(op.writer) || !isSig(op.sig)) return
    if (!Identity.verify(op.identity, ownership(ctx.dbKey, op.writer), op.sig)) return
    // from any other core a claim is inapplicable, not refused: it must not abort that writer's batch
    if (!b4a.equals(ctx.key, op.writer)) return
    const memberId = hid.encode(op.identity)
    if (!can(await getRole(ctx.view, op.identity), WRITE)) throw CeroError.REFUSED('write')
    await ctx.host.addWriter(op.writer, { isIndexer: true })
    const ts = op.ts || 0
    await insert(ctx.view, 'devices', `@${ns}/devices`, {
      id: hid.encode(op.writer),
      memberId,
      createdAt: ts,
      updatedAt: ts
    })
  })

  add('add-member', async (op, ctx) => {
    if (!isKey(op.key)) return
    if (!(await isGenesis(ctx.view))) {
      const r = await getSignerRole(ctx.view, ctx.key)
      if (!can(r, INVITE) || !grants(r, op.role)) throw CeroError.REFUSED('invite')
    }
    await insert(ctx.view, 'members', `@${ns}/members`, op)
    const deviceId = hid.encode(op.key)
    const existingDevice = await getDevice(ctx.view, deviceId)
    const ts = op.updatedAt || 0
    await insert(ctx.view, 'devices', `@${ns}/devices`, {
      id: deviceId,
      memberId: op.id,
      name: existingDevice?.name ?? null,
      isMobile: existingDevice?.isMobile ?? false,
      createdAt: existingDevice?.createdAt || op.createdAt || ts,
      updatedAt: ts
    })
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
    await insert(ctx.view, 'members', `@${ns}/members`, next)
    // a demotion that takes WRITE away takes the writer seat with it
    if (can(existing.role, WRITE) && !can(next.role, WRITE)) {
      if (next.key) await ctx.host.removeWriter(next.key)
      for (const device of await ctx.view.find(`@${ns}/devices`, {}).toArray()) {
        if (device.memberId !== next.id) continue
        await ctx.host.removeWriter(hid.decode(device.id))
      }
      // device rows stay: an unresolvable writer would read as not yet enrolled and pass the gate
    }
  })

  add('del-member', async (op, ctx) => {
    const existing = await getMember(ctx.view, op.id)
    if (!existing) return
    if (op.id !== (await getSignerMember(ctx.view, ctx.key))) {
      const r = await getSignerRole(ctx.view, ctx.key)
      if (!can(r, REMOVE) || !outranks(r, existing.role)) throw CeroError.REFUSED('remove')
    }
    if (existing.key) await ctx.host.removeWriter(existing.key)
    // every device of the member goes with them
    for (const device of await ctx.view.find(`@${ns}/devices`, {}).toArray()) {
      if (device.memberId !== op.id) continue
      await ctx.host.removeWriter(hid.decode(device.id))
      await ctx.view.delete(`@${ns}/devices`, { id: device.id })
    }
    await ctx.view.delete(`@${ns}/members`, op)
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
    const counter = (await ctx.view.get(countersCol, { name: EPOCHS })) ?? {
      name: EPOCHS,
      value: 0
    }
    const epoch = counter.value + 1
    await ctx.view.insert(countersCol, { name: EPOCHS, value: epoch })
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
    await ctx.view.delete(`@${ns}/devices`, op)
  })

  // a device row is the writer→role mapping, so memberId never comes off the wire: an unknown id
  // binds to the signer's own member, or one unauthenticated op could inherit the owner's authority
  const devices = `@${ns}/devices`
  const bind = async (ctx, existing) =>
    existing?.memberId ?? (await getSignerMember(ctx.view, ctx.key))
  add('add-device', async (op, ctx) => {
    const existing = await getDevice(ctx.view, op.id)
    await insert(ctx.view, 'devices', devices, { ...op, memberId: await bind(ctx, existing) })
  })
  add('set-device', async (op, ctx) => {
    const existing = await getDevice(ctx.view, op.id)
    const ts = op.updatedAt || 0
    await insert(ctx.view, 'devices', devices, {
      ...op,
      memberId: await bind(ctx, existing),
      createdAt: existing?.createdAt || op.createdAt || ts,
      updatedAt: ts
    })
  })

  // any WRITE member mints an invite, its rank capped at admission; an existing row is never
  // overwritten, and altering or revoking one needs REMOVE
  const invites = `@${ns}/invites`
  add('add-invite', async (op, ctx) => {
    await requireWrite(ctx)
    if (await ctx.view.get(invites, { id: op.id })) throw CeroError.REFUSED('invite')
    await insert(ctx.view, 'invites', invites, op)
  })
  const moderate = async (ctx) => {
    if (!can(await getSignerRole(ctx.view, ctx.key), REMOVE)) throw CeroError.REFUSED('invite')
  }
  add('set-invite', async (op, ctx) => {
    await moderate(ctx)
    const existing = await ctx.view.get(invites, { id: op.id })
    if (!existing) return
    await insert(ctx.view, 'invites', invites, { ...existing, ...op })
  })
  // revoking needs REMOVE; consuming a single-use invite is done by whichever replica served the join
  add('del-invite', async (op, ctx) => {
    const existing = await ctx.view.get(invites, { id: op.id })
    const consume = existing && existing.reuse !== true
    const r = await getSignerRole(ctx.view, ctx.key)
    if (!can(r, REMOVE) && !(consume && can(r, INVITE))) throw CeroError.REFUSED('invite')
    return ctx.view.delete(invites, op)
  })

  const files = `@${ns}/files`
  add('add-file', async (op, ctx) => {
    if (!can(await getSignerRole(ctx.view, ctx.key), WRITE)) throw CeroError.REFUSED('write')
    const memberId = await getSignerMember(ctx.view, ctx.key)
    await insert(ctx.view, 'files', files, {
      id: op.id,
      name: op.name ?? null,
      memberId,
      stamp: op.stamp ?? 0
    })
  })
  add('set-file', update('files', files))
  add('del-file', remove('files', files))

  const handles = `@${ns}/handles`
  add('add-handle', upsert('handles', handles, COLLECTION))
  add('set-handle', update('handles', handles))
  add('del-handle', remove('handles', handles))

  for (const [name, info] of Object.entries(spec.meta?.refs || {})) {
    if (info.internal) continue
    if (info.kind === 'handle') continue
    if (info.kind === ACTION) {
      const route = routes[name]
      // an action with no local route diverges this peer from those that ran it: surface it
      if (!route) {
        add(name, async () => onerror(CeroError.UNKNOWN('route', name)))
        continue
      }
      // a route is a hook with no row: the same ctx, the same refusal semantics
      add(name, async (op, ctx) => {
        const { memberId, role } = await signer(ctx)
        const hctx = {
          op: name,
          name,
          row: op,
          memberId,
          role,
          ...operators(ctx.view, memberId, op.updatedAt || op.ts || 0, ctx.seed)
        }
        await fire([inHook(route)], hctx, true)
      })
      continue
    }
    const col = `@${ns}/${name}`
    const kind = info.kind === SINGLE ? SINGLE : COLLECTION
    const set =
      kind === SINGLE ? upsert(name, col, kind, false, 'set') : update(name, col, info.own, 'set')
    add(`set-${name}`, set)
    if (info.kind === SINGLE) {
      // wipe the keyless single row (the dummy id in the op is ignored)
      add(`del-${name}`, async (op, ctx) => {
        const fns = pick('del')
        const existing = fns ? await ctx.view.findOne(col, {}) : null
        return hooked(fns, { op: 'del', name, existing }, ctx, () => ctx.view.delete(col, {}))
      })
      continue
    }
    add(`add-${name}`, upsert(name, col, COLLECTION, info.own, 'put'))
    add(`del-${name}`, remove(name, col, info.own, 'del'))
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
