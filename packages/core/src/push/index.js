import { decode, readNotification } from 'blind-push'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

/**
 * @typedef {{ id: string, key: Uint8Array }} Handle  A handle this device holds: its id and its database key.
 * @typedef {Handle & { length: number, newer: boolean, ref: string | null }} Hit  The handle a push is about, the length it proves, whether this device is behind it, and the ref the write was on.
 */

/**
 * Verify a push payload against this device's storage: the one the gateway sent, decoded from the
 * platform's message. Null when it is about no handle given, is forged, or does not decode.
 *
 * @param {import('hypercore-storage')} storage  The corestore's storage; may be opened read-only.
 * @param {Uint8Array} payload
 * @param {Handle[]} handles
 * @returns {Promise<Hit | null>}
 */
export async function receive(storage, payload, handles) {
  let push
  try {
    push = decode(payload)
  } catch {
    return null
  }
  const handle = handles.find((h) => b4a.equals(crypto.discoveryKey(h.key), push.discoveryKey))
  if (!handle) return null
  let read
  try {
    read = await readNotification(storage, handle.key, push.payload)
  } catch {
    return null
  }
  if (!read) return null
  const ref = read.extra?.length ? b4a.toString(read.extra) : null
  return { ...handle, length: read.result.length, newer: read.result.newer, ref }
}
