import c from 'compact-encoding'
import z32 from 'z32'

import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'

/**
 * @typedef {object} RawBlobId
 * @property {number} blockOffset
 * @property {number} blockLength
 * @property {number} byteOffset
 * @property {number} byteLength
 */

const BlobId = getEncoding('@cero/blob-id')

// type/subtype as RFC 9110 tokens, parameters in printable ASCII: the type is served as a header
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+"
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(;[ -~]*)?$`)

/**
 * Encode a coreKey + raw hyperblobs blobId + type into a durable string id.
 *
 * @param {Uint8Array} coreKey
 * @param {RawBlobId} blobId
 * @param {string} type
 * @returns {string}
 */
export function encodeId(coreKey, blobId, type) {
  return z32.encode(c.encode(BlobId, { coreKey, ...blobId, type }))
}

/**
 * Decode a string id back into its coreKey, raw blobId and type.
 *
 * @param {string} id
 * @returns {{ coreKey: Uint8Array, blobId: RawBlobId, type: string }}
 */
export function decodeId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw CeroError.INVALID('id must be a non-empty string')
  }
  let buf
  try {
    buf = z32.decode(id)
  } catch {
    throw CeroError.INVALID('id must be valid z32')
  }
  let v
  try {
    v = c.decode(BlobId, buf)
  } catch {
    throw CeroError.INVALID('id is malformed')
  }
  const { coreKey, blockOffset, blockLength, byteOffset, byteLength, type } = v
  if (type !== '' && !MEDIA_TYPE.test(type)) throw CeroError.INVALID('id has no media type')
  return { coreKey, blobId: { blockOffset, blockLength, byteOffset, byteLength }, type }
}
