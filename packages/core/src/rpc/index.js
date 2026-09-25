import b4a from 'b4a'
import c from 'compact-encoding'

import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'

export { RPCServer } from './server.js'
export { RPCClient } from './client.js'

const EMPTY = b4a.alloc(0)

// fallback envelope encodings when the spec has none
const DEFAULT_ROWS = getEncoding('@cero/rows')
const DEFAULT_QUERY = getEncoding('@cero/query')
const DEFAULT_CREATE = getEncoding('@cero/create')

/**
 * @typedef {object} Spec
 * @property {{ encode: (type: string, value: unknown) => Uint8Array, decode: (type: string, buf: Uint8Array) => unknown, getEncoding?: (name: string) => import('compact-encoding').Encoder }} schema   hyperschema-shaped module.
 * @property {{ ns?: string }} [meta]                                                                                                                              Optional metadata; `ns` controls envelope type fqns.
 * @property {new (stream: import('streamx').Duplex) => object} [rpc]                                                                                             hrpc constructor used by RPCServer/RPCClient.
 * @property {Codec} [codec]                                                                                                                                      Filled in by `bindCodec`.
 *
 * @typedef {object} Codec
 * @property {(type: string, row: Record<string, unknown>) => Uint8Array} encodeRow
 * @property {(type: string, buf: Uint8Array) => Record<string, unknown>} decodeRow
 * @property {(type: string, rows: Record<string, unknown>[]) => Uint8Array} encodeRows
 * @property {(type: string, buf: Uint8Array) => Record<string, unknown>[]} decodeRows
 * @property {(q: Record<string, unknown>) => Uint8Array} encodeQuery
 * @property {(buf: Uint8Array) => Record<string, unknown>} decodeQuery
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

  const ns = spec.meta?.ns
  const ROWS = ns ? `@${ns}/rows` : null
  const QUERY = ns ? `@${ns}/query` : null
  const CREATE = ns ? `@${ns}/create` : null

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
      return encodeEnvelope(schema, ROWS, DEFAULT_ROWS, { data })
    },
    decodeRows(type, buf) {
      if (!buf || buf.length === 0) return []
      const env = decodeEnvelope(schema, ROWS, DEFAULT_ROWS, buf)
      const data = env?.data || []
      return data.map((b) => schema.decode(type, b))
    },
    encodeQuery(q) {
      if (q == null) return encodeEnvelope(schema, QUERY, DEFAULT_QUERY, {})
      const { gt, gte, lt, lte, limit, reverse, ...rest } = q
      const env = { gt, gte, lt, lte, limit, reverse }
      if (Object.keys(rest).length > 0) env.data = rest
      return encodeEnvelope(schema, QUERY, DEFAULT_QUERY, env)
    },
    decodeQuery(buf) {
      if (!buf || buf.length === 0) return undefined
      const env = decodeEnvelope(schema, QUERY, DEFAULT_QUERY, buf)
      const out = {}
      // hyperschema fills optional fields with 0/false, so only truthy fields are recovered; limit: 0 is lost
      if (env.gt) out.gt = env.gt
      if (env.gte) out.gte = env.gte
      if (env.lt) out.lt = env.lt
      if (env.lte) out.lte = env.lte
      if (env.limit) out.limit = env.limit
      if (env.reverse) out.reverse = env.reverse
      if (env.data) Object.assign(out, env.data)
      return Object.keys(out).length === 0 ? undefined : out
    },
    encodeCreate(row) {
      if (row == null) return EMPTY
      return encodeEnvelope(schema, CREATE, DEFAULT_CREATE, row)
    },
    decodeCreate(buf) {
      if (!buf || buf.length === 0) return {}
      return decodeEnvelope(schema, CREATE, DEFAULT_CREATE, buf)
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

// the spec's own envelope type first, the built-in @cero encoding as fallback
function encodeEnvelope(schema, fqn, fallback, value) {
  if (fqn && schemaHas(schema, fqn)) return schema.encode(fqn, value)
  return c.encode(fallback, value)
}

function decodeEnvelope(schema, fqn, fallback, buf) {
  if (fqn && schemaHas(schema, fqn)) return schema.decode(fqn, buf)
  return c.decode(fallback, buf)
}

function schemaHas(schema, name) {
  if (typeof schema.getEncoding !== 'function') return false
  try {
    return schema.getEncoding(name) != null
  } catch {
    return false
  }
}
