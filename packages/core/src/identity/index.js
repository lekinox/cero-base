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
    return bip39.entropyToMnemonic(this.seed)
  }

  /**
   * Build an identity from 16- or 32-byte entropy.
   *
   * @param {Uint8Array} seed
   * @returns {Promise<Identity>}
   */
  static async fromSeed(seed) {
    if (!Identity.isSeed(seed)) throw CeroError.INVALID('seed must be a 16- or 32-byte buffer')
    const mnemonic = bip39.entropyToMnemonic(seed)
    const id = await IdentityKey.from({ mnemonic })
    const { publicKey, secretKey } = id.identityKeyPair
    const encryptionKey = id.keyChain.getSymmetricKey([...DERIVE_PATH, 'encryption'])
    return new Identity({ publicKey, secretKey, encryptionKey, seed })
  }

  /**
   * Build an identity from a BIP-39 mnemonic.
   *
   * @param {string} phrase
   * @returns {Promise<Identity>}
   */
  static async fromPhrase(phrase) {
    if (!Identity.isPhrase(phrase)) throw CeroError.INVALID('phrase must be a valid BIP39 mnemonic')
    return Identity.fromSeed(bip39.mnemonicToEntropy(phrase))
  }

  /**
   * Generate a fresh identity from CSPRNG entropy.
   *
   * @param {{ words?: 12 | 24 }} [opts]
   * @returns {Promise<Identity>}
   */
  static async generate({ words = 12 } = {}) {
    return Identity.fromSeed(Identity.randomSeed(words))
  }

  /**
   * Generate a random BIP-39 mnemonic.
   *
   * @param {12 | 24} [words]
   * @returns {string}
   */
  static genPhrase(words = 12) {
    return bip39.entropyToMnemonic(Identity.randomSeed(words))
  }

  /**
   * Phrase → seed entropy.
   *
   * @param {string} phrase
   * @returns {Uint8Array}
   */
  static toSeed(phrase) {
    return bip39.mnemonicToEntropy(phrase)
  }

  /**
   * Seed entropy → phrase.
   *
   * @param {Uint8Array} seed
   * @returns {string}
   */
  static toPhrase(seed) {
    return bip39.entropyToMnemonic(seed)
  }

  /**
   * Validate that a value is a 16- or 32-byte buffer.
   *
   * @param {any} x
   * @returns {x is Uint8Array}
   */
  static isSeed(x) {
    if (!b4a.isBuffer(x)) return false
    return x.length === 16 || x.length === 32
  }

  /**
   * Validate that a string is a BIP-39 mnemonic.
   *
   * @param {unknown} x
   * @returns {x is string}
   */
  static isPhrase(x) {
    if (typeof x !== 'string') return false
    try {
      bip39.mnemonicToEntropy(x)
      return true
    } catch {
      return false
    }
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

  /**
   * Fresh seed entropy sized for the chosen mnemonic length.
   *
   * @param {12 | 24} [words]
   * @returns {Uint8Array}
   */
  static randomSeed(words = 12) {
    if (words !== 12 && words !== 24) throw CeroError.INVALID('words must be 12 or 24')
    return Identity.randomBytes((words / 3) * 4)
  }
}

function topicOf(publicKey) {
  const topic = b4a.alloc(32)
  sodium.crypto_generichash(topic, publicKey)
  return topic
}
