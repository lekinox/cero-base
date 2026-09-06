import { join } from 'path'
import { promises as fs } from 'fs'

import Hyperschema from 'hyperschema'
import HyperdbBuilder from 'hyperdb/builder'
import Hyperdispatch from 'hyperdispatch'
import HRPCBuilder from 'hrpc'

import { CeroError } from '@cero-base/core/errors'

import { NS } from '../lib/constants.js'
import { registry } from '../extensions/index.js'
import * as internal from './internal.js'

/**
 * @typedef {import('@cero-base/core/schema').Schema} Schema
 * @typedef {import('@cero-base/core/schema').SchemaDefs} SchemaDefs
 * @typedef {Schema | (SchemaDefs & { local?: SchemaDefs })} SchemaInput
 *
 * @typedef {object} BuildOpts
 * @property {string} [ns]  Namespace prefix for emitted schema ids. Defaults to `'cero'`.
 */

/**
 * Compile a cero schema into wire-level artifacts and write them to disk.
 *
 * @param {string} specDir          Output directory.
 * @param {SchemaInput} schema      Either a `schema(...)` wrapper or its raw defs object.
 * @param {BuildOpts} [opts]
 * @returns {Promise<void>}
 */
export async function build(specDir, schema, { ns = NS, extensions = true } = {}) {
  const raw = /** @type {SchemaDefs & { local?: SchemaDefs }} */ (schema?.defs || schema)
  if (!raw || typeof raw !== 'object') throw CeroError.REQUIRED('schema')

  // t.extend entries by internal type: app schema first, then each extension
  const extend = {}
  const defs = {}
  const collect = (entries, fromExt = false) => {
    for (const [k, v] of Object.entries(entries)) {
      if (v && v.kind === 'extend') {
        const type = internal.defs.main[k]?.type
        if (!type) throw CeroError.INVALID(`'${k}' is not an extendable builtin`)
        // app schema wins on field conflicts, extensions only add new fields
        extend[type] = fromExt ? { ...v.fields, ...extend[type] } : { ...extend[type], ...v.fields }
      } else if (!fromExt || !(k in defs)) {
        defs[k] = v // app schema wins over an extension's default
      }
    }
  }
  collect(raw)
  for (const ext of registry) {
    if (ext.bundled && extensions === false) continue
    if (ext.schema) collect(ext.schema, true)
  }

  const main = compile(splitMain(defs), ns, 'main')
  const local = compile(defs.local || {}, ns, 'local')
  const handles = {}
  for (const [name, child] of Object.entries(splitHandles(defs))) {
    handles[name] = compile(child, ns, 'main')
  }

  emitMain(join(specDir, 'main'), ns, main, { rpc: true, extend })
  emitLocal(join(specDir, 'local'), ns, local)
  for (const [name, handle] of Object.entries(handles)) {
    emitMain(join(specDir, 'handles', name), ns, handle, { rpc: false, extend })
  }

  const meta = {
    ...main.meta,
    version: await contractVersion(join(specDir, 'main')),
    local: local.meta,
    handles: Object.fromEntries(
      Object.entries(handles).map(([n, h]) => [n, { ...h.meta, type: n }])
    )
  }

  // the type marker tells the runtime which handle type to open
  for (const [name] of Object.entries(handles)) {
    if (meta.refs[name]) meta.refs[name] = { kind: 'handle', type: name, schema: `@${ns}/handle` }
  }

  await fs.writeFile(join(specDir, 'index.js'), wireModule(meta, Object.keys(handles)), 'utf-8')
}

function splitMain(defs) {
  const out = {}
  for (const [k, v] of Object.entries(defs)) {
    if (k === 'local') continue
    if (isPlainHandle(v)) {
      out[k] = { kind: 'handle', type: k }
      continue
    }
    out[k] = v
  }
  return out
}

function splitHandles(defs) {
  const out = {}
  for (const [k, v] of Object.entries(defs)) {
    if (k === 'local') continue
    if (isPlainHandle(v)) out[k] = v
  }
  return out
}

function isPlainHandle(v) {
  return v && typeof v === 'object' && !v.kind && !v.prim
}

