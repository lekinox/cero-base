import { join, resolve } from 'path'
import { promises as fs, existsSync, readFileSync } from 'fs'
import { pathToFileURL } from 'url'

import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hyperschema from 'hyperschema'
import HyperdbBuilder from 'hyperdb/builder'
import Hyperdispatch from 'hyperdispatch'
import HRPCBuilder from 'hrpc'

import { CeroError } from '@cero-base/core/errors'

import { NS } from '../lib/constants.js'
import { extensionsOf } from '../extensions/index.js'
import { reserved } from '../lib/reserved.js'
import * as internal from './internal.js'

/**
 * @typedef {import('@cero-base/core/schema').Schema} Schema
 * @typedef {import('@cero-base/core/schema').SchemaDefs} SchemaDefs
 * @typedef {Schema | (SchemaDefs & { local?: SchemaDefs })} SchemaInput
 *
 * @typedef {object} BuildOpts
 * @property {string} [ns]  Namespace prefix for emitted schema ids. Defaults to `'cero'`.
 * @property {string | import('../extensions/index.js').Extension[]} [extensions]  The extensions to fold in. A module specifier, relative to `specDir`, is imported here for its `extensions` export and written into the spec, so every process runs the same list. A list is folded in only, and `cero()` then needs it in its options. The bundled two by default, `[]` for none.
 */

/**
 * Compile a cero schema into wire-level artifacts and write them to disk.
 *
 * @param {string} specDir          Output directory.
 * @param {SchemaInput} schema      Either a `schema(...)` wrapper or its raw defs object.
 * @param {BuildOpts} [opts]
 * @returns {Promise<void>}
 */
export async function build(specDir, schema, { ns = NS, extensions } = {}) {
  const raw = /** @type {SchemaDefs & { local?: SchemaDefs }} */ (schema?.defs || schema)
  if (!raw || typeof raw !== 'object') throw CeroError.REQUIRED('schema')
  const from = str(extensions)
  const exts = extensionsOf(null, from ? await load(from, specDir) : extensions)

  // t.extend entries by internal type: the app schema first, then each extension at its scope
  const extend = {}
  const defs = {}
  const fold = (entries, target, fromExt) => {
    for (const [k, v] of Object.entries(entries)) {
      if (v && v.kind === 'extend') {
        if (v.later) throw CeroError.INVALID(`'${k}' extends a builtin: ${holds}`)
        const type = internal.defs.main[k]?.type
        if (!type) throw CeroError.INVALID(`'${k}' is not an extendable builtin`)
        if ('memberId' in v.fields) throw CeroError.INVALID(written('memberId', k))
        // app schema wins on field conflicts, extensions only add new fields
        extend[type] = fromExt ? { ...v.fields, ...extend[type] } : { ...extend[type], ...v.fields }
      } else if (fromExt && isPlainHandle(v)) {
        fold(v, (target[k] = { ...target[k] }), true) // into the handle type, the app's refs kept
      } else if (!fromExt || !(k in target)) {
        target[k] = v // app schema wins over an extension's default
      }
    }
  }
  fold(raw, defs, false)
  for (const ext of exts) if (ext.schema) fold(ext.schema, defs, true)

  const main = compile(splitMain(defs), ns, 'main', true)
  const local = compile(defs.local || {}, ns, 'local')
  const handles = {}
  for (const [name, child] of Object.entries(splitHandles(defs))) {
    handles[name] = compile(child, ns, 'main', false)
  }
  for (const { meta } of [main, ...Object.values(handles)]) extendBuiltins(meta.refs, extend)

  // a refused build leaves the spec as it was: it is written beside it and moved in whole
  const next = `${specDir}.next`
  await fs.rm(next, { recursive: true, force: true })
  if (existsSync(specDir)) await fs.cp(specDir, next, { recursive: true })
  try {
    emitMain(join(next, 'main'), ns, main, { rpc: true, extend })
    emitLocal(join(next, 'local'), ns, local)
    for (const [name, handle] of Object.entries(handles)) {
      emitMain(join(next, 'handles', name), ns, handle, { rpc: false, extend })
    }

    const dirs = ['main', ...Object.keys(handles).map((n) => join('handles', n))]
    const compiled = [main, ...Object.values(handles)]
    const { version, start, target, dated } = await contract(next, specDir, dirs, compiled, extend)
    // what a write means to Cero: a view applied under older rules applies its log again
    const rules = internal.contract.version
    const app = { version, rules, start, target }
    const meta = {
      ...main.meta,
      ...app,
      ...dated[0],
      local: local.meta,
      handles: Object.fromEntries(
        Object.entries(handles).map(([n, h], i) => [
          n,
          { ...h.meta, type: n, ...app, ...dated[i + 1] }
        ])
      )
    }

    // the type marker tells the runtime which handle type to open
    for (const [name] of Object.entries(handles)) {
      const ref = meta.refs[name]
      if (ref) {
        meta.refs[name] = { kind: 'handle', type: name, schema: `@${ns}/handle`, since: ref.since }
      }
    }

    await fs.writeFile(
      join(next, 'index.js'),
      wireModule(meta, Object.keys(handles), from, extensions),
      'utf-8'
    )
  } catch (err) {
    await fs.rm(next, { recursive: true, force: true })
    throw err
  }
  await fs.rm(specDir, { recursive: true, force: true })
  await fs.rename(next, specDir)
}

