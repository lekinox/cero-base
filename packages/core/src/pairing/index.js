import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import hid from 'hypercore-id-encoding'
import Autobee from 'autobee'

import { Invite } from './invite.js'
import { Request, Response, STATUS_ACCEPTED, STATUS_DENIED } from './request.js'
import { Mailbox } from '../mailbox/index.js'
import { Post } from '../mailbox/post.js'
import { wrap } from '../database/envelope.js'
import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'
import { can, grants, isRank, joining, INVITE, REMOVE } from '../lib/utils.js'
import { NAMESPACE } from '../lib/constants.js'

const Join = getEncoding('@cero/join')
const MAX_DELAY = 2 ** 31 - 1

/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array }} KeyPair
 *
 * @typedef {object} PairingOpts
 * @property {Mailbox} mailbox                      The device's mailbox: replies are sent from there.
 * @property {import('../database/index.js').Database} db  The database the invites open. Its `invites` collection holds them, and apply admits their joins.
 *
 * @typedef {object} InviteOpts
 * @property {string} [role]                        Role granted, at most your own.
 * @property {number | string} [ttl]                How long it is valid: ms, or `'12h'`, `'2d'`… Never expires when omitted.
 * @property {boolean} [reuse]                      Admit more than one joiner. Otherwise spent by the first.
 * @property {boolean} [confirm]                    Its joins wait for a member to accept them, as `candidate`s.
 * @property {Uint8Array | null} [data]             The app's payload in the invite, readable before joining: `Invite.parse(invite).data`.
 *
 * @typedef {object} JoinOpts
 * @property {import('../identity/index.js').Identity} identity  Who joins: the member they become, and who signs the join.
 * @property {{ dispatch: { encode: Function }, meta?: { ns?: string, version?: number } }} spec  The database's spec: the join is one of its ops.
 * @property {KeyPair} [writer]                     Their writer keypair in the database, a fresh one by default. The join is its first block and its secret key owns the reply address: pass the same one to resume a join after a restart.
 * @property {number} [timeout]                     Deadline for the reply, in ms; `0` waits until the invite expires, or for good. Defaults to 30000.
 * @property {AbortSignal} [signal]                 Stops the join, rejecting it with `CLOSED`, as closing the mailbox does.
 *
 * @typedef {object} JoinResult
 * @property {Uint8Array} key
 * @property {Uint8Array | null} encryptionKey
 * @property {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} epochs
 * @property {KeyPair} writer                       The writer the join admitted: open the database with it.
 */

/**
 * Invites into a database. An invite is a record in the database; a joiner writes one signed
 * `join` op into its own writer core and announces it to the database's peers, and apply admits
 * it. The admission stays in the database until the joiner has its keys: every device of a member
 * that may invite offers them while online, and the first one read settles it for all. A
 * `confirm` invite's joins wait as `candidate`s until a member accepts or denies them.
 * `Pairing.join` is the other side: write the join, wait for the reply.
 */
export class Pairing extends ReadyResource {
  /** @param {PairingOpts} [opts] */
  constructor({ mailbox, db } = {}) {
    super()
    if (!mailbox) throw CeroError.REQUIRED('mailbox')
    if (!db) throw CeroError.REQUIRED('db')

    this.mailbox = mailbox
    this.db = db
    /** @type {Set<Request>} candidates not settled yet: whoever attaches after one fired goes through these first */
    this.pending = new Set()
    /** Whether this device answers the database's joins: it may invite, and invites or joiners owed their keys exist. */
    this.serving = false

    this._requests = new Map() // writer id → Request
    this._replies = new Map() // writer id → the Post offering its keys
    this._expiry = null
    this._onupdate = (touched) => {
      if (['*', 'invites', 'requests', 'members'].some((name) => touched.has(name))) {
        this._sync().catch(safetyCatch)
      }
    }
  }

  async _open() {
    await this.mailbox.ready()
    await this.db.ready()
    await this._sync()
    this.db.on('update', this._onupdate)
  }

  async _close() {
    this.db.off('update', this._onupdate)
    clearTimeout(this._expiry)
    const posts = [...this._replies.values()]
    this._replies.clear()
    await Promise.allSettled(posts.map((post) => post.close()))
  }

  /**
   * Mint an invite. Returns its wire form, a z32 string.
   *
   * @param {InviteOpts} [opts]
   * @returns {Promise<string>}
   */
  async invite({ role = '', ttl = 0, reuse = false, confirm = false, data = null } = {}) {
    if (this.closing || this.closed) throw CeroError.CLOSED('Pairing')
    if (!this.opened) await this.ready()
    // an invite is a capability: capped at our own rank, or apply would drop the mismatch silently
    if (role) await this._checkGrant(role)
    // a rank above member is handed out once
    if (reuse && !grants('member', role || 'member')) {
      throw CeroError.INVALID(`a reusable invite admits at most member, not '${role}'`)
    }

    const invite = Invite.create({ ttl, data, key: this.db.key, address: this.db.address })
    await this.db.call('add-invite', {
      id: b4a.toHex(invite.id),
      role,
      reuse,
      confirm,
      expires: invite.expires,
      createdAt: Date.now()
    })
    invite.link = { key: this.db.writerKey, length: this.db.length }
    await this._sync()
    return invite.toString()
  }

