import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import safetyCatch from 'safety-catch'

import { CeroError } from '@cero-base/core/errors'

import { Local } from '../local/index.js'

// outside operators.js so storage deps stay off the client's module graph

/**
 * Quickly check whether the on-disk directory at `dir` already holds an initialised cero
 * identity (i.e. a stored device key with its proof).
 *
 * @param {string} dir   Cero data directory.
 * @param {import('./spec.js').Spec} spec  Built spec, the value passed to `cero(dir, spec)`.
 * @returns {Promise<boolean>}  `true` if a device of an identity exists on disk.
 */
export async function peek(dir, spec) {
  if (typeof dir !== 'string' || !dir) throw CeroError.INVALID('dir must be a non-empty string')
  if (!spec) throw CeroError.REQUIRED('spec')

  // construct first, ready inside the try: a corrupt dir must still close everything
  const root = new HypercoreStorage(`${dir}/main`)
  const store = new Corestore(root, { manifestVersion: 2 })
  const local = new Local(null, spec, { store })
  try {
    await root.ready()
    await store.ready()
    await local.ready()
    const { data } = await local.store.get('device')
    return !!data
  } finally {
    await local.close().catch(safetyCatch)
    await store.close().catch(safetyCatch)
    await root.close().catch(safetyCatch)
  }
}
