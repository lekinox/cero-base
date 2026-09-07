import { profileSync } from './profile-sync.js'
import { handleSync } from './handle-sync.js'
import { t, schema } from '../lib/spec.js'
import * as operators from '../lib/operators.js'

export * from './profile-sync.js'
export * from './handle-sync.js'

// everything an extension module needs, light enough for the UI bundle the spec pulls it into
export { t, schema }
export const { put, set, get, del, watch, changes, call, open, rotate, before, after } = operators
export const cero = {
  t,
  schema,
  put,
  set,
  get,
  del,
  watch,
  changes,
  call,
  open,
  rotate,
  before,
  after
}

/**
 * @typedef {object} Extension
 * @property {Record<string, any>} [schema]  Refs to add, or `t.extend` on a builtin, nested by handle type like the app schema.
 * @property {(me: any) => any} [setup]      Runs once the root is ready; a returned function runs on close.
 */

/** The two every app gets unless its build names a list. */
export const bundled = [profileSync(), handleSync()]

/**
 * The extensions a spec carries, else the bundled two. A bare function is `{ setup }`.
 *
 * @param {any} spec
 * @param {Array<any>} [override]
 * @returns {Extension[]}
 */
export function extensionsOf(spec, override) {
  const list = override || spec?.extensions || bundled
  return list.map((e) => (typeof e === 'function' ? { setup: e } : e))
}

/**
 * The operators a spec carries: functions taking the handle first, keyed by namespace, a
 * key naming a handle type holding that type's namespaces.
 *
 * @param {any} spec
 * @param {Record<string, any>} [override]
 * @returns {Record<string, any>}
 */
export function operatorsOf(spec, override) {
  return override || spec?.operators || {}
}

// handle.ns.fn(args) calls fn(handle, args)
function attach(handle, ns, fns) {
  const bound = {}
  for (const key of Object.keys(fns)) {
    if (typeof fns[key] === 'function') bound[key] = (...args) => fns[key](handle, ...args)
  }
  handle[ns] = bound
}

/**
 * Put the operators for `handle` on it: the root when `type` is null, else a child of `type`.
 *
 * @param {any} handle
 * @param {string | null} type
 * @param {Record<string, any>} operators
 * @returns {any} handle
 */
export function bind(handle, type, operators) {
  const handles = handle.spec?.meta?.handles || {}
  for (const [ns, fns] of Object.entries(operators)) {
    if (type === null) {
      if (!(ns in handles)) attach(handle, ns, fns)
    } else if (ns === type) {
      for (const [k, group] of Object.entries(fns)) attach(handle, k, group)
    }
  }
  return handle
}
