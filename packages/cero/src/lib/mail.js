import c from 'compact-encoding'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'
import { Identity } from '@cero-base/core/identity'
import { Mailbox } from '@cero-base/core/mailbox'
import { CeroError } from '@cero-base/core/errors'
import crypto from 'hypercore-crypto'

const NS = b4a.from('cero/mail')

/**
 * The address a secret owns: share it, anyone can send to it, only the secret opens.
 *
 * @param {Uint8Array} secret
 * @returns {string}
 */
export function address(secret) {
  return hid.encode(Mailbox.getAddress(secret))
}

/**
 * @param {string} address
 * @returns {Uint8Array}
 */
export function decodeAddress(address) {
  try {
    return hid.decode(address)
  } catch {
    throw CeroError.INVALID(`'${address}' is not an address`)
  }
}

/**
 * A value signed by `identity` for the address `to`, so it cannot be redirected elsewhere, with
 * an id of its own under the signature, so a message that arrives twice is known as one.
 *
 * @param {import('@cero-base/core/identity').Identity} identity
 * @param {Uint8Array} to
 * @param {unknown} value
 * @returns {Uint8Array}
 */
export function seal(identity, to, value) {
  const id = crypto.randomBytes(16)
  const data = c.encode(c.any, value)
  return c.encode(c.any, { id, data, proof: identity.sign(signed(to, id, data)) })
}

/**
 * The value, its id and who sent it, or null for anything unsigned, tampered or signed for
 * another address.
 *
 * @param {Uint8Array} to
 * @param {Uint8Array} bytes
 * @returns {{ value: unknown, id: string, from: string, device: string } | null}
 */
export function unseal(to, bytes) {
  try {
    const { id, data, proof } = c.decode(c.any, bytes)
    const who = Identity.verify(proof, signed(to, id, data))
    if (!who) return null
    return {
      value: c.decode(c.any, data),
      id: b4a.toHex(id),
      from: hid.encode(who.identity),
      device: hid.encode(who.device)
    }
  } catch {
    return null
  }
}

function signed(to, id, data) {
  return b4a.concat([NS, to, id, data])
}