  /**
   * Revoke an invite, for every member. Needs the remove permission.
   *
   * @param {string} invite
   * @returns {Promise<boolean>}  Whether it was live.
   */
  async revoke(invite) {
    if (this.closing || this.closed) throw CeroError.CLOSED('Pairing')
    if (!this.opened) await this.ready()
    // apply refuses a revoke below REMOVE
    const me = await this._me()
    if (me && !can(me.role, REMOVE)) {
      throw CeroError.DENIED(null, 'revoking an invite needs the remove permission')
    }
    const id = getInviteId(invite)
    if (!id || !(await this.db.get('invites', id)).data) return false
    await this.db.call('del-invite', { id })
    await this._sync()
    return true
  }

  // follow the log: the invites that ran out, the joins waiting for a member, the keys owed
  async _sync() {
    const me = await this._me()
    const { data: invites } = await this.db.get('invites')
    const { data: requests } = await this.db.get('requests')
    if (this.closing || this.closed) return
    const role = me?.role
    // apply has no clock: past its expiry an invite is dropped here, so the log stops admitting
    if (can(role, REMOVE)) {
      for (const row of invites.filter(expired)) {
        await this.db.call('del-invite', { id: row.id }).catch(safetyCatch)
      }
    }
    this._arm([...invites, ...requests])
    const inviter = can(role, INVITE)
    const owed = inviter ? requests.filter((row) => row.admitted) : []
    this._candidates(inviter ? requests.filter((row) => !row.admitted) : [], invites)
    await this._answer(owed, role)
    this.serving = inviter && (invites.some((row) => !expired(row)) || owed.length > 0)
    this.emit('serving', this.serving)
  }

  // wakes the next _sync at the nearest expiry
  _arm(rows) {
    clearTimeout(this._expiry)
    const next = Math.min(
      ...rows.filter((row) => row.expires > Date.now()).map((row) => row.expires)
    )
    if (!Number.isFinite(next)) return
    this._expiry = setTimeout(
      () => this._sync().catch(safetyCatch),
      Math.min(next - Date.now(), MAX_DELAY)
    )
  }

  _candidates(rows, invites) {
    const live = new Set(rows.map((row) => row.id))
    // settled elsewhere: accepted or denied by another member, or its invite revoked
    for (const [id, request] of this._requests) {
      if (live.has(id)) continue
      this._requests.delete(id)
      this.pending.delete(request)
    }
    for (const row of rows) {
      const invite = invites.find((i) => i.id === row.invite)
      if (!invite || this._requests.has(row.id)) continue
      const request = new Request({ pairing: this, invite, row })
      this._requests.set(row.id, request)
      this.pending.add(request)
      this.emit('candidate', request)
    }
  }

  // an admitted joiner is offered its keys by every inviter device online, until one is read.
  // Past the invite's expiry the joiner has given up: a member who can remove drops it instead
  async _answer(rows, role) {
    const owed = new Set(rows.map((row) => row.id))
    for (const [id, post] of this._replies) {
      if (owed.has(id)) continue
      this._replies.delete(id)
      post.close().catch(safetyCatch)
    }
    for (const row of rows) {
      if (this._replies.has(row.id)) continue
      if (!expired(row)) {
        this._reply(row)
        continue
      }
      if (can(role, REMOVE)) {
        await this.db.call('del-member', { id: hid.encode(row.identity) }).catch(safetyCatch)
      }
    }
  }

  // kept in memory, not in the outbox: the admission in the log is what outlives a restart
  _reply({ id, reply }) {
    const { network } = this.mailbox
    const keys = {
      status: STATUS_ACCEPTED,
      reason: '',
      key: this.db.key,
      encryptionKey: this.db.encryptionKey,
      epochs: this.db.keyring.all()
    }
    const post = new Post(network, reply, c.encode(Response, keys), { mirrors: network.mirrors })
    this._replies.set(id, post)
    const settle = async () => {
      await post.ready()
      await post.delivered
      await this.db.call('del-request', { id })
    }
    settle().catch(safetyCatch)
  }

  async _me() {
    return (await this.db.get('members', this.db.identity.id)).data
  }

  // `grants` treats an unknown role as "no", so an app role name must fail loudly
  async _checkGrant(role) {
    if (!isRank(role)) {
      throw CeroError.INVALID(`role '${role}' is not a rank (owner, admin, member, reader)`)
    }
    const me = await this._me()
    // no member row yet = genesis, nothing to cap
    if (me && !grants(me.role, role)) {
      throw CeroError.DENIED(null, `role '${role}' exceeds your own role '${me.role}'`)
    }
  }

