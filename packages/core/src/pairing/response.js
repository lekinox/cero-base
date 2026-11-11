import sodium from 'sodium-universal'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import c from 'compact-encoding'

import { getEncoding } from '../lib/spec/index.js'

export const STATUS_ACCEPTED = 0
export const STATUS_DENIED = 1

const [NS_ANSWER] = crypto.namespace('cero/answer', 1)

/**
 * @typedef {{ status: number, reason?: string, key?: Uint8Array | null, encryptionKey?: Uint8Array | null, epochs?: Array<{ epoch: number, stamp: number, entropy: Uint8Array }> | null, proof?: Uint8Array | null, tag?: Uint8Array | null }} Answer
 */

// an accept and a deny both ride this response
/** @type {import('compact-encoding').Encoder<Answer>} */
export const Response = getEncoding('@cero/confirm')

/**
 * An answer's tag, keyed by what the invite's address and the joiner's reply address share: each
 * end makes it from its own secret key and the other's address, and nobody else can.
 *
 * @param {Answer} answer
 * @param {Uint8Array} secretKey  This end's secret key.
 * @param {Uint8Array} publicKey  The other end's address.
 * @returns {Uint8Array | null}   Null for an address that shares nothing.
 */
export function tag(answer, secretKey, publicKey) {
  const shared = b4a.alloc(sodium.crypto_scalarmult_BYTES)
  try {
    sodium.crypto_scalarmult(shared, secretKey, publicKey)
  } catch {
    return null
  }
  const out = b4a.alloc(32)
  const plain = c.encode(Response, { ...answer, tag: null })
  sodium.crypto_generichash(out, plain, crypto.hash([NS_ANSWER, shared]))
  return out
}

/**
 * Whether an answer carries the tag its two ends make.
 *
 * @param {Answer | null} answer
 * @param {Uint8Array} secretKey
 * @param {Uint8Array} publicKey
 * @returns {boolean}
 */
export function proven(answer, secretKey, publicKey) {
  if (answer?.tag?.byteLength !== 32) return false
  const expected = tag(answer, secretKey, publicKey)
  return !!expected && sodium.sodium_memcmp(answer.tag, expected)
}
