import sodium from 'sodium-universal'
import IdentityKey from 'keet-identity-key'
import bip39 from 'bip39-mnemonic'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'

import { CeroError } from '../lib/errors.js'

const DERIVE_PATH = ['SLIP-0021', 'cero', 'v1', 'identity']

/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array, id: string }} KeyPair
 *
 * @typedef {object} IdentityFields
 * @property {Uint8Array} publicKey        The identity's public key.
 * @property {Uint8Array} encryptionKey    Its root encryption key, derived from the seed.
 * @property {KeyPair} device              This device's signing keypair.
 * @property {Uint8Array} proof            The device's chain of attestations back to the identity.
 * @property {Uint8Array | null} [seed]    The phrase's entropy: on the device that created or recovered the identity, never on a linked one.
 *
 * @typedef {{ identity: Uint8Array, device: Uint8Array }} Verified
 */

/**
 * A user identity, as one of its devices holds it. The identity's secret key signs exactly one
 * thing, a device's first proof, and is never kept: everything else is signed by the device key
 * and carries the proof, so a stolen device leaks only itself.
 */
export class Identity {
  /** @param {IdentityFields} fields */
  constructor({ publicKey, encryptionKey, device, proof, seed = null }) {
    /**
     * Canonical z32-encoded public key.
     *
     * @type {string}
     */
    this.id = hid.encode(publicKey)
    /** @type {Uint8Array} */
    this.publicKey = publicKey
    /**
     * Symmetric key for encrypting per-identity payloads.
     *
     * @type {Uint8Array}
     */
    this.encryptionKey = encryptionKey
    /**
     * Hash of the public key — used as the swarm topic.
     *
     * @type {Uint8Array}
     */
    this.topic = topicOf(publicKey)
    /** @type {KeyPair} */
    this.device = { ...device, id: hid.encode(device.publicKey) }
    /** @type {Uint8Array} */
    this.proof = proof
    /** @type {Uint8Array | null} */
    this.seed = seed
    Object.freeze(this)
  }

