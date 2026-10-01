import { getEncoding } from '../lib/spec/index.js'

export const STATUS_ACCEPTED = 0
export const STATUS_DENIED = 1

// an accept and a deny both ride this response
/** @type {import('compact-encoding').Encoder<{ status: number, reason?: string, key?: Uint8Array | null, encryptionKey?: Uint8Array | null, epochs?: Array<{ epoch: number, stamp: number, entropy: Uint8Array }> | null }>} */
export const Response = getEncoding('@cero/confirm')
