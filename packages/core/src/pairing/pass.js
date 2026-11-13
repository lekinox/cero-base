import b4a from 'b4a'
import c from 'compact-encoding'
import hid from 'hypercore-id-encoding'

import { Invite } from './invite.js'
import { Identity } from '../identity/index.js'
import { wraps, opened } from '../database/encryption.js'
import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'

const Encoding = getEncoding('@cero/pass')

/**
 * @typedef {object} PassFields
 * @property {string} invite                       An invite into the database.
 * @property {Uint8Array} key                      The database's key, the one its invite opens.
 * @property {Uint8Array} encryptionKey            The database's encryption key.
 * @property {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} [epochs]  Its rotation epochs.
 * @property {Uint8Array | null} [data]            The sealer's own bytes, read only by a device that opens the pass.
 */

/**
 * An invite into a database with the keys that read it, sealed to devices: one that opens its box
 * joins with the keys in hand and waits for no answer. Unsigned, so whoever opens one holds what
 * it carries to the database's own log.
 */
export const Pass = { seal, open }

/**
 * One box per device, under its device key. A key nothing can be sealed to gets none.
 *
 * @param {Array<{ key: Uint8Array }>} devices
 * @param {PassFields} fields
 * @returns {Uint8Array}
 */
function seal(devices, fields) {
  if (!Array.isArray(devices) || devices.some((d) => d?.key?.byteLength !== 32)) {
    throw CeroError.INVALID('devices are rows with a 32-byte key')
  }
  const message = wire(() => c.encode(Encoding, checked(fields)))
  const boxes = []
  for (const { key } of devices) {
    try {
      boxes.push({ id: hid.encode(key), box: Identity.seal(key, message) })
    } catch {
      // not a point on the curve: no device holds its secret
    }
  }
  return c.encode(wraps, boxes)
}

/**
 * What a pass carries, read from this device's own box.
 *
 * @param {import('../identity/index.js').Identity} identity
 * @param {Uint8Array} pass
 * @returns {PassFields | null}  Null when no box is this device's.
 */
function open(identity, pass) {
  return wire(() => {
    for (const message of opened(identity, identity.device.id, pass)) {
      const fields = checked(c.decode(Encoding, message))
      return { ...fields, epochs: fields.epochs || [] }
    }
    return null
  })
}

// the invite opens the database the keys are for
function checked(fields) {
  if (!b4a.equals(Invite.parse(fields?.invite).key, fields.key)) {
    throw new Error('its invite is for another database')
  }
  return fields
}

// what does not encode, or decode, is no pass
function wire(fn) {
  try {
    return fn()
  } catch (err) {
    throw CeroError.INVALID(`not a pass: ${err.message}`)
  }
}
