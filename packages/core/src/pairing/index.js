import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'

import { Invite } from './invite.js'
import { Request, Response, STATUS_DENIED } from './request.js'
import { Mailbox } from '../mailbox/index.js'
import { Post } from '../mailbox/post.js'
import { Identity } from '../identity/index.js'
import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'
import { can, grants, isRank, INVITE, REMOVE } from '../lib/utils.js'

const Knock = getEncoding('@cero/knock')
const NS_KNOCK = b4a.from('cero/knock')
const MAX_DELAY = 2 ** 31 - 1

/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array }} KeyPair
 *
 * @typedef {object} PairingOpts
 * @property {Mailbox} mailbox                      The device's mailbox: knocks are received there, replies sent from there.
 * @property {import('../database/index.js').Database} db  The database the invites open. Its `invites` collection holds them, so every member serves them.
 *
 * @typedef {object} InviteOpts
 * @property {string} [role]                        Role granted, at most your own.
 * @property {number | string} [ttl]                How long it is valid: ms, or `'12h'`, `'2d'`… Never expires when omitted.
 * @property {boolean} [reuse]                      Admit more than one joiner. Otherwise consumed by the first.
 * @property {Uint8Array | null} [data]             The app's payload in the invite, readable before joining: `Invite.parse(invite).data`.
 *
 * @typedef {object} Served                         An invite as the database keeps it.
 * @property {string} id                            The invite's id, hex.
 * @property {Uint8Array} secret                    Owns the address knocks arrive at; never the seed that proves one.
 * @property {string} role
 * @property {number} expires                       Absolute expiry; `0` never.
 * @property {boolean} reuse
 * @property {boolean} expired
 *
 * @typedef {object} JoinOpts
 * @property {Identity} identity                    Who joins: the member they become, and who signs the knock.
 * @property {KeyPair} [writer]                     Their writer keypair in the database, a fresh one by default. Its secret key owns the reply address: pass the same one to resume a join after a restart.
 * @property {number} [timeout]                     Deadline for the reply, in ms; `0` waits until the invite expires, or for good. Defaults to 30000.
 * @property {AbortSignal} [signal]                 Stops the join, rejecting it with `CLOSED`, as closing the mailbox does.
 *
 * @typedef {object} JoinResult
 * @property {Uint8Array} key
 * @property {Uint8Array | null} encryptionKey
 * @property {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} epochs
 * @property {KeyPair} writer                       The writer the member admitted: open the database with it.
 */

