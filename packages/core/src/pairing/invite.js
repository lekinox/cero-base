import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import ms from 'ms'
import z32 from 'z32'
import c from 'compact-encoding'

import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'

const VERSION = 1
// an invite past its database's start: a release from before the stamp refuses it instead of joining
export const STAMPED = 2
const Encoding = getEncoding('@cero/invite')
const [NS_KEY, NS_PROOF] = crypto.namespace('cero/invite', 2)

/**
 * @typedef {object} InviteFields
 * @property {number} expires           Absolute expiry timestamp; `0` means never.
 * @property {Uint8Array} key           Key of the database the invite opens.
 * @property {Uint8Array} address       The database's address: a join is sealed to it.
 * @property {Uint8Array} seed          The invite's secret; its keypair proves a join.
 * @property {{ key: Uint8Array, length: number } | null} link  The node that added its record: a join links it, so no member applies the join first.
 * @property {Uint8Array | null} [data] The app's payload, readable before joining. Unsigned: a hint, not proof.
 * @property {number} [stamp]           The stamp its record was written with, which its joins take; `0` for none.
 * @property {number} [version]         The invite's form: `STAMPED` once the stamp is past its database's start.
 */

/**
 * An invite: the database it opens, the address a join is sealed to, and a seed whose keypair
 * proves the joiner holds the invite. Role and expiry come from the database's own record;
 * `expires` is here so a joiner fails fast.
 */
export class Invite {
  /** @param {InviteFields & { _str?: string }} fields */
  constructor({
    version = VERSION,
    expires,
    key,
    address,
    seed,
    link = null,
    data = null,
    stamp = 0,
    _str = null
  }) {
    this.version = version
    this.expires = expires
    this.key = key
    this.address = address
    this.seed = seed
    this.link = link
    this.data = data
    this.stamp = stamp
    /** @private */
    this._str = _str
    /** @private */
    this._keyPair = null
  }

  /** @returns {boolean} Whether the invite is past its expiry (never when `expires === 0`). */
  get expired() {
    return this.expires > 0 && Date.now() > this.expires
  }

  /** @returns {Uint8Array} Discovery key of the database the invite opens. */
  get discoveryKey() {
    return crypto.discoveryKey(this.key)
  }

  /** @returns {Uint8Array} The invite's id: the public key of its seed's keypair. */
  get id() {
    return this._pair().publicKey
  }

  /**
   * Sign a writer with the invite's key, proving the join in that writer's core comes from its
   * holder.
   *
   * @param {Uint8Array} writer
   * @returns {Uint8Array}
   */
  prove(writer) {
    return crypto.sign(crypto.hash([NS_PROOF, writer]), this._pair().secretKey)
  }

  /** @returns {string} The z32 wire form. */
  toString() {
    this._str ??= z32.encode(c.encode(Encoding, this))
    return this._str
  }

  /** @private */
  _pair() {
    this._keyPair ??= crypto.keyPair(crypto.hash([NS_KEY, this.seed]))
    return this._keyPair
  }

  /**
   * Whether `proof` is the invite `id`'s signature over `writer`.
   *
   * @param {Uint8Array} id
   * @param {Uint8Array} writer
   * @param {Uint8Array} proof
   * @returns {boolean}
   */
  static proven(id, writer, proof) {
    return crypto.verify(crypto.hash([NS_PROOF, writer]), proof, id)
  }

  /**
   * A new invite with a fresh seed.
   *
   * @param {{ ttl?: number | string, key: Uint8Array, address: Uint8Array, link?: { key: Uint8Array, length: number } | null, data?: Uint8Array | null }} opts
   * @returns {Invite}
   */
  static create({ ttl = 0, key, address, link = null, data = null }) {
    if (key?.byteLength !== 32) throw CeroError.INVALID('key must be a 32-byte buffer')
    if (address?.byteLength !== 32) throw CeroError.INVALID('address must be a 32-byte buffer')
    if (!sealable(address)) throw CeroError.INVALID('address cannot be sealed to')
    const expires = ttl ? Date.now() + toMs(ttl) : 0
    if (data !== null && !b4a.isBuffer(data)) throw CeroError.INVALID('data must be a buffer')
    return new Invite({
      expires,
      key,
      address,
      seed: crypto.randomBytes(32),
      link,
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
    if (fields.version !== VERSION && fields.version !== STAMPED) {
      throw CeroError.INVALID_INVITE('unknown invite version')
    }
    if (!sealable(fields.address)) throw CeroError.INVALID_INVITE('address cannot be sealed to')
    return new Invite({ ...fields, _str: str })
  }
}

// a join is sealed to the address: a point nothing seals to (all zeros, a low-order one) would
// fail every join as a network error
function sealable(address) {
  try {
    crypto.encrypt(EMPTY, address)
    return true
  } catch {
    return false
  }
}

const EMPTY = b4a.alloc(0)

// ms, or a duration like '12h' or '2d'; the expiry is a uint on the wire
function toMs(ttl) {
  const value = typeof ttl === 'string' ? ms(ttl) : ttl
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(Date.now() + value)) {
    throw CeroError.INVALID(`ttl '${ttl}' is not a duration`)
  }
  return value
}
