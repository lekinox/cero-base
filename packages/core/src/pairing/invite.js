import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import ms from 'ms'
import z32 from 'z32'
import c from 'compact-encoding'

import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'

const VERSION = 1
const Encoding = getEncoding('@cero/invite')
const [NS_KEY, NS_PROOF] = crypto.namespace('cero/invite', 2)

/**
 * @typedef {object} InviteFields
 * @property {number} expires           Absolute expiry timestamp; `0` means never.
 * @property {Uint8Array} discoveryKey  Discovery key of the database the invite opens.
 * @property {Uint8Array} address       Where a knock is sent.
 * @property {Uint8Array} seed          The invite's secret; its keypair proves a knock.
 * @property {Uint8Array | null} [data] The app's payload, readable before joining. Unsigned: a hint, not proof.
 */

/**
 * An invite: where to knock (its address), the database it opens, and a seed
 * whose keypair proves the knocker holds the invite. Role and expiry are enforced by the member
 * that answers, from its own record; `expires` is here so a joiner fails fast.
 */
export class Invite {
  /** @param {InviteFields & { _str?: string }} fields */
  constructor({ expires, discoveryKey, address, seed, data = null, _str = null }) {
    this.version = VERSION
    this.expires = expires
    this.discoveryKey = discoveryKey
    this.address = address
    this.seed = seed
    this.data = data
    this._str = _str
    this._keyPair = null
  }

  /** @returns {boolean} Whether the invite is past its expiry (never when `expires === 0`). */
  get expired() {
    return this.expires > 0 && Date.now() > this.expires
  }

  /** @returns {Uint8Array} The invite's id: the public key of its seed's keypair. */
  get id() {
    return this._pair().publicKey
  }

  /**
   * Sign a reply address with the invite's key, proving the knock comes from its holder.
   *
   * @param {Uint8Array} reply
   * @returns {Uint8Array}
   */
  prove(reply) {
    return crypto.sign(crypto.hash([NS_PROOF, reply]), this._pair().secretKey)
  }

  /** @returns {string} The z32 wire form. */
  toString() {
    this._str ??= z32.encode(c.encode(Encoding, this))
    return this._str
  }

  _pair() {
    this._keyPair ??= crypto.keyPair(crypto.hash([NS_KEY, this.seed]))
    return this._keyPair
  }

  /**
   * Whether `proof` is the invite `id`'s signature over `reply`.
   *
   * @param {Uint8Array} id
   * @param {Uint8Array} reply
   * @param {Uint8Array} proof
   * @returns {boolean}
   */
  static proven(id, reply, proof) {
    return crypto.verify(crypto.hash([NS_PROOF, reply]), proof, id)
  }

  /**
   * A new invite with a fresh seed.
   *
   * @param {{ ttl?: number | string, discoveryKey: Uint8Array, address: Uint8Array, data?: Uint8Array | null }} opts
   * @returns {Invite}
   */
  static create({ ttl = 0, discoveryKey, address, data = null }) {
    if (discoveryKey?.byteLength !== 32) {
      throw CeroError.INVALID('discoveryKey must be a 32-byte buffer')
    }
    if (address?.byteLength !== 32) throw CeroError.INVALID('address must be a 32-byte buffer')
    const expires = ttl ? Date.now() + toMs(ttl) : 0
    if (data !== null && !b4a.isBuffer(data)) throw CeroError.INVALID('data must be a buffer')
    return new Invite({
      expires,
      discoveryKey,
      address,
      seed: crypto.randomBytes(32),
      data
    })
  }

  /**
   * Parse an invite string.
   *
   * @param {string} str
   * @returns {Invite}
   */
  static parse(str) {
    if (typeof str !== 'string') throw CeroError.INVALID_INVITE('invite must be a string')
    let fields
    try {
      fields = c.decode(Encoding, z32.decode(str))
    } catch {
      throw CeroError.INVALID_INVITE('not an invite')
    }
    if (fields.version !== VERSION) throw CeroError.INVALID_INVITE('unknown invite version')
    return new Invite({ ...fields, _str: str })
  }
}

// ms, or a duration like '12h' or '2d'
function toMs(ttl) {
  const value = typeof ttl === 'string' ? ms(ttl) : ttl
  if (!Number.isFinite(value)) throw CeroError.INVALID(`ttl '${ttl}' is not a duration`)
  return value
}
