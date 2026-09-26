import { CeroError } from '@cero-base/core/errors'
import { COUNTERS, EPOCHS, REMOVALS } from '../lib/constants.js'
import * as schemas from './schemas.js'

// internal refs by scope; kind defaults to collection
export const defs = {
  main: {
    members: { type: 'member' },
    devices: { type: 'device' },
    invites: { type: 'invite' },
    handles: { type: 'handle' },
    files: { type: 'file' },
    requests: { type: 'request' }
  },
  local: {
    master: { type: 'master', kind: 'single' },
    keypair: { type: 'keypair', kind: 'single' },
    'handle-keypairs': { type: 'handle-keypair' },
    joins: { type: 'join' },
    inbox: { type: 'mail' },
    outbox: { type: 'mail' },
    environment: { type: 'environment', kind: 'single' },
    serving: { type: 'serving' }
  }
}

// computed on the device, never stored: `get` and `watch` read them like any other ref
const LIVE = {
  status: { type: 'status', kind: 'single' },
  joins: { type: 'joining', root: true },
  nearby: { type: 'peer', root: true }
}

/**
 * @typedef {import('../lib/spec.js').RefInfo} RefInfo
 * @typedef {{ prim: string, required?: boolean, array?: boolean }} FieldType  A `t` field.
 * @typedef {{ name: string, type: string, required: boolean, array?: boolean }} Column
 */

/**
 * @param {string} ns
 * @param {boolean} root
 * @returns {Record<string, RefInfo>}
 */
export function live(ns, root) {
  const out = {}
  for (const [name, def] of Object.entries(LIVE)) {
    if (def.root && !root) continue
    out[name] = {
      kind: def.kind || 'collection',
      internal: true,
      live: true,
      schema: `@${ns}/${def.type}`
    }
  }
  return out
}

// a DSL primitive is its hyperdb column type, except bytes (a buffer) and file (an id string)
const COLUMN = { bytes: 'buffer', file: 'string' }

/**
 * @param {Record<string, FieldType>} map
 * @returns {Column[]}
 */
export function fields(map) {
  return Object.entries(map).map(([name, m]) => ({
    name,
    type: COLUMN[m.prim] || m.prim,
    required: m.required === true,
    ...(m.array && { array: true })
  }))
}

// a base field cannot be redeclared
function merge(type, base, extra) {
  if (!extra) return base
  const dup = Object.keys(extra).find((k) => k in base)
  if (dup) throw CeroError.INVALID(`'${dup}' is a base field of '${type}' and cannot be redeclared`)
  return { ...base, ...extra }
}

/**
 * @param {'main' | 'local' | 'rpc'} scope
 * @param {Record<string, Record<string, FieldType>>} [extend]
 * @returns {Array<{ name: string, compact: boolean, fields: Column[] }>}
 */
export function types(scope, extend = {}) {
  return Object.entries(schemas[scope]).map(([name, base]) => ({
    name,
    compact: false,
    fields: fields(merge(name, base, extend[name]))
  }))
}

/**
 * @param {string} ns
 * @param {'main' | 'local'} scope
 * @returns {Record<string, RefInfo & { path: string[] }>}
 */
export function refs(ns, scope) {
  return Object.fromEntries(
    Object.entries(defs[scope]).map(([name, def]) => [
      name,
      {
        kind: def.kind || 'collection',
        path: [name],
        internal: true,
        ...(scope === 'main' && declare({ verb: def.type }, schemas.main[def.type])),
        schema: `@${ns}/${def.type}`
      }
    ])
  )
}

/**
 * Add `fields` to a ref: file ones resolve on read, required ones the RPC client fills on a set.
 *
 * @param {RefInfo} ref
 * @param {Record<string, FieldType>} fields
 * @returns {RefInfo}
 */
export function declare(ref, fields) {
  ref.fields = [...(ref.fields ?? []), ...Object.keys(fields)]
  for (const [name, m] of Object.entries(fields)) {
    if (m.prim === 'file') ref.files = [...(ref.files ?? []), name]
    if (m.required) ref.required = { ...ref.required, [name]: m.prim }
  }
  return ref
}

/**
 * @param {string} ns
 * @param {'main' | 'local'} scope
 * @returns {Array<{ name: string, schema: string, key: string[] }>}
 */
export function collections(ns, scope) {
  const out = Object.entries(defs[scope]).map(([name, def]) => ({
    name,
    schema: `@${ns}/${def.type}`,
    key: def.kind === 'single' ? [] : ['id']
  }))
  if (scope === 'main') {
    out.push({ name: COUNTERS, schema: `@${ns}/counter`, key: ['name'] })
    out.push({ name: EPOCHS, schema: `@${ns}/epoch`, key: ['epoch'] })
    out.push({ name: REMOVALS, schema: `@${ns}/removal`, key: ['id'] })
  }
  return out
}

/**
 * @param {string} ns
 * @returns {Array<{ name: string, requestType: string }>}
 */
export function dispatches(ns) {
  return [
    { name: 'add-writer', requestType: `@${ns}/writer` },
    { name: 'del-writer', requestType: `@${ns}/writer` },
    { name: 'claim-writer', requestType: `@${ns}/claim` },
    ...Object.values(defs.main).flatMap(({ type }) => [
      { name: `add-${type}`, requestType: `@${ns}/${type}` },
      { name: `set-${type}`, requestType: `@${ns}/${type}` },
      { name: `del-${type}`, requestType: `@${ns}/del-by-id` }
    ]),
    { name: 'join', requestType: `@${ns}/join` },
    { name: 'accept', requestType: `@${ns}/accept` }
  ]
}

// hrpc commands: name, request type, response type, streaming response
const COMMANDS = [
  ['init', 'req-empty', 'res-identity'],
  ['restore', 'req-restore', 'res-identity'],
  ['seed', 'req-empty', 'res-seed'],
  ['add-row', 'req-row', 'res-data'],
  ['add-file', 'req-add-file', 'res-data'],
  ['add-handle', 'req-row', 'res-handle'],
  ['set', 'req-row', 'res-data'],
  ['get', 'req-query', 'res-rows'],
  ['del', 'req-id', 'res-ok'],
  ['watch', 'req-query', 'res-rows', true],
  ['call', 'req-call', 'res-data'],
  ['invite', 'req-invite', 'res-invite'],
  ['revoke', 'req-revoke', 'res-ok'],
  ['join', 'req-join', 'res-handle'],
  ['cancel', 'req-cancel', 'res-ok'],
  ['open-handle', 'req-open', 'res-handle'],
  ['close-handle', 'req-handle', 'res-ok'],
  ['leave', 'req-handle', 'res-ok'],
  ['rotate', 'req-handle', 'res-epoch'],
  ['set-active', 'req-set-active', 'res-ok'],
  ['suspend', 'req-handle', 'res-ok'],
  ['resume', 'req-handle', 'res-ok'],
  ['errors', 'req-empty', 'res-error', true],
  ['answer', 'req-answer', 'res-ok'],
  ['nearby', 'req-nearby', 'res-ok']
]

/**
 * @param {string} ns
 * @returns {Array<{ name: string, request: { name: string }, response: { name: string, stream?: boolean } }>}
 */
export function commands(ns) {
  return COMMANDS.map(([name, req, res, stream]) => ({
    name,
    request: { name: `@${ns}/${req}` },
    response: { name: `@${ns}/${res}`, ...(stream && { stream }) }
  }))
}
