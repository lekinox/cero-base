import sodium from 'sodium-universal'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { getEncoding } from '../lib/spec/index.js'

export const STATUS_ACCEPTED = 0
export const STATUS_DENIED = 1

const [NS_ANSWER] = crypto.namespace('cero/answer', 1)
const [NS_KEYS] = crypto.namespace('cero/keys', 1)
const TAG = 32
const SIGNED = 32 + 64

// an accept and a deny both ride this response
/** @type {import('compact-encoding').Encoder<{ status: number, reason?: string, key?: Uint8Array | null, encryptionKey?: Uint8Array | null, epochs?: Array<{ epoch: number, stamp: number, entropy: Uint8Array }> | null }>} */
export const Response = getEncoding('@cero/confirm')

/**
 * The tag of an encoded answer, keyed by what the invite's address and the joiner's reply address
 * share: each end makes it from its own secret key and the other's address, and nobody else can.
 *
 * @param {Uint8Array} answer     The answer as it is sent.
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
  const out = b4a.alloc(TAG)
  sodium.crypto_generichash(out, answer, crypto.hash([NS_ANSWER, shared]))
  return out
}

/**
 * The answer in a message that starts with its tag: the bytes after it, null when the tag is not
 * the one its two ends make over them.
 *
 * @param {Uint8Array} message
 * @param {Uint8Array} secretKey
 * @param {Uint8Array} publicKey
 * @returns {Uint8Array | null}
 */
export function proven(message, secretKey, publicKey) {
  if (message.byteLength <= TAG) return null
  const answer = message.subarray(TAG)
  const expected = tag(answer, secretKey, publicKey)
  return expected && sodium.sodium_memcmp(message.subarray(0, TAG), expected) ? answer : null
}

/**
 * Keys sent to a device that asked, as they are sent: the sender's writer key, then its device's
 * signature over the room, the writer they go to and the answer, then the answer.
 *
 * @param {Uint8Array} answer
 * @param {{ room: Uint8Array, to: Uint8Array, writer: Uint8Array, secretKey: Uint8Array }} opts
 * @returns {Uint8Array}
 */
export function signed(answer, { room, to, writer, secretKey }) {
  const signature = crypto.sign(crypto.hash([NS_KEYS, room, to, answer]), secretKey)
  return b4a.concat([writer, signature, answer])
}

/**
 * The sender and the answer of signed keys, null unless the device key `keyOf` gives for the
 * sender's writer signed them for this room and this writer.
 *
 * @param {Uint8Array} message
 * @param {{ room: Uint8Array, to: Uint8Array }} opts
 * @param {(writer: Uint8Array) => Uint8Array | null | undefined} keyOf
 * @returns {{ writer: Uint8Array, answer: Uint8Array } | null}
 */
export function signer(message, { room, to }, keyOf) {
  if (message.byteLength <= SIGNED) return null
  const writer = message.subarray(0, 32)
  const answer = message.subarray(SIGNED)
  const key = keyOf(writer)
  const digest = crypto.hash([NS_KEYS, room, to, answer])
  if (!key || !crypto.verify(digest, message.subarray(32, SIGNED), key)) return null
  return { writer, answer }
}
