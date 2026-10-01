import b4a from 'b4a'
import c from 'compact-encoding'

// 0xff is unreachable as a hyperdispatch route prefix, so it marks a version-enveloped op
const SENTINEL = 0xff

/**
 * Prefix an encoded op with the app's contract version.
 *
 * @param {number} version
 * @param {Uint8Array} body
 * @returns {Uint8Array}
 */
export function wrap(version, body) {
  return b4a.concat([b4a.from([SENTINEL]), c.encode(c.uint, version), body])
}

/**
 * Split an op into contract version and payload, or `null` for bytes with no envelope or a cut one.
 *
 * @param {Uint8Array} buf
 * @returns {{ version: number, body: Uint8Array } | null}
 */
export function unwrap(buf) {
  if (buf.byteLength === 0 || buf[0] !== SENTINEL) return null
  const state = { buffer: buf, start: 1, end: buf.byteLength }
  try {
    const version = c.uint.decode(state)
    return { version, body: buf.subarray(state.start) }
  } catch {
    // any writer can append bytes: a version cut short must not throw inside apply
    return null
  }
}