  /**
   * Join with an invite: write the join into the writer's own core, announce it to the
   * database's peers, and resolve with the database's keys once a member replies.
   *
   * @param {Mailbox} mailbox
   * @param {string} invite
   * @param {JoinOpts} opts
   * @returns {Promise<JoinResult>}
   */
  static async join(
    mailbox,
    invite,
    { identity, spec, writer = crypto.keyPair(), timeout = 30000, signal = null } = {}
  ) {
    if (!mailbox) throw CeroError.REQUIRED('mailbox')
    if (typeof identity?.sign !== 'function') throw CeroError.REQUIRED('identity')
    if (!spec?.dispatch) throw CeroError.REQUIRED('spec')
    if (writer?.publicKey?.byteLength !== 32 || writer.secretKey?.byteLength !== 64) {
      throw CeroError.INVALID('writer must be a keypair')
    }
    const parsed = Invite.parse(invite)
    if (parsed.expired) throw CeroError.EXPIRED()
    if (mailbox.closing || mailbox.closed) throw CeroError.CLOSED('join')
    if (!mailbox.opened) await mailbox.ready()

    let resolve, fail
    const answered = new Promise((res, rej) => {
      resolve = res
      fail = rej
    })
    const onreply = (message) => {
      const response = decode(Response, message)
      if (response?.status === STATUS_DENIED) fail(CeroError.DENIED(response.reason || null))
      else if (response?.key && b4a.equals(response.key, parsed.key)) {
        const { key, encryptionKey, epochs } = response
        resolve({ key, encryptionKey, epochs: epochs || [], writer })
      }
    }

    // in the network's store, which every connection replicates: open the database from it
    const { network } = mailbox
    const { store } = network
    const core = store.get({
      keyPair: writer,
      manifest: { version: store.manifestVersion, signers: [{ publicKey: writer.publicKey }] }
    })
    const inbox = mailbox.receive(writer.secretKey, onreply)
    // the database pulls the join in like any optimistic append, from us or from a mirror
    const post = new Post(network, parsed.key, null, { core, mirrors: network.mirrors })

    const onabort = () => fail(CeroError.CLOSED('join'))
    if (signal?.aborted) onabort()
    signal?.addEventListener('abort', onabort)
    mailbox.once('close', onabort)
    const timer = timeout > 0 ? setTimeout(() => fail(CeroError.TIMEOUT('join')), timeout) : null
    const left = parsed.expires - Date.now()
    // Node's setTimeout overflows past ~24.8 days: a longer ttl expires at the next resume
    const expiry =
      parsed.expires && left < MAX_DELAY ? setTimeout(() => fail(CeroError.EXPIRED()), left) : null
    write(core, spec, parsed, identity, writer)
      .then(() => post.ready())
      .catch((err) => fail(CeroError.NETWORK_ERROR(err.message)))
    try {
      return await answered
    } finally {
      clearTimeout(timer)
      clearTimeout(expiry)
      signal?.removeEventListener('abort', onabort)
      mailbox.off('close', onabort)
      await Promise.allSettled([inbox.close(), post.close()])
    }
  }
}

/**
 * A join's payload: sealed to the database's address, so only its members read who joins; proven
 * by the invite over the writer; signed by the joiner's identity for this writer and reply address.
 *
 * @param {Invite} invite
 * @param {import('../identity/index.js').Identity} identity
 * @param {Uint8Array} writer
 * @param {Uint8Array} reply
 * @returns {{ box: Uint8Array }}
 */
export function sealJoin(invite, identity, writer, reply) {
  const join = {
    invite: invite.id,
    reply,
    proof: invite.prove(writer),
    identity: identity.publicKey,
    signature: identity.sign(joining(invite.key, invite.id, writer, reply)),
    ts: Date.now()
  }
  return { box: crypto.encrypt(c.encode(Join, join), invite.address) }
}

// block 0 of the writer's core, once: a resumed join finds it there. Plain, since the joiner has
// no key yet, and linked to the invite's node, so no member applies it before the invite
async function write(core, spec, invite, identity, writer) {
  await core.ready()
  if (core.length > 0) return
  const { ns = NAMESPACE, version = 1 } = spec.meta || {}
  const payload = sealJoin(invite, identity, core.key, Mailbox.getAddress(writer.secretKey))
  const op = wrap(version, spec.dispatch.encode(`@${ns}/join`, payload))
  const links = [invite.link]
  await core.append(Autobee.encodeValue(op, { optimistic: true, encrypted: true, links }))
}

function expired({ expires }) {
  return expires > 0 && Date.now() > expires
}

// anyone can send to an address: what does not decode is dropped, never thrown
function decode(encoding, message) {
  try {
    return c.decode(encoding, message)
  } catch {
    return null
  }
}

function getInviteId(invite) {
  try {
    return b4a.toHex(Invite.parse(invite).id)
  } catch {
    return null
  }
}
