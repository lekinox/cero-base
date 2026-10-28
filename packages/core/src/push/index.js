import { decode, readNotification } from 'blind-push'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import autobeeEncryption from 'autobee/lib/encryption.js'
import autobeeEncoding from 'autobee/lib/encoding.js'

import { Keyring } from '../database/encryption.js'
import { unwrap } from '../database/envelope.js'

const { AutobeeEncryption, WriterEncryption } = autobeeEncryption
const { decodeOplog } = autobeeEncoding

/**
 * @typedef {{ id: string, key: Uint8Array }} Handle  A handle this device holds: its id and its database key.
 * @typedef {{ index: number, value: Uint8Array, writer: Uint8Array }} Block  The block a push carries when it fits: its index, its bytes as the writer's core holds them, and the writer's key.
 * @typedef {Handle & { length: number, newer: boolean, ref: string | null, block: Block | null }} Hit  The handle a push is about, the length it proves, whether this device is behind it, the ref the write was on, and the block when it rode along.
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
export async function verify(storage, payload, handles) {
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
  const { block, key: writer } = read.result
  return {
    ...handle,
    length: read.result.length,
    newer: read.result.newer,
    ref,
    block: block?.value ? { index: block.index, value: block.value, writer } : null
  }
}

/**
 * The op a push's block holds, for a device with the handle's keys: decrypted as the writer's
 * core would, under the epoch the block names, and stripped of its envelope. Null when the push
 * carried no block, the writer is not stored here, or the epoch is not among `epochs`.
 *
 * @param {import('hypercore-storage')} storage  The same storage `verify` read.
 * @param {Hit} hit
 * @param {{ encryptionKey: Uint8Array, epochs?: Array<{ epoch: number, stamp: number, entropy: Uint8Array }> }} keys  The handle's encryption key and the rotation epochs it has learned.
 * @returns {Promise<Uint8Array | null>}
 */
export async function decrypt(storage, hit, { encryptionKey, epochs = [] }) {
  if (!hit.block) return null
  const core = await storage.resumeCore(crypto.discoveryKey(hit.block.writer))
  if (!core) return null
  const rx = core.read()
  const auth = rx.getAuth()
  rx.tryFlush()
  const manifest = (await auth)?.manifest
  if (!manifest) return null
  const keyring = new Keyring()
  for (const e of epochs) keyring.add(e.stamp, e.entropy, e.epoch)
  const auto = {
    key: hit.key,
    encryptionKey,
    getEntropy: (id) => {
      const entropy = keyring.entropy(id)
      if (!entropy) throw new Error(`unknown epoch ${id}`)
      return entropy
    }
  }
  const value = b4a.from(hit.block.value)
  try {
    await new WriterEncryption(auto).decrypt(hit.block.index, value, {
      key: hit.block.writer,
      manifest
    })
    return unwrap(decodeOplog(value.subarray(AutobeeEncryption.PADDING)).value)?.body ?? null
  } catch {
    return null
  }
}
