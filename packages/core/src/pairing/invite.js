import BlindPairing from 'blind-pairing'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import z32 from 'z32'
import c from 'compact-encoding'

import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'

const VERSION = 1
const Envelope = getEncoding('@cero/invite')
const SignBody = getEncoding('@cero/invite-body')

/**
 * @typedef {object} InviteFields
 * @property {Uint8Array} publicKey                 Signer's long-lived public key.
 * @property {string} role                          Optional role tag baked into the signed body.
 * @property {number} expires                       Absolute expiry timestamp; `0` means never.
 * @property {Uint8Array | null} data               Encoded payload (raw or via `encoding`).
 * @property {Uint8Array} blind                     Raw blind-pairing invite handed to candidates.
 * @property {Uint8Array} [sig]                     Ed25519 signature over the canonical body.
 * @property {string | null} [_str]                 Cached z32 string form.
 *
 * @typedef {object} CreateInviteOpts
 * @property {Uint8Array} secretKey                 64-byte Ed25519 secret key used to sign.
 * @property {Uint8Array} publicKey                 32-byte Ed25519 public key matching `secretKey`.
 * @property {string} role                          Optional role tag for the joiner.
 * @property {number} expiresIn                     TTL in ms from now; `0` means never expires.
 * @property {any} data                             Caller payload; encoded via `encoding` when provided.
 * @property {Uint8Array} blind                     Raw blind-pairing invite to wrap.
 * @property {any} [encoding]                       compact-encoding type used to encode `data`.
 *
 * @typedef {object} ParseInviteOpts
 * @property {any} [encoding]                       compact-encoding type used to decode the embedded payload.
 */

/**
 * Signed, expirable pairing invite. Wraps a blind-pairing invite with a role, optional
 * payload and an Ed25519 signature so the host can be authenticated by the joiner before
 * any handshake happens.
 *
 * @property {any} [_rawData]                         Decoded payload kept alongside the encoded `data` for convenience.
 * @property {Uint8Array} _discoveryKey               Cached discovery key of the wrapped blind invite.
 */
export class Invite {
  /** @param {InviteFields} fields */
  constructor(fields) {
    this.version = VERSION
    this.publicKey = fields.publicKey
    this.role = fields.role
    this.expires = fields.expires
    this.data = fields.data
    this.blind = fields.blind
    this.sig = fields.sig
    this._str = fields._str || null

    this._discoveryKey = null
  }

  /**
   * Whether the invite is past its TTL (always `false` when `expires === 0`).
   *
   * @returns {boolean}
   */
  get expired() {
    return this.expires > 0 && Date.now() > this.expires
  }

  /**
   * Discovery key of the wrapped blind-pairing invite — the topic it targets.
   *
   * @returns {Uint8Array}
   */
  get discoveryKey() {
    if (!this._discoveryKey) {
      this._discoveryKey = BlindPairing.decodeInvite(this.blind).discoveryKey
    }
    return this._discoveryKey
  }

  /**
   * Verify the embedded signature against the encoded body.
   *
   * @returns {boolean}
   */
  verify() {
    const body = c.encode(SignBody, this)
    return sodium.crypto_sign_verify_detached(this.sig, body, this.publicKey)
  }

  /**
   * Serialise to the canonical z32 wire form (cached).
   *
   * @returns {string}
   */
  toString() {
    if (this._str) return this._str
    const buf = c.encode(Envelope, this)
    this._str = z32.encode(buf)
    return this._str
  }

  /**
   * Build and sign a new invite envelope wrapping a blind-pairing invite.
   *
   * @param {CreateInviteOpts} opts
   * @returns {Invite}
   */
  static create({ secretKey, publicKey, role, expiresIn, data, blind, encoding }) {
    if (!secretKey || secretKey.length !== 64) {
      throw CeroError.INVALID('secretKey must be a 64-byte buffer')
    }
    if (!publicKey || publicKey.length !== 32) {
      throw CeroError.INVALID('publicKey must be a 32-byte buffer')
    }
    if (!b4a.isBuffer(blind)) {
      throw CeroError.INVALID('blind invite must be a buffer')
    }

    const expires = expiresIn ? Date.now() + expiresIn : 0
    const encoded = data == null ? null : encoding ? c.encode(encoding, data) : data

    const fields = {
      version: VERSION,
      publicKey,
      role: role || '',
      expires,
      data: encoded,
      blind
    }

    const body = c.encode(SignBody, fields)
    const sig = b4a.alloc(64)
    sodium.crypto_sign_detached(sig, body, secretKey)
    fields.sig = sig

    const inv = new Invite(fields)
    inv._rawData = data // remember decoded form for convenience
    return inv
  }

  /**
   * Parse a z32 invite string, verify its signature and (optionally) decode
   * its payload.
   *
   * @param {string} str
   * @param {ParseInviteOpts} [opts]
   * @returns {Invite}
   */
  static parse(str, { encoding } = {}) {
    if (typeof str !== 'string') throw CeroError.INVALID_INVITE('invite must be a string')

    let buf
    try {
      buf = z32.decode(str)
    } catch {
      throw CeroError.INVALID_INVITE('invite is not valid z32')
    }

    let fields
    try {
      fields = c.decode(Envelope, buf)
    } catch {
      throw CeroError.INVALID_INVITE('invite envelope failed to decode')
    }

    if (fields.version !== VERSION) throw CeroError.INVALID_INVITE('unknown invite version')

    const inv = new Invite({ ...fields, _str: str })
    if (!inv.verify()) throw CeroError.INVALID_INVITE('invite signature is invalid')

    if (encoding && inv.data) {
      try {
        inv._rawData = c.decode(encoding, inv.data)
      } catch {
        throw CeroError.INVALID_INVITE('invite data failed to decode')
      }
    }

    return inv
  }

  /**
   * Cheap structural test — does `str` decode as an invite envelope? Does not
   * verify the signature.
   *
   * @param {unknown} str
   * @returns {boolean}
   */
  static isInvite(str) {
    if (typeof str !== 'string') return false
    try {
      const buf = z32.decode(str)
      const fields = c.decode(Envelope, buf)
      if (fields.blind) BlindPairing.decodeInvite(fields.blind)
      return true
    } catch {
      return false
    }
  }
}
