import Hypercore from 'hypercore'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'
import c from 'compact-encoding'

import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'
import { grants, isRank, admission } from '../lib/utils.js'

export const STATUS_ACCEPTED = 0
export const STATUS_DENIED = 1

// an accept and a deny both ride this response
export const Response = getEncoding('@cero/confirm')

/**
 * @typedef {object} RequestOpts
 * @property {import('./index.js').Pairing} pairing                  Owning Pairing instance.
 * @property {import('./index.js').Served} invite                    Invite the joiner knocked with.
 * @property {Uint8Array} reply                                      The joiner's reply address.
 * @property {Uint8Array} identity                                   The joiner's identity key.
 * @property {Uint8Array} writer                                     The joiner's writer key in the database.
 * @property {() => unknown} onsettle                                Called once when the request is accepted or denied.
 *
 * @typedef {object} AcceptOpts
 * @property {string} [role]                                         Role granted: the invite's by default, at most the invite's.
 */

/**
 * A joiner's knock, waiting to be accepted or denied.
 */
export class Request {
  /** @param {RequestOpts} opts */
  constructor(opts) {
    this.pairing = opts.pairing
    this._replyTo = opts.reply
    this._settled = false
    this._onsettle = opts.onsettle

    this.invite = opts.invite
    this.identity = opts.identity
    this.writer = opts.writer
  }

  /**
   * Admit the joiner, then send it the database's keys and epochs, so it reads the history from
   * before it joined. The keys go out only once the admission landed. Idempotent.
   *
   * @param {AcceptOpts} [opts]
   * @returns {Promise<void>}
   */
  async accept({ role } = {}) {
    if (this._settled) return
    const { invite } = this
    if (invite.expired) throw CeroError.EXPIRED()
    role = role || invite.role || 'member'
    if (invite.role && !grants(invite.role, role)) {
      throw CeroError.INVALID(`role '${role}' exceeds the invite role '${invite.role}'`)
    }
    // checked here, the cap against our own rank is enforced at apply
    if (!isRank(role)) {
      throw CeroError.INVALID(`role '${role}' is not a rank (owner, admin, member, reader)`)
    }

    const { db } = this.pairing
    await admit(db, { identity: this.identity, writer: this.writer, role })
    await this._respond({
      status: STATUS_ACCEPTED,
      reason: '',
      key: db.key,
      encryptionKey: db.encryptionKey,
      epochs: db.keyring.all()
    })
  }

  /**
   * Refuse the joiner, with an optional reason. Idempotent.
   *
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async deny(reason = '') {
    if (this._settled) return
    await this._respond({
      status: STATUS_DENIED,
      reason,
      key: null,
      encryptionKey: null,
      epochs: null
    })
  }

  // the reply is kept before the invite is consumed: if we die in between, the invite is still
  // live and the joiner's next knock is answered again
  async _respond(envelope) {
    this._settled = true
    await this.pairing.mailbox.send(this._replyTo, c.encode(Response, envelope))
    await this._onsettle()
  }
}

// the member row, and for anyone who writes, the writer that belongs to it: one batch, so a
// refusal discards both
async function admit(db, { identity, writer, role }) {
  const ts = Date.now()
  const key = Hypercore.key({ version: 2, signers: [{ publicKey: writer }] })
  const member = { id: hid.encode(identity), key, role, createdAt: ts, updatedAt: ts }
  // a knock delivered again: this writer is already in, so only the reply goes out again
  const { data: existing } = await db.get('members', member.id)
  if (existing && b4a.equals(existing.key, key)) return
  if (role === 'reader') {
    await db.call('add-member', member)
    return
  }
  const sig = db.identity.sign(admission(db.key, key, db.writerKey))
  await db.tx(async (tx) => {
    await tx.call('add-member', member)
    await tx.call('add-writer', {
      sig,
      master: db.identity.publicKey,
      writer: key,
      memberId: member.id,
      ts
    })
  })
}
