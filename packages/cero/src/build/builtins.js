import { CeroError } from '@cero-base/core/errors'
import { COUNTERS, EPOCHS, DB_TYPE } from '../lib/constants.js'
import * as schemas from './schemas.js'

// builtin refs by scope; kind defaults to collection
export const refs = {
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

export function getHyperdbType(prim) {
  return DB_TYPE[prim] || 'string'
}

const at = (ns, n) => `@${ns}/${n}`
const keyOf = (def) => (def.kind === 'single' ? [] : ['id'])

const fields = (map) =>
  Object.entries(map).map(([name, m]) => ({
    name,
    type: getHyperdbType(m.prim),
    required: m.required === true
  }))

// a base field cannot be redeclared
const merge = (type, base, extra) => {
  if (!extra) return base
  for (const k in extra) {
    if (k in base) {
      throw CeroError.INVALID(`'${k}' is a base field of '${type}' and cannot be redeclared`)
    }
  }
  return { ...base, ...extra }
}

const descriptors = (group, extend = {}) =>
  Object.entries(group).map(([name, base]) => ({
    name,
    compact: false,
    fields: fields(merge(name, base, extend[name]))
  }))

export function builtinRefs(ns, scope) {
  return Object.fromEntries(
    Object.entries(refs[scope]).map(([name, def]) => [
      name,
      {
        kind: def.kind || 'collection',
        path: [name],
        builtin: true,
        ...(scope === 'main' && { verb: def.type }),
        schema: at(ns, def.type)
      }
    ])
  )
}

export function builtinTypes(scope, extend) {
  return descriptors(schemas[scope], extend)
}
export function rpcTypes() {
  return descriptors(schemas.rpc)
}

export function builtinCollections(ns, scope) {
  const out = Object.entries(refs[scope]).map(([name, def]) => ({
    name,
    schema: at(ns, def.type),
    key: keyOf(def)
  }))
  if (scope === 'main') {
    out.push({ name: COUNTERS, schema: at(ns, 'counter'), key: ['name'] })
    out.push({ name: EPOCHS, schema: at(ns, 'epoch'), key: ['epoch'] })
  }
  return out
}

export function builtinDispatches(ns) {
  return [
    { name: 'add-writer', requestType: at(ns, 'writer') },
    { name: 'del-writer', requestType: at(ns, 'writer') },
    { name: 'claim-writer', requestType: at(ns, 'claim') },
    ...Object.values(refs.main).flatMap(({ type }) => [
      { name: `add-${type}`, requestType: at(ns, type) },
      { name: `set-${type}`, requestType: at(ns, type) },
      { name: `del-${type}`, requestType: at(ns, 'del-by-id') }
    ])
  ]
}

// after the app's dispatches: hyperdispatch numbers routes positionally and persists them
export function rotateDispatch(ns) {
  return { name: 'rotate-key', requestType: at(ns, 'epoch') }
}

export function rpcCommands(ns) {
  const ref = (n) => at(ns, n)
  return [
    { name: 'init', request: { name: ref('req-empty') }, response: { name: ref('res-identity') } },
    {
      name: 'restore',
      request: { name: ref('req-restore') },
      response: { name: ref('res-identity') }
    },
    { name: 'seed', request: { name: ref('req-empty') }, response: { name: ref('res-seed') } },
    { name: 'add-row', request: { name: ref('req-row') }, response: { name: ref('res-data') } },
    {
      name: 'add-file',
      request: { name: ref('req-add-file') },
      response: { name: ref('res-data') }
    },
    {
      name: 'add-handle',
      request: { name: ref('req-row') },
      response: { name: ref('res-handle') }
    },
    { name: 'set', request: { name: ref('req-row') }, response: { name: ref('res-data') } },
    { name: 'get', request: { name: ref('req-query') }, response: { name: ref('res-rows') } },
    { name: 'get-one', request: { name: ref('req-id') }, response: { name: ref('res-data') } },
    { name: 'del', request: { name: ref('req-id') }, response: { name: ref('res-ok') } },
    { name: 'count', request: { name: ref('req-query') }, response: { name: ref('res-count') } },
    {
      name: 'watch',
      request: { name: ref('req-query') },
      response: { name: ref('res-rows'), stream: true }
    },
    { name: 'call', request: { name: ref('req-call') }, response: { name: ref('res-data') } },
    { name: 'invite', request: { name: ref('req-invite') }, response: { name: ref('res-invite') } },
    { name: 'revoke', request: { name: ref('req-revoke') }, response: { name: ref('res-ok') } },
    { name: 'join', request: { name: ref('req-join') }, response: { name: ref('res-handle') } },
    {
      name: 'open-handle',
      request: { name: ref('req-open') },
      response: { name: ref('res-handle') }
    },
    {
      name: 'close-handle',
      request: { name: ref('req-handle') },
      response: { name: ref('res-ok') }
    },
    { name: 'leave', request: { name: ref('req-handle') }, response: { name: ref('res-ok') } },
    {
      name: 'changes',
      request: { name: ref('req-query') },
      response: { name: ref('res-changes'), stream: true }
    },
    { name: 'rotate', request: { name: ref('req-handle') }, response: { name: ref('res-epoch') } }
  ]
}
