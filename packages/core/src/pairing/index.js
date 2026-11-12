import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import hid from 'hypercore-id-encoding'
import Autobee from 'autobee'

import { Invite, STAMPED } from './invite.js'
import {
  Response,
  STATUS_ACCEPTED,
  STATUS_DENIED,
  tag,
  proven,
  signed,
  signer
} from './response.js'
import { Mailbox } from '../mailbox/index.js'
import { Post } from '../mailbox/post.js'
import { wrap } from '../database/envelope.js'
import { chainOf, linkOf } from '../database/dispatch.js'
import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'
import { can, grants, isRank, isOptions, joining, INVITE, REMOVE } from '../lib/utils.js'
import { NAMESPACE, MEMBER, REFUSALS, SPENT, ASKS } from '../lib/constants.js'

const Join = getEncoding('@cero/join')
// what a sync follows in the log
const WATCHED = ['*', 'invites', 'requests', 'members', 'devices', ASKS]
const MAX_DELAY = 2 ** 31 - 1

/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array }} KeyPair
 *
 * @typedef {object} PairingOpts
 * @property {Mailbox} mailbox                      The device's mailbox: replies are sent from there.
 * @property {import('../database/index.js').Database} db  The database the invites open. Its `invites` collection holds them, and apply admits their joins.
 *
 * @typedef {object} InviteOpts
 * @property {string} [role]                        Role granted, at most your own. Member by default.
 * @property {number | string} [ttl]                How long it is valid: ms, or `'12h'`, `'2d'`… Never expires when omitted.
 * @property {boolean} [reuse]                      Admit more than one joiner. Otherwise spent by the first.
 * @property {boolean} [confirm]                    Its joins wait for a member to accept them, as requests.
 * @property {Uint8Array | null} [data]             The app's payload in the invite, readable before joining: `Invite.parse(invite).data`.
 *
 * @typedef {object} AcceptOpts
 * @property {string} [role]                        Role granted: the invite's by default, at most the invite's.
 * @property {Uint8Array | null} [proof]            The joiner's chain to your identity, from `identity.link`: it joins as a device of yours, not as a member.
 *
 * @typedef {object} JoinOpts
 * @property {import('../identity/index.js').Identity} identity  Who joins: the member they become, and who signs the join.
 * @property {{ dispatch: { encode: Function }, meta?: { ns?: string, version?: number, start?: number, encoding?: Record<string, number> } }} spec  The database's spec: the join is one of its ops.
 * @property {KeyPair} [writer]                     Their writer keypair in the database, a fresh one by default. The join is its first block and its secret key owns the reply address: pass the same one to resume a join after a restart.
 * @property {number} [timeout]                     Deadline for the reply, in ms; `0` waits until the invite expires, or for good. Defaults to 30000.
 * @property {AbortSignal} [signal]                 Stops the join, rejecting it with `CLOSED`, as closing the mailbox does.
 * @property {(answer: JoinResult | Error) => Promise<unknown>} [keep]  Saves the answer, the keys or the `DENIED`, before the join settles: the reply stays in the mailbox until it resolves, so a join resumed with the same writer after a crash gets it again.
 *
 * @typedef {object} JoinResult
 * @property {Uint8Array} key
 * @property {Uint8Array | null} encryptionKey
 * @property {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} epochs
 * @property {KeyPair} writer                       The writer the join admitted: open the database with it.
 * @property {Uint8Array | null} proof              A device's chain to the identity it was linked under, null for a member.
 */