function compile(root, ns, scope = 'main') {
  const ctx = {
    types: [],
    collections: [],
    dispatches: [],
    indexes: [],
    meta: { ns, refs: {} },
    ns,
    scope
  }

  Object.assign(ctx.meta.refs, internal.refs(ns, scope))

  for (const [name, node] of Object.entries(root)) {
    if (node.kind === 'handle') {
      ctx.meta.refs[name] = { kind: 'handle', type: node.type || name, schema: `@${ns}/handle` }
      continue
    }
    register(name, node, ctx)
  }

  return {
    types: ctx.types,
    collections: ctx.collections,
    dispatches: ctx.dispatches,
    indexes: ctx.indexes,
    meta: ctx.meta
  }
}

function fileFieldNames(fields) {
  return Object.entries(fields)
    .filter(([, m]) => m.prim === 'file')
    .map(([name]) => name)
}

function register(name, node, ctx) {
  const fqn = `@${ctx.ns}/${name}`
  if (node.kind === 'action') {
    ctx.types.push({ name, compact: false, fields: internal.fields(node.fields) })
    ctx.dispatches.push({ name, requestType: fqn })
    ctx.meta.refs[name] = { kind: 'action', path: [name], schema: fqn }
    return
  }
  if (node.kind === 'single') {
    ctx.types.push({ name, compact: false, fields: internal.fields(node.fields) })
    ctx.collections.push({ name, schema: fqn, key: [] })
    ctx.dispatches.push({ name: `set-${name}`, requestType: fqn })
    ctx.dispatches.push({ name: `del-${name}`, requestType: `@${ctx.ns}/del-by-id` })
    const refEntry = { kind: 'single', path: [name], schema: fqn, fields: Object.keys(node.fields) }
    const fileFields = fileFieldNames(node.fields)
    if (fileFields.length) refEntry.files = fileFields
    ctx.meta.refs[name] = refEntry
    return
  }
  if (node.kind === 'collection') {
    ctx.types.push({
      name,
      compact: false,
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'memberId', type: 'string', required: false },
        { name: 'index', type: 'uint', required: false },
        { name: 'createdAt', type: 'int', required: false },
        { name: 'updatedAt', type: 'int', required: false },
        ...internal.fields(node.fields)
      ]
    })
    ctx.collections.push({ name, schema: fqn, key: ['id'] })
    ctx.dispatches.push({ name: `add-${name}`, requestType: fqn })
    ctx.dispatches.push({ name: `set-${name}`, requestType: fqn })
    ctx.dispatches.push({ name: `del-${name}`, requestType: `@${ctx.ns}/del-by-id` })
    const refEntry = {
      kind: 'collection',
      path: [name],
      schema: fqn,
      fields: Object.keys(node.fields)
    }
    if (node.own) refEntry.own = true
    const fileFields = fileFieldNames(node.fields)
    if (fileFields.length) refEntry.files = fileFields
    ctx.meta.refs[name] = refEntry
    if (node.indexes) {
      for (const [idx, fields] of Object.entries(node.indexes)) {
        ctx.indexes.push({ name: `${name}-${idx}`, collection: fqn, key: fields })
      }
      ctx.meta.refs[name].indexes = node.indexes
    }
    // implicit index on the auto-increment `index`, so reverse and limit push down; main scope only
    if (ctx.scope === 'main' && !node.indexes?.index) {
      ctx.indexes.push({ name: `${name}-index`, collection: fqn, key: ['index'] })
      refEntry.orderIndex = true
    }
  }
}

// the contract version is the highest of the schema, db and dispatch versions
async function contractVersion(mainDir) {
  const read = async (rel) => {
    const j = JSON.parse(await fs.readFile(join(mainDir, rel), 'utf-8'))
    return j.version || 1
  }
  const versions = await Promise.all([
    read('schema/schema.json'),
    read('db/db.json'),
    read('dispatch/dispatch.json')
  ])
  return Math.max(...versions)
}

