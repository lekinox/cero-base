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
 * Split an op into contract version and payload. Ops written before the
 * envelope existed carry no sentinel and read as version 0.
 *
 * @param {Uint8Array} buf
 * @returns {{ version: number, body: Uint8Array }}
 */
export function unwrap(buf) {
  if (buf.byteLength === 0 || buf[0] !== SENTINEL) return { version: 0, body: buf }
  const state = { buffer: buf, start: 1, end: buf.byteLength }
  const version = c.uint.decode(state)
  return { version, body: buf.subarray(state.start) }
}