  /**
   * Redacted — the device secret, encryptionKey and seed must never reach JSON.stringify or a
   * structured logger.
   *
   * @returns {{ id: string }}
   */
  toJSON() {
    return { id: this.id }
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Identity(${this.id})`
  }

  /**
   * A proof over `data`: this device's signature, under its chain to the identity.
   *
   * @param {Uint8Array} data
   * @returns {Uint8Array}
   */
  sign(data) {
    return IdentityKey.attestData(data, this.device, this.proof)
  }

  /**
   * A proof for a new device: this device attests it, one link further down the chain.
   *
   * @param {Uint8Array} publicKey
   * @returns {Uint8Array}
   */
  link(publicKey) {
    return IdentityKey.attestDevice(publicKey, this.device, this.proof)
  }

  /**
   * Open a sealed box addressed to this device.
   *
   * @param {Uint8Array} sealed
   * @returns {Uint8Array | null}
   */
  unseal(sealed) {
    if (!b4a.isBuffer(sealed) || sealed.byteLength <= sodium.crypto_box_SEALBYTES) return null
    const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
    const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
    sodium.crypto_sign_ed25519_pk_to_curve25519(publicKey, this.device.publicKey)
    sodium.crypto_sign_ed25519_sk_to_curve25519(secretKey, this.device.secretKey)
    const message = b4a.alloc(sealed.byteLength - sodium.crypto_box_SEALBYTES)
    const opened = sodium.crypto_box_seal_open(message, sealed, publicKey, secretKey)
    return opened ? message : null
  }

  /**
   * Render the underlying seed as a BIP-39 mnemonic phrase.
   *
   * @returns {string}
   */
  toPhrase() {
    if (!this.seed) {
      throw CeroError.INVALID('no phrase on this device: it was linked, not created or recovered')
    }
    return Identity.toPhrase(this.seed)
  }

  /**
   * An identity from its seed, 16 or 32 bytes; a fresh one without. The identity key attests
   * `device` and is dropped.
   *
   * @param {{ seed?: Uint8Array | null, words?: 12 | 24, device?: KeyPair }} [opts]  `words` sizes a fresh seed; `device` is a fresh keypair by default.
   * @returns {Promise<Identity>}
   */
  static async create({ seed = null, words = 12, device = Identity.randomKeyPair() } = {}) {
    seed ??= randomSeed(words)
    if (!b4a.isBuffer(seed) || (seed.byteLength !== 16 && seed.byteLength !== 32)) {
      throw CeroError.INVALID('seed must be 16 or 32 bytes')
    }
    const key = await IdentityKey.from({ mnemonic: bip39.entropyToMnemonic(seed) })
    const publicKey = b4a.from(key.identityPublicKey)
    const encryptionKey = key.keyChain.getSymmetricKey([...DERIVE_PATH, 'encryption'])
    const proof = await IdentityKey.bootstrap({ identity: key.identityKeyPair }, device.publicKey)
    key.clear()
    return new Identity({ publicKey, encryptionKey, device, proof, seed })
  }

  /**
   * The identity keypair a seed writes, for what only the identity itself may sign: the pointer
   * core it is created with. Nothing else ever takes it.
   *
   * @param {Uint8Array} seed
   * @returns {Promise<{ publicKey: Uint8Array, secretKey: Uint8Array }>}
   */
  static async keyPair(seed) {
    const key = await IdentityKey.from({ mnemonic: bip39.entropyToMnemonic(seed) })
    const { publicKey, secretKey } = key.identityKeyPair
    const pair = { publicKey: b4a.from(publicKey), secretKey: b4a.from(secretKey) }
    key.clear()
    return pair
  }

  /**
   * The identity as a stored or linked device holds it. The proof must chain `device` to it.
   *
   * @param {IdentityFields} fields
   * @returns {Identity}
   */
  static from({ publicKey, encryptionKey, device, proof, seed = null }) {
    const verified = Identity.verify(proof, null, publicKey)
    if (!verified || !b4a.equals(verified.device, device.publicKey)) {
      throw CeroError.INVALID('proof does not chain this device to the identity')
    }
    return new Identity({ publicKey, encryptionKey, device, proof, seed })
  }

  /**
   * Who signed `data`: the identity a proof chains to and the device that signed, or null.
   *
   * @param {Uint8Array} proof
   * @param {Uint8Array | null} [data]        What the proof signs; null verifies the chain alone.
   * @param {Uint8Array | null} [publicKey]   The identity expected, any when omitted.
   * @returns {Verified | null}
   */
  static verify(proof, data = null, publicKey = null) {
    try {
      const opts = publicKey ? { expectedIdentity: publicKey } : {}
      const result = IdentityKey.verify(proof, data, opts)
      return result && { identity: result.identityPublicKey, device: result.devicePublicKey }
    } catch {
      return null
    }
  }

  /**
   * The seed a BIP-39 phrase writes out.
   *
   * @param {string} phrase
   * @returns {Uint8Array}
   */
  static toSeed(phrase) {
    try {
      return bip39.mnemonicToEntropy(phrase)
    } catch {
      throw CeroError.INVALID('phrase must be a BIP-39 mnemonic')
    }
  }

  /**
   * A seed written out as a BIP-39 phrase.
   *
   * @param {Uint8Array} seed
   * @returns {string}
   */
  static toPhrase(seed) {
    return bip39.entropyToMnemonic(seed)
  }

  /**
   * Seal a message to a device's Ed25519 public key (sealed box over the curve25519 conversion).
   *
   * @param {Uint8Array} publicKey
   * @param {Uint8Array} message
   * @returns {Uint8Array}
   */
  static seal(publicKey, message) {
    const curve = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
    sodium.crypto_sign_ed25519_pk_to_curve25519(curve, publicKey)
    const sealed = b4a.alloc(message.byteLength + sodium.crypto_box_SEALBYTES)
    sodium.crypto_box_seal(sealed, message, curve)
    return sealed
  }

  /**
   * Generate a fresh Ed25519 keypair (for devices, writers, blind invites).
   *
   * @returns {KeyPair}
   */
  static randomKeyPair() {
    const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
    const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
    sodium.crypto_sign_keypair(publicKey, secretKey)
    return { publicKey, secretKey, id: hid.encode(publicKey) }
  }

  /**
   * N bytes from a CSPRNG.
   *
   * @param {number} [n]
   * @returns {Uint8Array}
   */
  static randomBytes(n = 32) {
    const buf = b4a.alloc(n)
    sodium.randombytes_buf(buf)
    return buf
  }
}

function randomSeed(words) {
  if (words !== 12 && words !== 24) throw CeroError.INVALID('words must be 12 or 24')
  return Identity.randomBytes((words / 3) * 4)
}

function topicOf(publicKey) {
  const topic = b4a.alloc(32)
  sodium.crypto_generichash(topic, publicKey)
  return topic
}
