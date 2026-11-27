import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

export { spec, meta } from './spec/index.js'
export { schema } from './schema.js'

/**
 * What `storage` holds: `null` when it is new, `'recovering'` or `'linking'` while it waits for another device of
 * the profile, `'ready'` once it has one. Rejects when the store is locked by another process: that store is in
 * use, not new.
 *
 * @param {string} storage
 * @returns {Promise<'ready' | 'recovering' | 'linking' | null>}
 */
export function isInitialized(storage) {
  return cero.peek(storage, spec)
}
