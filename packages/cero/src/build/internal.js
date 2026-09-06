import { CeroError } from '@cero-base/core/errors'
import { COUNTERS, EPOCHS } from '../lib/constants.js'
import * as schemas from './schemas.js'

// internal refs by scope; kind defaults to collection
export const defs = {
  main: {
    members: { type: 'member' },
    devices: { type: 'device' },
    invites: { type: 'invite' },
    handles: { type: 'handle' },
    files: { type: 'file' }
  },
  local: {
    master: { type: 'master', kind: 'single' },
    keypair: { type: 'keypair', kind: 'single' },
    'handle-keypairs': { type: 'handle-keypair' },
    environment: { type: 'environment', kind: 'single' }
  }
}

// a DSL primitive is its hyperdb column type, except bytes (a buffer) and file (an id string)
const COLUMN = { bytes: 'buffer', file: 'string' }

export function fields(map) {
  return Object.entries(map).map(([name, m]) => ({
    name,
    type: COLUMN[m.prim] || m.prim,
    required: m.required === true
  }))
}

// a base field cannot be redeclared
function merge(type, base, extra) {
  if (!extra) return base
  const dup = Object.keys(extra).find((k) => k in base)
  if (dup) throw CeroError.INVALID(`'${dup}' is a base field of '${type}' and cannot be redeclared`)
  return { ...base, ...extra }
}

export function types(scope, extend = {}) {
  return Object.entries(schemas[scope]).map(([name, base]) => ({
    name,
    compact: false,
    fields: fields(merge(name, base, extend[name]))
  }))
}

export function refs(ns, scope) {
  return Object.fromEntries(
    Object.entries(defs[scope]).map(([name, def]) => [
      name,
      {
        kind: def.kind || 'collection',
        path: [name],
        internal: true,
        ...(scope === 'main' && { verb: def.type }),
        schema: `@${ns}/${def.type}`
      }
    ])
  )
}

export function collections(ns, scope) {
  const out = Object.entries(defs[scope]).map(([name, def]) => ({
    name,
    schema: `@${ns}/${def.type}`,
    key: def.kind === 'single' ? [] : ['id']
  }))
  if (scope === 'main') {
    out.push({ name: COUNTERS, schema: `@${ns}/counter`, key: ['name'] })
    out.push({ name: EPOCHS, schema: `@${ns}/epoch`, key: ['epoch'] })
  }
  return out
}

export function dispatches(ns) {
  return [
    { name: 'add-writer', requestType: `@${ns}/writer` },
    { name: 'del-writer', requestType: `@${ns}/writer` },
    { name: 'claim-writer', requestType: `@${ns}/claim` },
    ...Object.values(defs.main).flatMap(({ type }) => [
      { name: `add-${type}`, requestType: `@${ns}/${type}` },
      { name: `set-${type}`, requestType: `@${ns}/${type}` },
      { name: `del-${type}`, requestType: `@${ns}/del-by-id` }
    ])
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
  ['get-one', 'req-id', 'res-data'],
  ['del', 'req-id', 'res-ok'],
  ['count', 'req-query', 'res-count'],
  ['watch', 'req-query', 'res-rows', true],
  ['call', 'req-call', 'res-data'],
  ['invite', 'req-invite', 'res-invite'],
  ['revoke', 'req-revoke', 'res-ok'],
  ['join', 'req-join', 'res-handle'],
  ['open-handle', 'req-open', 'res-handle'],
  ['close-handle', 'req-handle', 'res-ok'],
  ['leave', 'req-handle', 'res-ok'],
  ['changes', 'req-query', 'res-changes', true],
  ['rotate', 'req-handle', 'res-epoch']
]

export function commands(ns) {
  return COMMANDS.map(([name, req, res, stream]) => ({
    name,
    request: { name: `@${ns}/${req}` },
    response: { name: `@${ns}/${res}`, ...(stream && { stream }) }
  }))
}
