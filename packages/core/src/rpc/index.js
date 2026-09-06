import b4a from 'b4a'
import c from 'compact-encoding'

import { getEncoding } from '../lib/spec/index.js'
import { CeroError } from '../lib/errors.js'

export { RPCServer } from './server.js'
export { RPCClient } from './client.js'

const EMPTY = b4a.alloc(0)

// fallback envelope encodings when the spec has none
const DEFAULT_ROWS = getEncoding('@cero/rows')
const DEFAULT_CHANGES = getEncoding('@cero/changes')
const DEFAULT_QUERY = getEncoding('@cero/query')
const DEFAULT_CREATE = getEncoding('@cero/create')

/**
 * @typedef {object} Spec
 * @property {{ encode: (type: string, value: any) => Uint8Array, decode: (type: string, buf: Uint8Array) => any, getEncoding?: (name: string) => any }} schema   hyperschema-shaped module.
 * @property {{ ns?: string }} [meta]                                                                                                                              Optional metadata; `ns` controls envelope type fqns.
 * @property {any} [rpc]                                                                                                                                          hrpc constructor used by RPCServer/RPCClient.
 * @property {Codec} [codec]                                                                                                                                      Filled in by `bindCodec`.
 *
 * @typedef {object} Codec
 * @property {(type: string, row: any) => Uint8Array} encodeRow
 * @property {(type: string, buf: Uint8Array) => any} decodeRow
 * @property {(type: string, rows: any[]) => Uint8Array} encodeRows
 * @property {(type: string, changes: Array<{ prev: any, next: any }>) => Uint8Array} encodeChanges
 * @property {(type: string, buf: Uint8Array) => Array<{ prev: any, next: any }>} decodeChanges
 * @property {(type: string, buf: Uint8Array) => any[]} decodeRows
 * @property {(q: any) => Uint8Array} encodeQuery
 * @property {(buf: Uint8Array) => any} decodeQuery
 * @property {(row: any) => Uint8Array} encodeCreate
 * @property {(buf: Uint8Array) => any} decodeCreate
 * @property {(handle: any, op: string, data: any) => Uint8Array} encodeAction
 * @property {(handle: any, op: string, buf: Uint8Array) => any} decodeAction
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
  const CHANGES = ns ? `@${ns}/changes` : null
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
    encodeChanges(type, changes) {
      const prev = changes.map((x) => (x.prev ? schema.encode(type, x.prev) : EMPTY))
      const next = changes.map((x) => (x.next ? schema.encode(type, x.next) : EMPTY))
      return encodeEnvelope(schema, CHANGES, DEFAULT_CHANGES, { prev, next })
    },
    decodeChanges(type, buf) {
      if (!buf || buf.length === 0) return []
      const env = decodeEnvelope(schema, CHANGES, DEFAULT_CHANGES, buf)
      const prev = env?.prev || []
      const next = env?.next || []
      const out = []
      for (let i = 0; i < Math.max(prev.length, next.length); i++) {
        out.push({
          prev: prev[i]?.length ? schema.decode(type, prev[i]) : null,
          next: next[i]?.length ? schema.decode(type, next[i]) : null
        })
      }
      return out
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