function emitMain(dir, ns, { types, collections, dispatches, indexes = [] }, { rpc, extend = {} }) {
  const schemaDir = join(dir, 'schema')
  const dbDir = join(dir, 'db')
  const dispatchDir = join(dir, 'dispatch')
  const rpcDir = join(dir, 'rpc')

  const s = Hyperschema.from(schemaDir)
  const sns = s.namespace(ns)
  for (const desc of internal.types('main', extend)) sns.register(desc)
  for (const desc of types) sns.register(desc)
  if (rpc) for (const desc of internal.types('rpc')) sns.register(desc)
  Hyperschema.toDisk(s, schemaDir, { esm: true })

  const db = HyperdbBuilder.from(schemaDir, dbDir)
  const dns = db.namespace(ns)
  for (const desc of internal.collections(ns, 'main')) dns.collections.register(desc)
  for (const desc of collections) dns.collections.register(desc)
  for (const desc of indexes) dns.indexes.register(desc)
  HyperdbBuilder.toDisk(db, dbDir, { esm: true })

  const d = Hyperdispatch.from(schemaDir, dispatchDir)
  const xns = d.namespace(ns)
  for (const desc of internal.dispatches(ns)) xns.register(desc)
  for (const desc of dispatches) xns.register(desc)
  // after the app's dispatches: hyperdispatch numbers routes positionally and persists them
  xns.register({ name: 'rotate-key', requestType: `@${ns}/epoch` })
  Hyperdispatch.toDisk(d, dispatchDir, { esm: true })

  if (rpc) {
    const r = HRPCBuilder.from(schemaDir, rpcDir)
    const rns = r.namespace(ns)
    for (const desc of internal.commands(ns)) rns.register(desc)
    HRPCBuilder.toDisk(r, rpcDir, { esm: true })
  }
}

function emitLocal(dir, ns, { types, collections, indexes = [] }) {
  const schemaDir = join(dir, 'schema')
  const dbDir = join(dir, 'db')

  const s = Hyperschema.from(schemaDir)
  const sns = s.namespace(ns)
  for (const desc of internal.types('local')) sns.register(desc)
  for (const desc of types) sns.register(desc)
  Hyperschema.toDisk(s, schemaDir, { esm: true })

  const db = HyperdbBuilder.from(schemaDir, dbDir)
  const dns = db.namespace(ns)
  for (const desc of internal.collections(ns, 'local')) dns.collections.register(desc)
  for (const desc of collections) dns.collections.register(desc)
  for (const desc of indexes) dns.indexes.register(desc)
  HyperdbBuilder.toDisk(db, dbDir, { esm: true })
}

const IMPORTS = {
  database: (n) => `import ${n}Database from './handles/${n}/db/index.js'`,
  dispatch: (n) => `import * as ${n}Dispatch from './handles/${n}/dispatch/index.js'`,
  schema: (n) => `import * as ${n}Schema from './handles/${n}/schema/index.js'`
}

const cap = (s) => s[0].toUpperCase() + s.slice(1)

function handleImports(names, kinds) {
  return names.flatMap((n) => kinds.map((k) => IMPORTS[k](n))).join('\n')
}

function handleEntries(names, kinds) {
  return names
    .map((n) => {
      const parts = kinds.map((k) => `${k}: ${n}${cap(k)}`).join(', ')
      return `    ${n}: { ${parts}, meta: meta.handles.${n} }`
    })
    .join(',\n')
}

function wireModule(meta, names) {
  const kinds = ['database', 'dispatch', 'schema']
  return `// autogenerated by cero/build
import database from './main/db/index.js'
import * as dispatch from './main/dispatch/index.js'
import * as schema from './main/schema/index.js'
import rpc from './main/rpc/index.js'
import localDatabase from './local/db/index.js'
import * as localSchema from './local/schema/index.js'
${handleImports(names, kinds)}

export const meta = ${JSON.stringify(meta, null, 2)}

export const spec = {
  database,
  dispatch,
  schema,
  rpc,
  local: { database: localDatabase, schema: localSchema, meta: meta.local },
  meta,
  handles: {
${handleEntries(names, kinds)}
  }
}
`
}
