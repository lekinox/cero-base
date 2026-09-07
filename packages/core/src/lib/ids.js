import crypto from 'crypto'
import z32 from 'z32'

/**
 * Generate a short opaque id (z32-encoded 16 random bytes).
 *
 * @returns {string}
 */
export function genId() {
  return z32.encode(crypto.randomBytes(16))
}
