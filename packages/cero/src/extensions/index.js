import { profileSync } from './profile-sync.js'
import { handleSync } from './handle-sync.js'
import { t, schema } from '../lib/spec.js'
import * as operators from '../lib/operators.js'

export * from './profile-sync.js'
export * from './handle-sync.js'

// everything an extension module needs, light enough for the UI bundle the spec pulls it into
export { t, schema }
export * from '../lib/operators.js'
export const cero = { t, schema, ...operators }

/**
 * @typedef {object} Extension
 * @property {string} [name]
 * @property {Record<string, object>} [schema]  Refs to add, or `t.extend` on a builtin, nested by handle type like the app schema.
 * @property {(me: import('../handle/index.js').Context) => void | (() => void) | Promise<void | (() => void)>} [setup]  Runs before the root opens; a returned function runs on close.
 */

/** The two every app gets unless its build names a list. */
export const bundled = [profileSync(), handleSync()]

/**
 * The extensions a spec carries, else the bundled two. A bare function is `{ setup }`.
 *
 * @param {import('../lib/spec.js').Spec | null} spec
 * @param {Array<Extension | Extension['setup']>} [override]
 * @returns {Extension[]}
 */
export function extensionsOf(spec, override) {
  const list = override || spec?.extensions || bundled
  return list.map((e) => (typeof e === 'function' ? { setup: e } : e))
}
