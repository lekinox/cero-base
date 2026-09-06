import { peek } from '@cero-base/cero'
import { spec } from './spec/index.js'

export { spec, meta } from './spec/index.js'
export { schema } from './schema.js'

/**
 * Whether `storage` already holds an identity. Rejects when the store is locked
 * by another process: that store is initialized and busy, not new.
 *
 * @param {string} storage
 * @returns {Promise<boolean>}
 */
export function isInitialized(storage) {
  return peek(storage, spec)
}
