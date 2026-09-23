import sodium from 'sodium-universal'
import IdentityKey from 'keet-identity-key'
import bip39 from 'bip39-mnemonic'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'

import { CeroError } from '../lib/errors.js'

const DERIVE_PATH = ['SLIP-0021', 'cero', 'v1', 'identity']

/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array, id: string }} KeyPair
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array, encryptionKey: Uint8Array, seed: Uint8Array }} IdentityFields
 */

/**
 * Long-lived user identity derived from a BIP-39 seed phrase.
 */
export class Identity {
  /** @param {IdentityFields} keys */
  constructor(keys) {
    /**
     * Canonical z32-encoded public key.
     *
     * @type {string}
     */
    this.id = hid.encode(keys.publicKey)
    /** @type {Uint8Array} */
    this.publicKey = keys.publicKey
    /** @type {Uint8Array} */
    this.secretKey = keys.secretKey
    /**
     * Symmetric key for encrypting per-identity payloads.
     *
     * @type {Uint8Array}
     */
    this.encryptionKey = keys.encryptionKey
    /**
     * Hash of the public key — used as the swarm topic.
     *
     * @type {Uint8Array}
     */
    this.topic = topicOf(keys.publicKey)
    /**
     * Original 16- or 32-byte entropy.
     *
     * @type {Uint8Array}
     */
    this.seed = keys.seed
    Object.freeze(this)
  }

  /**
   * Redacted — secretKey/encryptionKey/seed must never reach JSON.stringify
   * or a structured logger.
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
   * Detached Ed25519 signature over `message`.
   *
   * @param {Uint8Array} message
   * @returns {Uint8Array}
   */
  sign(message) {
    const sig = b4a.alloc(sodium.crypto_sign_BYTES)
    sodium.crypto_sign_detached(sig, message, this.secretKey)
    return sig
  }

  /**
   * Verify a signature against this identity's public key.
   *
   * @param {Uint8Array} message
   * @param {Uint8Array} signature
   * @returns {boolean}
   */
  verify(message, signature) {
    return sodium.crypto_sign_verify_detached(signature, message, this.publicKey)
  }

  /**
   * Open a sealed box addressed to this identity (any device holding the seed-derived
   * keypair can open it).
   *
   * @param {Uint8Array} sealed
   * @returns {Uint8Array | null}
   */
  unseal(sealed) {
    if (!b4a.isBuffer(sealed) || sealed.byteLength <= sodium.crypto_box_SEALBYTES) return null
    const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
    const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
    sodium.crypto_sign_ed25519_pk_to_curve25519(publicKey, this.publicKey)
    sodium.crypto_sign_ed25519_sk_to_curve25519(secretKey, this.secretKey)
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
    return Identity.toPhrase(this.seed)
  }

  /**
   * An identity from its seed, 16 or 32 bytes; a fresh one without.
   *
   * @param {{ seed?: Uint8Array | null, words?: 12 | 24 }} [opts]  `words` sizes a fresh one.
   * @returns {Promise<Identity>}
   */
  static async create({ seed = null, words = 12 } = {}) {
    seed ??= randomSeed(words)
    if (!b4a.isBuffer(seed) || (seed.byteLength !== 16 && seed.byteLength !== 32)) {
      throw CeroError.INVALID('seed must be 16 or 32 bytes')
    }
    const id = await IdentityKey.from({ mnemonic: bip39.entropyToMnemonic(seed) })
    const { publicKey, secretKey } = id.identityKeyPair
    const encryptionKey = id.keyChain.getSymmetricKey([...DERIVE_PATH, 'encryption'])
    return new Identity({ publicKey, secretKey, encryptionKey, seed })
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
   * Verify a signature against an arbitrary public key.
   *
   * @param {Uint8Array} publicKey
   * @param {Uint8Array} message
   * @param {Uint8Array} signature
   * @returns {boolean}
   */
  static verify(publicKey, message, signature) {
    return sodium.crypto_sign_verify_detached(signature, message, publicKey)
  }

  /**
   * Seal a message to an identity's Ed25519 public key (sealed box over the curve25519
   * conversion).
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
   * Generate a fresh Ed25519 keypair (for devices, blind invites, etc.).
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
