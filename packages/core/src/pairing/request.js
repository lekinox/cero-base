import hid from 'hypercore-id-encoding'
import c from 'compact-encoding'

import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'
import { grants, isRank } from '../lib/utils.js'

export const STATUS_ACCEPTED = 0
export const STATUS_DENIED = 1

// an accept and a deny both ride this response
/** @type {import('compact-encoding').Encoder<{ status: number, reason?: string, key?: Uint8Array | null, encryptionKey?: Uint8Array | null, epochs?: Array<{ epoch: number, stamp: number, entropy: Uint8Array }> | null }>} */
export const Response = getEncoding('@cero/confirm')

/**
 * @typedef {object} RequestOpts
 * @property {import('./index.js').Pairing} pairing                  Owning Pairing instance.
 * @property {{ id: string, role: string, expires?: number }} invite  The record of the invite the joiner used.
 * @property {{ id: string, identity: Uint8Array, reply: Uint8Array }} row  The waiting join, as the database keeps it.
 *
 * @typedef {object} AcceptOpts
 * @property {string} [role]                                         Role granted: the invite's by default, at most the invite's.
 */

/**
 * A join on a `confirm` invite, waiting in the database for a member to accept or deny it.
 */
export class Request {
  /** @param {RequestOpts} opts */
  constructor({ pairing, invite, row }) {
    this.pairing = pairing
    this.invite = invite
    this.id = row.id
    this.identity = row.identity
    /** The role the join asks for: its invite's. */
    this.role = invite.role
    /** @type {Uint8Array} */
    this.writer = hid.decode(row.id)
    /** @private */
    this._reply = row.reply
    /** @private */
    this._settled = false
  }

  /**
   * Admit the joiner. Every device of an inviter then replies with the keys. Idempotent.
   *
   * @param {AcceptOpts} [opts]
   * @returns {Promise<void>}
   */
  async accept({ role } = {}) {
    if (this._settled) return
    const { invite } = this
    if (invite.expires > 0 && Date.now() > invite.expires) throw CeroError.EXPIRED()
    role = role || invite.role
    if (!isRank(role)) {
      throw CeroError.INVALID(`role '${role}' is not a rank (owner, admin, member, reader)`)
    }
    if (!grants(invite.role, role)) {
      throw CeroError.INVALID(`role '${role}' exceeds the invite role '${invite.role}'`)
    }
    this._settled = true
    await this.pairing.db.call('accept', { id: this.id, role })
  }

  /**
   * Refuse the joiner, with an optional reason. Idempotent.
   *
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async deny(reason = '') {
    if (this._settled) return
    this._settled = true
    const { db, mailbox } = this.pairing
    await db.call('del-request', { id: this.id })
    const denied = { status: STATUS_DENIED, reason, key: null, encryptionKey: null, epochs: null }
    await mailbox.send(this._reply, c.encode(Response, denied))
  }
}