const str = (v) => (typeof v === 'string' ? v : null)

async function load(specifier, specDir) {
  const url = specifier.startsWith('.')
    ? pathToFileURL(resolve(specDir, specifier)).href
    : specifier
  const { extensions } = await import(url)
  if (!Array.isArray(extensions)) {
    throw CeroError.INVALID(`'${specifier}' must export an extensions array`)
  }
  return extensions
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
    if (k === 'local' || !isPlainHandle(v)) continue
    if (v.later) throw CeroError.INVALID(`'${k}' is a handle type: ${holds}`)
    out[k] = v
  }
  return out
}

function isPlainHandle(v) {
  return v && typeof v === 'object' && !v.kind && !v.prim
}

function compile(root, ns, scope = 'main', top = false) {
  const ctx = {
    types: [],
    collections: [],
    dispatches: [],
    indexes: [],
    things: [],
    meta: { ns, refs: {} },
    ns,
    scope,
    taken: internal.reserved(ns, scope, top)
  }

  Object.assign(ctx.meta.refs, internal.refs(ns, scope))

  for (const [name, node] of Object.entries(root)) {
    if (!node.kind || node.kind === 'extend') continue
    if (ctx.taken.refs.has(name)) throw CeroError.INVALID(`'${name}' is a builtin ref, rename it`)
    if (name.startsWith('_') || reserved.includes(name)) {
      throw CeroError.INVALID(`'${name}' is taken by the handle or the client, rename it`)
    }
    if (node.kind === 'handle') {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw CeroError.INVALID(
          `'${name}' is not a handle name: a letter, then letters, digits or _; rename it`
        )
      }
      ctx.meta.refs[name] = { kind: 'handle', type: node.type || name, schema: `@${ns}/handle` }
      continue
    }
    register(name, node, ctx)
  }

  if (scope === 'main') Object.assign(ctx.meta.refs, internal.live(ns, top))

  return {
    types: ctx.types,
    collections: ctx.collections,
    dispatches: ctx.dispatches,
    indexes: ctx.indexes,
    things: ctx.things,
    meta: ctx.meta
  }
}

// a field a builtin gains through t.extend is declared like its own
function extendBuiltins(refs, extend) {
  for (const [name, { type }] of Object.entries(internal.defs.main)) {
    if (extend[type]) internal.declare(refs[name], extend[type])
  }
}

const holds = 't.later holds back a field, a collection, a single or an action'

const written = (field, name) => `'${field}' in '${name}' is a field Cero writes, rename it`