/**
 * Invites into a database. An invite is a record in the database; a joiner writes one signed
 * `join` op into its own writer core and announces it to the database's peers, and apply admits
 * it. The admission stays in the database until the joiner has its keys: every device of a member
 * that may invite offers them while online, and the first one read settles it for all. Under an
 * invite with an address of its own, being let in is a promise: no member and no seat until a device
 * of the joiner, holding the keys, claims its seat. Its keys are offered until a member that may
 * invite sees that device seated and settles the promise, or until the invite expires, whoever
 * reads them. A join
 * turned away with an invite the database knows, spent, revoked or older than the joiner's
 * removal, is answered the same way with `DENIED` and the reason. A `confirm` invite's joins wait
 * as rows of `requests` until a member accepts or denies one by its id.
 * Where the database's version keeps an invite's secret on its record, the invite has an address
 * of its own: its joins are sealed to it, and its answers follow the tag only that secret and the
 * joiner's reply address make. Elsewhere an invite carries the database's address.
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
    /** Whether this device answers the database's joins: it may invite, and invites or joiners owed an answer exist. */
    this.serving = false

    /** @private */
    this._replies = new Map() // writer id → the Post offering its keys
    /** @private */
    this._denials = new Map() // writer id → the Post telling why its join was turned away
    /** @private */
    this._keys = new Map() // writer id → the Post sending a device the keys it asked for
    /** @private */
    this._inbox = null
    /** @private */
    this._expiry = null
    /** @private */
    this._onupdate = (touched) => {
      if (WATCHED.some((name) => touched.has(name))) this._sync().catch(safetyCatch)
    }
    /** @private */
    this._onepoch = () => this._sync().catch(safetyCatch)
  }

  /** @private */
  async _open() {
    await this.mailbox.ready()
    await this.db.ready()
    await this._sync()
    this.db.on('update', this._onupdate)
    this.db.on('epoch', this._onepoch)
  }

  /** @private */
  async _close() {
    this.db.off('update', this._onupdate)
    this.db.off('epoch', this._onepoch)
    clearTimeout(this._expiry)
    this._expiry = null
    const posts = [...this._replies.values(), ...this._denials.values(), ...this._keys.values()]
    if (this._inbox) posts.push(this._inbox)
    this._replies.clear()
    this._denials.clear()
    this._keys.clear()
    this._inbox = null
    await Promise.allSettled(posts.map((post) => post.close()))
  }

  /**
   * Mint an invite. Returns its wire form, a z32 string.
   *
   * @param {InviteOpts} [opts]
   * @returns {Promise<string>}
   */
  async invite(opts = {}) {
    if (!isOptions(opts)) throw CeroError.INVALID('invite options are an object')
    const { role = MEMBER, ttl = 0, reuse = false, confirm = false, data = null } = opts
    if (this.closing || this.closed) throw CeroError.CLOSED('Pairing')
    if (!this.opened) await this.ready()
    // an invite is a capability: capped at our own rank, or apply would drop the mismatch silently
    await this._checkGrant(role)
    // a rank above member is handed out once
    if (reuse && !grants(MEMBER, role)) {
      throw CeroError.INVALID(`a reusable invite admits at most member, not '${role}'`)
    }

    const secret = await this._secret()
    const address = secret ? Mailbox.getAddress(secret) : this.db.address
    const invite = Invite.create({ ttl, data, key: this.db.key, address, own: !!secret })
    const row = {
      id: b4a.toHex(invite.id),
      role,
      reuse,
      confirm,
      expires: invite.expires,
      createdAt: Date.now(),
      secret
    }
    invite.stamp = await this.db.write([['add-invite', row]])
    if (secret || invite.stamp > this.db.start) invite.version = STAMPED
    invite.link = { key: this.db.writerKey, length: this.db.length }
    await this._sync()
    return invite.toString()
  }

  // an invite's own address needs its secret on its row: none where the built spec has no such
  // field, or the database's version has not reached it, and the invite carries the room's address
  /** @private */
  async _secret() {
    const since = this.db.meta.since?.types[`@${this.db.ns}/invite`]?.secret
    const version = await this.db.dispatcher.version(this.db.view)
    return since <= version ? crypto.randomBytes(32) : null
  }

  /**
   * Revoke an invite, for every member. Needs the remove permission.
   *
   * @param {string} invite  The code, or the id its `invites` row holds.
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
    const id = (await this.db.get('invites', invite)).data ? invite : getInviteId(invite)
    if (!id || !(await this.db.get('invites', id)).data) return false
    await this.db.call('del-invite', { id })
    await this._sync()
    return true
  }

  /**
   * Admit a join waiting on a `confirm` invite, by its id in `requests`. Every device of an
   * inviter then replies with the keys.
   *
   * @param {string} id
   * @param {AcceptOpts} [opts]
   * @returns {Promise<void>}
   */
  async accept(id, { role, proof = null } = {}) {
    const invite = await this._waiting(id)
    // apply has no clock: it would admit past the expiry
    if (expired(invite)) throw CeroError.EXPIRED()
    role = role || invite.role
    if (!isRank(role)) {
      throw CeroError.INVALID(`role '${role}' is not a rank (owner, admin, member, reader)`)
    }
    if (!grants(invite.role, role)) {
      throw CeroError.INVALID(`role '${role}' exceeds the invite role '${invite.role}'`)
    }
    await this.db.call('accept', { id, role, proof })
  }

  /**
   * Refuse a join waiting on a `confirm` invite, by its id in `requests`, with an optional reason.
   * On a join already let in by a promise, it withdraws the promise: that needs the remove
   * permission.
   *
   * @param {string} id
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async deny(id, reason = '') {
    const { data: row } = await this.db.get('requests', id)
    if (!row?.promised) await this._waiting(id)
    await this.db.call('deny', { id, reason })
  }

  // the invite of a join nobody has answered yet
  /** @private */
  async _waiting(id) {
    const { data: row } = await this.db.get('requests', id)
    const invite = row && !row.admitted && (await this.db.get('invites', row.invite)).data
    if (!invite) throw CeroError.UNKNOWN('request', id)
    return invite
  }

  // follow the log: the invites that ran out, the answers owed
  /** @private */
  async _sync() {
    const me = await this._me()
    const { data: invites } = await this.db.get('invites')
    const { data: requests } = await this.db.get('requests')
    const refusals = await this._list(REFUSALS)
    const spent = await this._list(SPENT)
    if (this.closing || this.closed) return
    const role = me?.role
    // behind, this device's view of the room is stale: it answers no join until it updates
    const inviter = can(role, INVITE) && this.db.behind === null
    // a promise is settled here once it is kept or void, never by a read of its keys
    const done = inviter ? await this._done(requests) : []
    for (const { id } of done) await this.db.call('del-request', { id }).catch(safetyCatch)
    // apply has no clock: past its invite, a promise nobody kept is withdrawn here
    if (inviter && can(role, REMOVE)) {
      for (const row of requests) {
        if (!row.promised || !expired(row)) continue
        await this.db.call('deny', { id: row.id, reason: 'expired' }).catch(safetyCatch)
      }
    }
    // past its expiry an invite is dropped, so the log stops admitting, and a spent one
    // forgotten, since no joiner uses it past then
    if (can(role, REMOVE)) {
      for (const row of [...invites, ...spent].filter(expired)) {
        await this.db.call('del-invite', { id: row.id }).catch(safetyCatch)
      }
    }
    this._arm([...invites, ...requests, ...spent])
    // an admission is owed its keys until they are read; a promise, until done or past its invite
    const over = (row) => row.promised && (done.includes(row) || expired(row))
    const owed = inviter ? requests.filter((row) => row.admitted && !over(row)) : []
    const refused = inviter ? refusals : []
    const secrets = new Map([...invites, ...spent].map((row) => [row.id, row.secret]))
    await this._answer(owed, refused, role, secrets)
    await this._deliver(await this._list(ASKS))
    const live = invites.some((row) => !expired(row))
    this.serving = inviter && (live || owed.length > 0 || refused.length > 0)
    this.emit('serving', this.serving)
  }

  // the promises kept, the device each was made to sits under the member it was made to, and
  // those void, their chain standing no more as the log reads it
  /** @private */
  async _done(requests) {
    const promised = requests.filter((row) => row.promised)
    if (promised.length === 0) return []
    const { data: devices } = await this.db.get('devices')
    const seated = ({ identity, key }) => {
      const id = hid.encode(identity)
      return devices.some((d) => d.memberId === id && d.key && b4a.equals(d.key, key))
    }
    this.db.guard()
    const { dispatcher, view } = this.db
    const done = []
    for (const row of promised) {
      const stands = await dispatcher.stands(view, [row.identity, ...chainOf(row)])
      if (!stands || seated(row)) done.push(row)
    }
    return done
  }

  // wakes the next _sync just past the nearest expiry: expired() only holds after it
  /** @private */
  _arm(rows) {
    clearTimeout(this._expiry)
    this._expiry = null
    // a sync that awaited past close arms nothing: _close cleared the timer already
    if (this.closing || this.closed) return
    const live = rows.filter((row) => row.expires > 0 && !expired(row))
    const next = Math.min(...live.map((row) => row.expires))
    if (!Number.isFinite(next)) return
    this._expiry = setTimeout(
      () => this._sync().catch(safetyCatch),
      Math.min(next - Date.now() + 1, MAX_DELAY)
    )
  }

  // an admitted joiner is offered its keys, and a refused one the reason, by every inviter device
  // online, until one is read. Past the invite's expiry the joiner has given up: the answer owed to
  // an extra device of a member is dropped, a member who can remove drops a new one, and a refused
  // one is forgotten. A promised joiner is offered its keys until its device has seated itself: a
  // read settles nothing. An answer under an invite that has a secret is tagged with it
  /** @private */
  async _answer(owed, refused, role, secrets) {
    // a device linked under a member reads its chain off its seat, or off the promise of one
    const proofs = new Map()
    for (const { id, promised, proof } of owed) {
      const chain = promised ? linkOf(proof) : (await this.db.get('devices', id)).data?.proof
      proofs.set(id, chain ?? null)
    }
    const keys = ({ id }) => ({
      status: STATUS_ACCEPTED,
      reason: '',
      key: this.db.key,
      encryptionKey: this.db.encryptionKey,
      epochs: this.db.keyring.all(),
      proof: proofs.get(id)
    })
    const denied = ({ reason }) => ({
      status: STATUS_DENIED,
      reason,
      key: null,
      encryptionKey: null,
      epochs: null
    })
    const sealed = (answer) => (row) => seal(answer(row), secrets.get(row.invite), row.reply)
    // only a device that read its keys covers another: unread ones would keep each other in
    const unread = new Map(owed.map((row) => [row.id, row]))
    for (const row of this._offer(this._replies, owed, sealed(keys), 'del-request')) {
      const id = hid.encode(row.identity)
      const { data: devices } = await this.db.get('devices')
      const others = devices.filter((d) => d.memberId === id && d.id !== row.id)
      if (others.some((d) => !unread.has(d.id))) {
        await this.db.call('del-request', { id: row.id }).catch(safetyCatch)
      } else if (others.every((d) => expired(unread.get(d.id))) && can(role, REMOVE)) {
        await this.db.call('del-member', { id }).catch(safetyCatch)
      }
    }
    for (const row of this._offer(this._denials, refused, sealed(denied), 'del-refusal')) {
      await this.db.call('del-refusal', { id: row.id }).catch(safetyCatch)
    }
  }

  // a device that asked for the keys it lacks is sent them by every seated device that holds any,
  // inviter or not, and again once that one learns another. Nothing is settled by it: the device
  // that asked closes its own row, once it opens the newest key
  /** @private */
  async _deliver(asks) {
    // a sync that awaited past close sends and receives nothing: _close closed them already
    if (this.closing || this.closed) return
    const { db } = this
    const me = hid.encode(db.writerKey)
    const epochs = db.keyring.all()
    const seats = asks.length > 0 && db.behind === null ? await this._seats() : new Set()
    const sends = epochs.length > 0 && seats.has(me)
    const rows = asks
      .filter((row) => sends && row.id !== me && seats.has(row.id))
      // offered again when what this device holds changed
      .map(({ id, reply }) => ({ id, reply, invite: epochs.length, promised: true, expires: 0 }))
    const keys = { status: STATUS_ACCEPTED, reason: '', key: db.key, encryptionKey: null, epochs }
    const answer = c.encode(Response, keys)
    const { secretKey } = db.identity.device
    const sign = (row) =>
      signed(answer, { room: db.key, to: hid.decode(row.id), writer: db.writerKey, secretKey })
    this._offer(this._keys, rows, sign, null)

    const mine = asks.some((row) => row.id === me)
    if (mine && !this._inbox) {
      const onkeys = (message) => this._onkeys(message)
      this._inbox = this.mailbox.receive(db.keyPair.secretKey, onkeys, { keep: false })
    } else if (!mine && this._inbox) {
      this._inbox.close().catch(safetyCatch)
      this._inbox = null
    }
    if (mine && !(await db.rotation.lacks())) {
      await db.call('del-owed', { id: me }).catch(safetyCatch)
    }
  }

  // the device key of a writer seated here, of a member who stands, or null
  /** @private */
  async _seat(writer) {
    const { data: device } = await this.db.get('devices', hid.encode(writer))
    if (!device?.memberId) return null
    const { data: member } = await this.db.get('members', device.memberId)
    return member ? device.key : null
  }

  // the devices of the members who stand, by id, to the device key each was admitted with
  /** @private */
  async _seats() {
    const { data: members } = await this.db.get('members')
    const { data: devices } = await this.db.get('devices')
    const standing = new Set(members.map((m) => m.id))
    return new Map(devices.filter((d) => standing.has(d.memberId)).map((d) => [d.id, d.key]))
  }

  // the keys this device asked for, signed by a device seated here: anyone with the address can
  // send to it. Each secret is held to its commitment in the log and saved, and the row is closed
  // once the newest opens
  /** @private */
  async _onkeys(message) {
    const { db } = this
    // one row, the sender's own: a stranger who sends to the address costs no read of every seat
    const seated = message.byteLength > 32 ? await this._seat(message.subarray(0, 32)) : null
    const sent = signer(message, { room: db.key, to: db.writerKey }, () => seated)
    const answer = sent && decode(Response, sent.answer)
    if (!answer?.epochs) return false
    await db.learn(answer.epochs, hid.encode(sent.writer))
    await this._sync()
  }

  // posts each live row its answer once, closes those settled elsewhere or made for a row since
  // written again under another invite, returns those past expiry
  /** @private */
  _offer(posts, rows, answer, settled) {
    const live = new Map(rows.map((row) => [row.id, row.invite]))
    for (const [id, post] of posts) {
      if (live.has(id) && live.get(id) === post.invite) continue
      posts.delete(id)
      post.close().catch(safetyCatch)
    }
    const gone = []
    for (const row of rows) {
      if (!expired(row)) {
        if (!posts.has(row.id)) this._post(posts, row, answer(row), row.promised ? null : settled)
        continue
      }
      // a device already offering it stops: nobody waits for it any more
      posts.get(row.id)?.close().catch(safetyCatch)
      posts.delete(row.id)
      gone.push(row)
    }
    return gone
  }

  // kept in memory, not in the outbox: the row in the log is what outlives a restart
  /** @private */
  _post(posts, { id, reply, invite }, answer, settled) {
    const { network } = this.mailbox
    const post = new Post(network, reply, answer, { mirrors: network.mirrors })
    // the invite its answer is tagged under
    post.invite = invite
    posts.set(id, post)
    const settle = async () => {
      await post.ready()
      // a promise is kept by its device's own claim: whoever reads the keys, nothing is settled
      if (!settled) return
      await post.delivered
      await this.db.call(settled, { id })
    }
    settle().catch(safetyCatch)
  }

  /** @private */
  _list(name) {
    // a sync still running once its database closed ends as closed, as its other reads do
    this.db.guard()
    return this.db.view.find(`@${this.db.ns}/${name}`, {}).toArray()
  }

  /** @private */
  async _me() {
    return (await this.db.get('members', this.db.identity.id)).data
  }

  // `grants` treats an unknown role as "no", so an app role name must fail loudly
  /** @private */
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
    {
      identity,
      spec,
      writer = crypto.keyPair(),
      timeout = 30000,
      signal = null,
      keep = async () => {}
    } = {}
  ) {
    if (!mailbox) throw CeroError.REQUIRED('mailbox')
    if (typeof identity?.sign !== 'function') throw CeroError.REQUIRED('identity')
    if (!spec?.dispatch) throw CeroError.REQUIRED('spec')
    if (writer?.publicKey?.byteLength !== 32 || writer.secretKey?.byteLength !== 64) {
      throw CeroError.INVALID('writer must be a keypair')
    }
    const parsed = Invite.parse(invite)
    if (parsed.expired) throw CeroError.EXPIRED()
    // an invite with its own address proves its answers: one without a valid tag is nobody's
    const mine = parsed.own ? Mailbox.keyPair(writer.secretKey) : null
    // an invite with no stamp was minted before invites carried one: at the start
    const { version = 1, start = 1 } = spec.meta || {}
    const stamp = parsed.stamp || start
    if (stamp > version) throw CeroError.BEHIND(stamp)
    if (mailbox.closing || mailbox.closed) throw CeroError.CLOSED('join')
    if (!mailbox.opened) await mailbox.ready()

    let resolve, fail
    const answered = new Promise((res, rej) => {
      resolve = res
      fail = rej
    })
    let settling = false
    let expired = false
    const settle = async (answer, done) => {
      settling = true
      try {
        await keep(answer)
      } catch (err) {
        settling = false
        if (expired) stop(CeroError.EXPIRED())
        throw err
      }
      done(answer)
    }
    // anything else sealed to the reply address, a second answer too, is turned away: the inbox
    // keeps no row of it, and its core only when it was read back from a row kept across a restart
    const onreply = async (message) => {
      if (settling) return false
      const answer = mine ? proven(message, mine.secretKey, parsed.address) : message
      const response = answer && decode(Response, answer)
      if (response?.status === STATUS_DENIED) {
        await settle(CeroError.DENIED(response.reason || null), fail)
      } else if (
        response?.key &&
        b4a.equals(response.key, parsed.key) &&
        (mine || owns(response, parsed))
      ) {
        const { key, encryptionKey, epochs, proof = null } = response
        await settle({ key, encryptionKey, epochs: epochs || [], writer, proof }, resolve)
      } else {
        return false
      }
    }

    // in the network's store, which every connection replicates: open the database from it
    const { network } = mailbox
    const { store } = network
    const core = store.get({
      keyPair: writer,
      manifest: { version: store.manifestVersion, signers: [{ publicKey: writer.publicKey }] }
    })
    // a reply read no longer than the join waits for it
    const reads = timeout > 0 ? { timeout: Math.min(timeout, 30000) } : {}
    const inbox = mailbox.receive(writer.secretKey, onreply, { keep: false, ...reads })
    // the database pulls the join in like any optimistic append, from us or from a mirror
    const post = new Post(network, parsed.key, null, { core, mirrors: network.mirrors })

    // its inbox closes the moment it stops, so one that joins again at once with this writer waits for the row
    // a reply being read may yet leave
    const stop = (err) => {
      inbox.close().catch(safetyCatch)
      fail(err)
    }
    const onabort = () => stop(CeroError.CLOSED('join'))
    if (signal?.aborted) onabort()
    signal?.addEventListener('abort', onabort)
    mailbox.once('close', onabort)
    const timer = timeout > 0 ? setTimeout(() => stop(CeroError.TIMEOUT('join')), timeout) : null
    // a reply being kept as the invite runs out settles the join: the device it answers is let in
    const expire = () => {
      expired = true
      if (!settling) stop(CeroError.EXPIRED())
    }
    const left = parsed.expires - Date.now()
    // Node's setTimeout overflows past ~24.8 days: a longer ttl expires at the next resume
    const expiry = parsed.expires && left < MAX_DELAY ? setTimeout(expire, left) : null
    write(core, spec, stamp, parsed, identity, writer)
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

  /**
   * Take back a join that waits for a member: the writer's own core says so after its join, and
   * the database drops the request unless a member let it in first. Announced as the join was.
   * Called again with the same writer, it announces the cancel already written.
   *
   * @param {Mailbox} mailbox
   * @param {string} invite
   * @param {{ spec: JoinOpts['spec'], writer: KeyPair }} opts  The writer that joined.
   * @returns {Promise<void>}  Resolves once a peer or a mirror holds it, rejects `CLOSED` when the mailbox closes first.
   */
  static async cancel(mailbox, invite, { spec, writer }) {
    if (mailbox.closing || mailbox.closed) throw CeroError.CLOSED('cancel')
    const { network } = mailbox
    const { store } = network
    let onclose = null
    const closed = new Promise((resolve, reject) => {
      onclose = () => reject(CeroError.CLOSED('cancel'))
    })
    closed.catch(safetyCatch)
    mailbox.once('close', onclose)
    const core = store.get({
      keyPair: writer,
      manifest: { version: store.manifestVersion, signers: [{ publicKey: writer.publicKey }] }
    })
    let post = null
    try {
      await core.ready()
      // a writer that wrote no join has nothing to take back
      if (core.length === 0) return
      // stamped as the join was: a room older than the cancel skips it on every build, and none
      // of its devices is put behind
      const { ns = NAMESPACE, start = 1, encoding } = spec.meta || {}
      const parsed = Invite.parse(invite)
      const stamp = parsed.stamp || start
      const id = hid.encode(core.key)
      let appending = cancels.get(id)
      if (!appending) {
        const body = spec.dispatch.encode(
          `@${ns}/cancel-join`,
          { id },
          { version: encoding?.[stamp] }
        )
        appending = retract(core, wrap(stamp, body)).finally(() => cancels.delete(id))
        cancels.set(id, appending)
      }
      await appending
      post = new Post(network, parsed.key, null, { core, mirrors: network.mirrors })
      await Promise.race([post.ready().then(() => post.delivered), closed])
    } finally {
      mailbox.off('close', onclose)
      await (post || core).close().catch(safetyCatch)
    }
  }
}

