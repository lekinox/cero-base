import { CeroError } from './errors.js'
import { SINGLE, COLLECTION, ACTION } from './constants.js'

/**
 * @typedef {{ prim: string, required?: boolean }} Prim
 * @typedef {{ kind: 'single' | 'collection' | 'action', fields: Record<string, Prim>, indexes?: Record<string, string[]>, own?: boolean, push?: boolean }} TypeDef
 * @typedef {{ [name: string]: TypeDef | Record<string, TypeDef> } & { local?: Record<string, TypeDef> }} SchemaDefs
 * @typedef {{ defs: SchemaDefs }} Schema
 */

/** @param {string} name @returns {Prim} */
const prim = (name) => ({ prim: name })

/**
 * Schema DSL. Primitive field types and kind-constructors used to describe
 * a database's tables before the builder turns them into a wire spec.
 */
export const t = {
  string: prim('string'),
  uint: prim('uint'),
  int: prim('int'),
  bool: prim('bool'),
  bytes: prim('bytes'),
  json: prim('json'),
  fixed32: prim('fixed32'),
  fixed64: prim('fixed64'),

  file: prim('file'),

  /**
   * Mark a field as required. Fields are optional by default.
   *
   * @param {Prim} marker
   * @returns {Prim}
   */
  required: (marker) => ({ ...marker, required: true }),

  /**
   * Single-row table (one record, set/get by name).
   *
   * @param {Record<string, Prim>} fields
   * @param {{ push?: boolean }} [opts]  `push`: a write pushes a notification, see collection.
   * @returns {TypeDef}
   */
  single(fields, opts) {
    const def = { kind: SINGLE, fields }
    if (opts?.push) def.push = true
    return def
  },

  /**
   * Multi-row table keyed by `id`. `own` restricts a row to the member who wrote it — anyone
   * may add rows, but only the author changes or deletes theirs. `push` makes a write to it push
   * a notification to the other members' devices; what it says is the app's push worklet's.
   *
   * @param {Record<string, Prim>} fields
   * @param {{ indexes?: Record<string, string[]>, own?: boolean, push?: boolean }} [opts]
   * @returns {TypeDef}
   */
  collection(fields, opts) {
    const def = { kind: COLLECTION, fields }
    if (opts?.indexes) def.indexes = opts.indexes
    if (opts?.own) def.own = true
    if (opts?.push) def.push = true
    return def
  },

  /**
   * RPC-style mutation that doesn't persist a row.
   *
   * @param {Record<string, Prim>} fields
   * @param {{ push?: boolean }} [opts]  `push`: a call pushes a notification, see collection.
   * @returns {TypeDef}
   */
  action(fields, opts) {
    const def = { kind: ACTION, fields }
    if (opts?.push) def.push = true
    return def
  },

  /**
   * Add fields to a builtin type (members, devices, …). Merged into the
   * builtin's base fields at build time; redeclaring a base field throws.
   *
   * @param {Record<string, Prim>} fields
   * @returns {{ kind: 'extend', fields: Record<string, Prim> }}
   */
  extend(fields) {
    return { kind: 'extend', fields }
  }
}

/**
 * Wrap a definitions object so the builder can recognise it as a schema.
 *
 * @param {SchemaDefs} defs
 * @returns {Schema}
 */
export function schema(defs) {
  if (!defs || typeof defs !== 'object') throw CeroError.INVALID('schema(defs) must be an object')
  return { defs }
}
