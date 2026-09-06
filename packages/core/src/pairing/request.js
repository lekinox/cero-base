import b4a from 'b4a'
import c from 'compact-encoding'
import { keyPair, sign } from 'hypercore-crypto'

import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'

export const STATUS_ACCEPTED = 0
export const STATUS_DENIED = 1

// success and deny both ride the confirm response
export const Response = getEncoding('@cero/confirm')

/**
 * @typedef {object} ConfirmOpts
 * @property {Uint8Array} [key]                                      32-byte resource key delivered to the joiner; required at runtime.
 * @property {Uint8Array | null} [encryptionKey]                     Optional 32-byte symmetric key.
 * @property {Uint8Array | null} [additional]                        Extra opaque bytes piggybacked on the response.
 *
 * @typedef {object} RequestOpts
 * @property {import('./index.js').Pairing} pairing                  Owning Pairing instance.
 * @property {any} req                                               blind-pairing candidate request being answered.
 * @property {import('./invite.js').Invite} invite                   Invite the candidate paired against.
 * @property {Uint8Array} seed                                       Per-invite seed used to sign the response.
 * @property {any} userData                                          Decoded joiner payload (raw bytes when no encoding).
 * @property {() => void} onsettle                                   Called once when the candidate is confirmed or denied.
 */

/**
 * Internal — a pairing request from an incoming candidate, awaiting the host's
 * accept/deny.
 *
 * @property {boolean} _settled                       Whether confirm/deny has already run.
 */
export class Request {
  /** @param {RequestOpts} opts */
  constructor(opts) {
    this.pairing = opts.pairing
    this._req = opts.req
    this._seed = opts.seed
    this._settled = false
    this._onsettle = opts.onsettle

    this.invite = opts.invite
    this.userData = opts.userData
    this.publicKey = opts.req.publicKey
  }

  /**
   * Accept the candidate and reveal the resource key. Idempotent.
   *
   * @param {ConfirmOpts} opts
   * @returns {Promise<void>}
   */
  async confirm({ key, encryptionKey = null, additional = null } = {}) {
    if (this._settled) return
    if (!key || key.length !== 32) throw CeroError.INVALID('key must be a 32-byte buffer')
    if (encryptionKey && encryptionKey.length !== 32) {
      throw CeroError.INVALID('encryptionKey must be a 32-byte buffer')
    }
    if (additional && !b4a.isBuffer(additional)) {
      throw CeroError.INVALID('additional must be a buffer')
    }
    this._respond({ status: STATUS_ACCEPTED, reason: '', key, encryptionKey, extra: additional })
  }

  /**
   * Reject the candidate with an optional reason. Idempotent.
   *
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async deny(reason = '') {
    if (this._settled) return
    this._respond({
      status: STATUS_DENIED,
      reason,
      key: null,
      encryptionKey: null,
      extra: null
    })
  }

  // signed with the per-invite seed
  _respond(envelope) {
    this._settled = true
    this._onsettle()
    const data = c.encode(Response, envelope)
    const signature = sign(data, keyPair(this._seed).secretKey)
    this._req.confirm({
      key: this.pairing.topic,
      encryptionKey: undefined,
      additional: { data, signature }
    })
  }
}