/**
 * Invites into a database. It keeps them in the database, so every member serves them; each
 * invite has its own address, and a knock there that proves both the invite and the joiner's
 * identity becomes a `candidate`, kept in the mailbox until it is accepted or denied.
 * `Pairing.join` is the other side: knock with an invite, wait for the reply.
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

    this._invites = new Map() // id → Served
    this._inboxes = new Map() // id → the inbox at that invite's address
    this._onupdate = (touched) => {
      if (touched.has('*') || touched.has('invites') || touched.has('members')) {
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
    const inboxes = [...this._inboxes.values()]
    this._invites.clear()
    this._inboxes.clear()
    await Promise.allSettled(inboxes.map((inbox) => inbox.close()))
  }

  /**
   * Mint an invite. Returns its wire form, a z32 string.
   *
   * @param {InviteOpts} [opts]
   * @returns {Promise<string>}
   */
  async invite({ role = '', ttl = 0, reuse = false, data = null } = {}) {
    if (this.closing || this.closed) throw CeroError.CLOSED('Pairing')
    if (!this.opened) await this.ready()
    // an invite is a capability: capped at our own rank, or apply would drop the mismatch silently
    if (role) await this._checkGrant(role)

    const secret = crypto.randomBytes(32)
    const invite = Invite.create({
      ttl,
      data,
      discoveryKey: crypto.discoveryKey(this.db.key),
      address: Mailbox.getAddress(secret),
      mirrors: this.mailbox.network.mirrors
    })
    const id = b4a.toHex(invite.id)
    await this.db.call('add-invite', {
      id,
      secret,
      role,
      reuse,
      expires: invite.expires,
      createdAt: Date.now()
    })
    await this._sync()
    return invite.toString()
  }

  /**
   * Stop serving an invite, on every member. Needs the remove permission.
   *
   * @param {string} invite
   * @returns {Promise<boolean>}  Whether it was served.
   */
  async revoke(invite) {
    if (this.closing || this.closed) throw CeroError.CLOSED('Pairing')
    if (!this.opened) await this.ready()
    // apply refuses a revoke below REMOVE, and every other member would keep serving it
    const me = await this._me()
    if (me && !can(me.role, REMOVE)) {
      throw CeroError.DENIED(null, 'revoking an invite needs the remove permission')
    }
    const id = getInviteId(invite)
    if (!this._invites.has(id)) return false
    await this.db.call('del-invite', { id })
    await this._sync()
    return true
  }

  // serve exactly the invites the database holds, while this member may invite
  async _sync() {
    const me = await this._me()
    const { data: rows } = can(me?.role, INVITE) ? await this.db.get('invites') : { data: [] }
    if (this.closing || this.closed) return
    const ids = new Set(rows.map((row) => row.id))
    for (const id of this._invites.keys()) if (!ids.has(id)) this._invites.delete(id)
    for (const row of rows) {
      if (this._invites.has(row.id)) continue
      const invite = served(row)
      if (!invite.expired) this._invites.set(row.id, invite)
    }
    this._syncInboxes()
  }

  // one inbox per served invite, at its address
  _syncInboxes() {
    for (const [id, inbox] of this._inboxes) {
      if (this._invites.has(id)) continue
      this._inboxes.delete(id)
      inbox.close().catch(safetyCatch)
    }
    for (const [id, invite] of this._invites) {
      if (this._inboxes.has(id)) continue
      this._inboxes.set(
        id,
        this.mailbox.receive(invite.secret, (knock) => this._onknock(knock))
      )
    }
  }

  // resolves once the knock is done with: dropped, or its candidate settled
  async _onknock(message) {
    const knock = decode(Knock, message)
    if (!knock || !Invite.proven(knock.id, knock.reply, knock.proof)) return
    if (!Identity.verify(knock.identity, claim(knock), knock.signature)) return
    const id = b4a.toHex(knock.id)
    const invite = this._invites.get(id)
    if (!invite) return
    if (invite.expired) {
      await this._consume(id)
      return
    }

    await new Promise((resolve) => {
      const request = new Request({
        pairing: this,
        invite,
        reply: knock.reply,
        identity: knock.identity,
        writer: knock.writer,
        onsettle: async () => {
          this.pending.delete(request)
          if (!invite.reuse) await this._consume(id)
          resolve()
        }
      })
      this.pending.add(request)
      this.emit('candidate', request)
    })
  }

  // a single-use invite is consumed by whichever member answered it
  async _consume(id) {
    this._invites.delete(id)
    this._syncInboxes()
    await this.db.call('del-invite', { id }).catch(safetyCatch)
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
   * Knock with an invite and resolve with the database's keys once a member accepts.
   *
   * @param {Mailbox} mailbox
   * @param {string} invite
   * @param {JoinOpts} opts
   * @returns {Promise<JoinResult>}
   */
  static async join(
    mailbox,
    invite,
    { identity, writer = crypto.keyPair(), timeout = 30000, signal = null } = {}
  ) {
    if (!mailbox) throw CeroError.REQUIRED('mailbox')
    if (typeof identity?.sign !== 'function') throw CeroError.REQUIRED('identity')
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
      else if (opens(response, parsed.discoveryKey)) resolve(keysOf(response, writer))
    }

    const reply = Mailbox.getAddress(writer.secretKey)
    const knock = {
      id: parsed.id,
      reply,
      proof: parsed.prove(reply),
      identity: identity.publicKey,
      writer: writer.publicKey
    }
    knock.signature = identity.sign(claim(knock))

    const { network } = mailbox
    const inbox = mailbox.receive(writer.secretKey, onreply)
    // held out until the reply lands, not until read: it keeps us on the mirror the reply goes
    // to. The invite's mirrors reach a database we know nothing of, ours reach it after it changed
    const mirrors = union(parsed.mirrors, network.mirrors)
    const post = new Post(network, parsed.address, c.encode(Knock, knock), { mirrors })

    const onabort = () => fail(CeroError.CLOSED('join'))
    if (signal?.aborted) onabort()
    signal?.addEventListener('abort', onabort)
    mailbox.once('close', onabort)
    const timer = timeout > 0 ? setTimeout(() => fail(CeroError.TIMEOUT('join')), timeout) : null
    const left = parsed.expires - Date.now()
    // Node's setTimeout overflows past ~24.8 days: a longer ttl expires at the next resume
    const expiry =
      parsed.expires && left < MAX_DELAY ? setTimeout(() => fail(CeroError.EXPIRED()), left) : null
    post.ready().catch((err) => fail(CeroError.NETWORK_ERROR(err.message)))
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
 * @param {Partial<Served> & { id: string, secret: Uint8Array }} row
 * @returns {Served}
 */
function served({ id, secret, role = '', expires = 0, reuse = false }) {
  return {
    id,
    secret,
    role,
    expires,
    reuse,
    get expired() {
      return this.expires > 0 && Date.now() > this.expires
    }
  }
}

// what the joiner's identity signs: this invite, this writer, this reply address
function claim({ id, writer, reply }) {
  return crypto.hash([NS_KNOCK, id, writer, reply])
}

// the reply must open the database the invite names, not one a replier picked
function opens(response, discoveryKey) {
  return !!response?.key && b4a.equals(crypto.discoveryKey(response.key), discoveryKey)
}

function keysOf({ key, encryptionKey, epochs }, writer) {
  return { key, encryptionKey, epochs: epochs || [], writer }
}

function union(keys, more) {
  return [...keys, ...more.filter((key) => !keys.some((k) => b4a.equals(k, key)))]
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