/**
 * A join's payload: sealed to the invite's address, so only those who hold its row read who joins,
 * every member for an invite that carries the database's address; proven by the invite over the
 * writer; signed by the joiner's device, under its chain to the identity, for this writer and reply
 * address. An invite with an address of its own is named in the clear, so apply finds its secret.
 *
 * @param {Invite} invite
 * @param {import('../identity/index.js').Identity} identity
 * @param {Uint8Array} writer
 * @param {Uint8Array} reply
 * @returns {{ box: Uint8Array, invite?: Uint8Array }}
 */
export function sealJoin(invite, identity, writer, reply) {
  const join = {
    invite: invite.id,
    reply,
    signature: invite.prove(writer),
    proof: identity.sign(joining(invite.key, invite.id, writer, reply)),
    ts: Date.now()
  }
  const box = crypto.encrypt(c.encode(Join, join), invite.address)
  return invite.own ? { box, invite: invite.id } : { box }
}

// the cancel being appended, by writer: two at once on one writer append it once
const cancels = new Map()

async function retract(core, op) {
  const at = await core.getUserData('cero/cancel')
  if (at && c.decode(c.uint, at) === core.length) return
  await core.append(Autobee.encodeValue(op, { optimistic: true, encrypted: true }))
  await core.setUserData('cero/cancel', c.encode(c.uint, core.length))
}

