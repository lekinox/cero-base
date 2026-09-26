import b4a from 'b4a'
import c from 'compact-encoding'

import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'

export { RPCServer } from './server.js'
export { RPCClient } from './client.js'

const EMPTY = b4a.alloc(0)

const ROWS = getEncoding('@cero/rows')
const CREATE = getEncoding('@cero/create')

/**
 * @typedef {object} Spec
 * @property {{ encode: (type: string, value: unknown) => Uint8Array, decode: (type: string, buf: Uint8Array) => unknown }} schema   hyperschema-shaped module.
 * @property {new (stream: import('streamx').Duplex) => object} [rpc]                                    hrpc constructor used by RPCServer/RPCClient.
 * @property {Codec} [codec]                                                                             Filled in by `bindCodec`.
 *
 * @typedef {object} Codec
 * @property {(type: string, row: Record<string, unknown>) => Uint8Array} encodeRow
 * @property {(type: string, buf: Uint8Array) => Record<string, unknown>} decodeRow
 * @property {(type: string, rows: Record<string, unknown>[]) => Uint8Array} encodeRows
 * @property {(type: string, buf: Uint8Array) => Record<string, unknown>[]} decodeRows
 * @property {(row: Record<string, unknown>) => Uint8Array} encodeCreate
 * @property {(buf: Uint8Array) => Record<string, unknown>} decodeCreate
 * @property {(handle: Record<string, { schema?: string }>, op: string, data: unknown) => Uint8Array} encodeAction
 * @property {(handle: Record<string, { schema?: string }>, op: string, buf: Uint8Array) => unknown} decodeAction
 */

/**
 * Attach a `codec` namespace to a hyperschema-shaped `spec`.
 *
 * @param {Spec} spec
 * @returns {Spec}
 */
export function bindCodec(spec) {
  if (!spec) throw CeroError.REQUIRED('spec')
  const schema = spec.schema
  if (!schema) throw CeroError.REQUIRED('spec.schema')

  spec.codec = {
    encodeRow(type, row) {
      if (row == null) return EMPTY
      return schema.encode(type, row)
    },
    decodeRow(type, buf) {
      if (!buf || buf.length === 0) return undefined
      return schema.decode(type, buf)
    },
    encodeRows(type, rows) {
      const data = (rows ?? []).map((r) => schema.encode(type, r))
      return c.encode(ROWS, { data })
    },
    decodeRows(type, buf) {
      if (!buf || buf.length === 0) return []
      const { data } = c.decode(ROWS, buf)
      return (data || []).map((b) => schema.decode(type, b))
    },
    encodeCreate(row) {
      if (row == null) return EMPTY
      return c.encode(CREATE, row)
    },
    decodeCreate(buf) {
      if (!buf || buf.length === 0) return {}
      return c.decode(CREATE, buf)
    },
    encodeAction(handle, op, data) {
      const ref = handle?.[op]
      if (!ref || !ref.schema) throw CeroError.UNKNOWN('action', op)
      if (data == null) return EMPTY
      return schema.encode(ref.schema, data)
    },
    decodeAction(handle, op, buf) {
      const ref = handle?.[op]
      if (!ref || !ref.schema) throw CeroError.UNKNOWN('action', op)
      if (!buf || buf.length === 0) return undefined
      return schema.decode(ref.schema, buf)
    }
  }
  return spec
}