function register(name, node, ctx) {
  const fqn = `@${ctx.ns}/${name}`
  const routes = node.kind === 'action' ? [name] : ['add', 'set', 'del'].map((v) => `${v}-${name}`)
  const route = routes.find((r) => ctx.taken.routes.has(r))
  if (route) throw CeroError.INVALID(`'${name}' makes Cero's route '${route}', rename it`)
  if (ctx.taken.types.has(name)) throw CeroError.INVALID(`'${name}' is a builtin type, rename it`)
  const fields = Object.keys(node.fields)
  const marked = fields.filter((f) => node.fields[f].later)
  const held = node.later ? `'${name}'` : marked.length > 0 && `'${marked[0]}' in '${name}'`
  if (ctx.scope === 'local' && held) {
    throw CeroError.INVALID(`${held} is local: t.later holds back what a database shares`)
  }
  ctx.things.push({ name, type: fqn, fields, later: node.later === true, marked })
  if (node.kind === 'action') {
    ctx.types.push({ name, compact: false, fields: internal.fields(node.fields) })
    ctx.dispatches.push({ name, requestType: fqn })
    ctx.meta.refs[name] = { kind: 'action', path: [name], schema: fqn }
    if (node.push) ctx.meta.refs[name].push = true
    return
  }
  if (node.kind === 'single') {
    if ('memberId' in node.fields) throw CeroError.INVALID(written('memberId', name))
    ctx.types.push({ name, compact: false, fields: internal.fields(node.fields) })
    ctx.collections.push({ name, schema: fqn, key: [] })
    ctx.dispatches.push({ name: `set-${name}`, requestType: fqn })
    ctx.dispatches.push({ name: `del-${name}`, requestType: `@${ctx.ns}/del-by-id` })
    ctx.meta.refs[name] = internal.declare(
      { kind: 'single', path: [name], schema: fqn },
      node.fields
    )
    if (node.push) ctx.meta.refs[name].push = true
    return
  }
  if (node.kind === 'collection') {
    const field = internal.base.find((f) => f.name in node.fields)
    if (field) throw CeroError.INVALID(written(field.name, name))
    ctx.types.push({
      name,
      compact: false,
      fields: [...internal.base, ...internal.fields(node.fields)]
    })
    ctx.collections.push({ name, schema: fqn, key: ['id'] })
    ctx.dispatches.push({ name: `add-${name}`, requestType: fqn })
    ctx.dispatches.push({ name: `set-${name}`, requestType: fqn })
    ctx.dispatches.push({ name: `del-${name}`, requestType: `@${ctx.ns}/del-by-id` })
    const refEntry = internal.declare(
      { kind: 'collection', path: [name], schema: fqn },
      node.fields
    )
    if (node.own) refEntry.own = true
    if (node.push) refEntry.push = true
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

// one contract for the app, kept in contract.json: it rises once per build that changes what is
// stored, at the root or in any handle type, or what a write means to Cero, never for RPC alone.
// A spec without one starts from its builders' versions, so a shipped app's number never goes down.
// Its history keeps what each builder was at for every contract, which dates each field, ref and route
async function contract(specDir, prior, dirs, compiled, extend) {
  const file = join(specDir, 'contract.json')
  const kept = await fs.readFile(file, 'utf-8').then(JSON.parse, () => null)
  // apply reads own from the reader's spec, so a collection keeps the one it shipped with
  const own = { ...kept?.own }
  dirs.forEach((dir, i) => {
    const was = own[dir] || {}
    const now = owned(compiled[i].meta.refs)
    for (const [name, on] of Object.entries(now)) {
      if (name in was && was[name] !== on) {
        throw CeroError.INVALID(
          `'${name}' in ${dir} shipped ${on ? 'without' : 'with'} own: a new rule needs a new collection`
        )
      }
    }
    own[dir] = { ...was, ...now }
  })
  const shapes = await Promise.all(dirs.map((dir) => shapeOf(join(specDir, dir))))
  const shape = hash(shapes)
  const version = kept
    ? kept.version + (kept.shape === shape ? 0 : 1)
    : Math.max(...shapes.flatMap((s) => s.versions))

  const rules = internal.contract.version
  const start = kept?.history ? kept.start : (kept?.version ?? version)
  const { floor, history } = await past(kept, prior, dirs, version, start)
  history[version] = Object.fromEntries(dirs.map((dir, i) => [dir, shapes[i].builders]))

  const contracts = Object.keys(history).map(Number)
  const since = (c) => (c === start ? 0 : c)
  const dated = dirs.map((dir, i) => {
    const first = (at, v) => since(contracts.find((c) => history[c][dir]?.[at] >= v))
    const [types, , routes] = shapes[i].stored
    const out = {
      since: {
        routes: Object.fromEntries(routes.schema.map((r) => [r.name, first(1, r.version)])),
        types: Object.fromEntries(
          types.schema.map((type) => [
            `@${type.namespace}/${type.name}`,
            Object.fromEntries(type.fields.map((f) => [f.name, first(0, f.version)]))
          ])
        )
      },
      encoding: Object.fromEntries(
        contracts.filter((c) => history[c][dir]).map((c) => [c, history[c][dir][0]])
      )
    }
    const { ns, refs } = compiled[i].meta
    for (const ref of Object.values(refs)) {
      if (ref.live) ref.since = 0
      else if (ref.kind === 'handle') {
        ref.since = since(contracts.find((c) => history[c][join('handles', ref.type)]))
      } else ref.since = out.since.routes[routeOf(ref, ns)]
    }
    return out
  })

  const target = aim(
    dirs.flatMap((dir, i) => declared(compiled[i], extend, dated[i].since.types)),
    Math.max(kept?.target ?? start, floor),
    version
  )
  await fs.writeFile(
    file,
    JSON.stringify({ version, shape, own, rules, start, floor, target, history }, null, 2) + '\n'
  )
  return { version, start, target, dated }
}

function hash(shapes) {
  const json = JSON.stringify([internal.contract.version, ...shapes.map((s) => s.stored)])
  return b4a.toString(crypto.hash(b4a.from(json)), 'hex')
}

// a spec with no history starts one at its contract, from the builders its own spec was at. It
// kept no rules: hashed under today's, its spec gives the shape it kept only when Cero's rules did
// not change since
async function past(kept, prior, dirs, version, start) {
  if (kept?.history) {
    const floor = kept.rules === internal.contract.version ? kept.floor : version
    return { floor, history: { ...kept.history } }
  }
  const had = dirs.filter((dir) => existsSync(join(prior, dir)))
  const shapes = await Promise.all(had.map((dir) => shapeOf(join(prior, dir))))
  const floor = !kept || hash(shapes) === kept.shape ? start : version
  return {
    floor,
    history: { [start]: Object.fromEntries(had.map((d, i) => [d, shapes[i].builders])) }
  }
}

function routeOf({ kind, path, verb }, ns) {
  if (kind === 'action') return `@${ns}/${path[0]}`
  if (kind === 'single') return `@${ns}/set-${path[0]}`
  return `@${ns}/add-${verb || path[0]}`
}

// every thing the app declares in a directory, with its since and whether t.later holds it back
function declared({ things, meta }, extend, types) {
  const out = []
  for (const { name, type, fields, later, marked } of things) {
    out.push({ label: `'${name}'`, since: meta.refs[name].since, mark: later, held: later })
    for (const f of fields) {
      const mark = marked.includes(f)
      out.push({ label: `'${f}' in '${name}'`, since: types[type][f], mark, held: later || mark })
    }
  }
  // a handle type cannot be held: what it brings turns on with it
  for (const [name, ref] of Object.entries(meta.refs)) {
    if (ref.kind === 'handle') out.push({ label: `'${name}'`, since: ref.since, mark: false })
  }
  for (const [type, fields] of Object.entries(extend)) {
    const ref = Object.keys(internal.defs.main).find((k) => internal.defs.main[k].type === type)
    for (const [f, m] of Object.entries(fields)) {
      const mark = m.later === true
      out.push({
        label: `'${f}' in '${ref}'`,
        since: types[`@${meta.ns}/${type}`][f],
        mark,
        held: mark
      })
    }
  }
  return out
}

// one below the oldest thing held back: things turn on in the order they shipped, and stay on
function aim(things, used, version) {
  const marks = things.filter((x) => x.mark)
  const gone = marks.find((x) => x.since <= used)
  if (gone) {
    throw CeroError.INVALID(
      `${gone.label} is in use already: a database may have it, so t.later cannot hold it back`
    )
  }
  if (marks.length === 0) return version
  const oldest = marks.reduce((a, b) => (b.since < a.since ? b : a))
  const target = oldest.since - 1
  const early = things.find((x) => !x.held && x.since > target)
  if (early) {
    throw CeroError.INVALID(
      `${early.label} shipped with or after ${oldest.label}, which t.later holds back: things turn on in the order they shipped, so mark it too, or release ${oldest.label}`
    )
  }
  return target
}

function owned(refs) {
  return Object.fromEntries(
    Object.entries(refs)
      .filter(([, ref]) => ref.kind === 'collection' && !ref.internal)
      .map(([name, ref]) => [name, ref.own === true])
  )
}

// what a spec directory stores: its collections, its routes and the types they name, nothing else in schema.json
async function shapeOf(dir) {
  const read = async (rel) => JSON.parse(await fs.readFile(join(dir, rel), 'utf-8'))
  const { version: types, ...schema } = await read('schema/schema.json')
  const { version: db, ...collections } = await read('db/db.json')
  const { version: dispatch, ...routes } = await read('dispatch/dispatch.json')
  const named = new Set([
    ...collections.schema.map((x) => x.schema),
    ...routes.schema.map((x) => x.requestType)
  ])
  schema.schema = schema.schema.filter((type) => named.has(`@${type.namespace}/${type.name}`))
  return {
    stored: [schema, collections, routes],
    versions: [types || 1, db || 1, dispatch || 1],
    builders: [types || 1, dispatch || 1]
  }
}

function emitMain(dir, ns, { types, collections, dispatches, indexes = [] }, { rpc, extend = {} }) {
  const schemaDir = join(dir, 'schema')
  const dbDir = join(dir, 'db')
  const dispatchDir = join(dir, 'dispatch')
  const rpcDir = join(dir, 'rpc')

  const s = Hyperschema.from(schemaDir)
  const sns = s.namespace(ns)
  const stored = [...internal.collections(ns, 'main'), ...collections].map((x) => x.schema)
  const routes = [...internal.dispatches(ns), ...dispatches, ...internal.appended(ns)]
  const sent = routes.map((x) => x.requestType)
  const keep = slots(schemaDir, ns, new Set([...stored, ...sent]))
  for (const desc of internal.types('main', extend)) sns.register(keep(desc))
  for (const desc of types) sns.register(keep(desc))
  if (rpc) for (const desc of internal.types('rpc')) sns.register(keep(desc))
  Hyperschema.toDisk(s, schemaDir, { esm: true })

  const db = HyperdbBuilder.from(schemaDir, dbDir)
  const dns = db.namespace(ns)
  for (const desc of internal.collections(ns, 'main')) dns.collections.register(desc)
  for (const desc of collections) dns.collections.register(desc)
  for (const desc of indexes) dns.indexes.register(desc)
  // after the app's: indexes number by position, and the app's keep theirs
  for (const desc of internal.indexes(ns, 'main')) dns.indexes.register(desc)
  HyperdbBuilder.toDisk(db, dbDir, { esm: true })

  const d = Hyperdispatch.from(schemaDir, dispatchDir)
  const xns = d.namespace(ns)
  const numbered = routeIds(dispatchDir, ns, routes)
  for (const desc of routes) xns.register(numbered(desc))
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
  const stored = [...internal.collections(ns, 'local'), ...collections].map((x) => x.schema)
  const keep = slots(schemaDir, ns, new Set(stored))
  for (const desc of internal.types('local')) sns.register(keep(desc))
  for (const desc of types) sns.register(keep(desc))
  Hyperschema.toDisk(s, schemaDir, { esm: true })

  const db = HyperdbBuilder.from(schemaDir, dbDir)
  const dns = db.namespace(ns)
  for (const desc of internal.collections(ns, 'local')) dns.collections.register(desc)
  for (const desc of collections) dns.collections.register(desc)
  for (const desc of indexes) dns.indexes.register(desc)
  HyperdbBuilder.toDisk(db, dbDir, { esm: true })
}

// a route keeps the id the built spec gave it, and one the spec lacks takes the next free: its id
// is what an op starts with on the wire, and left to hyperdispatch a new route takes its position
// in the list, which a route registered after it already has
function routeIds(dispatchDir, ns, routes) {
  const file = join(dispatchDir, 'dispatch.json')
  const built = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')).schema : []
  // a built route stays in the spec: with no handler left for it, the first write would fail
  const names = new Set(routes.map((route) => `@${ns}/${route.name}`))
  const gone = built.find((route) => !names.has(route.name))
  if (gone) {
    throw CeroError.INVALID(
      `route '${gone.name}' shipped and this schema lacks it: every log holds writes to it, so what shipped stays declared as it was`
    )
  }
  const had = new Map(built.map((route) => [route.name, route.id]))
  let next = built.reduce((max, route) => Math.max(max, route.id + 1), 0)
  return (desc) => ({ ...desc, id: had.get(`@${ns}/${desc.name}`) ?? next++ })
}

// a field keeps the slot the built spec gave it, whichever schema declares it: hyperschema stores
// a row by position, and a type's fields are cero's, then its extensions', then the app's, so one
// more of cero's would take an extension's slot. A field the spec lacks goes after the ones it has
function slots(schemaDir, ns, stored) {
  const file = join(schemaDir, 'schema.json')
  const built = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')).schema : []
  const had = new Map(
    built
      .filter((x) => x.namespace === ns && x.fields)
      .map((x) => [x.name, x.fields.map((f) => f.name)])
  )
  return (desc) => {
    const names = had.get(desc.name)
    if (!names || !desc.fields) return desc
    const lost = (n) => !desc.fields.some((f) => f.name === n)
    const kept = stored.has(`@${ns}/${desc.name}`)
    const gone = kept && names.find(lost)
    if (gone) {
      throw CeroError.INVALID(
        `'${gone}' was removed from '${desc.name}': fields are stored by position`
      )
    }
    // a required field is stored with no sign of its absence: a row written before it would not decode
    const late = kept && desc.fields.find((f) => f.required && !names.includes(f.name))
    if (late) {
      throw CeroError.INVALID(
        `'${late.name}' on '${desc.name}' is required, and rows stored before it lack it: add it without required`
      )
    }
    const at = (f) => (names.includes(f.name) ? names.indexOf(f.name) : names.length)
    return { ...desc, fields: desc.fields.toSorted((a, b) => at(a) - at(b)) }
  }
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

// the spec carries the list cero() runs, so every process runs the same one; a list of objects
// given to build cannot be written, so cero() asks for it
function named(from, list) {
  if (from) return `import { extensions } from '${from}'`
  if (!list) return "import { bundled as extensions } from '@cero-base/cero/extensions'"
  return `const extensions = ${list.length === 0 ? '[]' : 'null'}`
}

function wireModule(meta, names, from, list) {
  const kinds = ['database', 'dispatch', 'schema']
  return `// autogenerated by cero/build
import database from './main/db/index.js'
import * as dispatch from './main/dispatch/index.js'
import * as schema from './main/schema/index.js'
import rpc from './main/rpc/index.js'
import localDatabase from './local/db/index.js'
import * as localSchema from './local/schema/index.js'
${handleImports(names, kinds)}
${named(from, list)}

export const meta = ${JSON.stringify(meta, null, 2)}

export const spec = {
  database,
  dispatch,
  schema,
  rpc,
  local: { database: localDatabase, schema: localSchema, meta: meta.local },
  meta,
  extensions,
  handles: {
${handleEntries(names, kinds)}
  }
}
`
}