// one join per invite in the writer's core: a resumed join finds its own, a fresh invite adds
// another. Plain, since the joiner has no key yet, and linked to the invite's node, so no member
// applies it before the invite. Written as of its invite's stamp
async function write(core, spec, stamp, invite, identity, writer) {
  await core.ready()
  const last = await core.getUserData('cero/join')
  if (last && b4a.equals(last, invite.id)) return
  const { ns = NAMESPACE, encoding } = spec.meta || {}
  const payload = sealJoin(invite, identity, core.key, Mailbox.getAddress(writer.secretKey))
  const body = spec.dispatch.encode(`@${ns}/join`, payload, { version: encoding?.[stamp] })
  const op = wrap(stamp, body)
  const links = [invite.link]
  await core.append(Autobee.encodeValue(op, { optimistic: true, encrypted: true, links }))
  await core.setUserData('cero/join', invite.id)
}

// the database key is no secret, every mirror holds it: the encryption key must own the invite's address
function owns({ encryptionKey }, invite) {
  return !!encryptionKey && b4a.equals(Mailbox.getAddress(encryptionKey), invite.address)
}

// an answer under an invite with a secret follows the tag it makes with the reply address
function seal(answer, secret, reply) {
  const message = c.encode(Response, answer)
  const proof = secret ? tag(message, Mailbox.keyPair(secret).secretKey, reply) : null
  return proof ? b4a.concat([proof, message]) : message
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
