import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import safetyCatch from 'safety-catch'

import { CeroError } from '@cero-base/core/errors'

import { Local } from '../local/index.js'
import { current, lock } from './swap.js'

// outside operators.js so storage deps stay off the client's module graph

const WAITING = { recover: 'recovering', link: 'linking' }

/**
 * What the directory at `dir` holds, read without opening it: nothing yet, an identity, or a recovery or a link
 * still waiting for a device of its identity, which the next `cero(dir, spec)` goes on with.
 *
 * @param {string} dir   Cero data directory.
 * @param {import('./spec.js').Spec} spec  Built spec, the value passed to `cero(dir, spec)`.
 * @param {{ storageKey?: Uint8Array }} [opts]  The key `cero()` encrypts the local store with, if any.
 * @returns {Promise<'ready' | 'recovering' | 'linking' | null>}  `null` when it holds nothing.
 */
export async function peek(dir, spec, { storageKey } = {}) {
  if (typeof dir !== 'string' || !dir) throw CeroError.INVALID('dir must be a non-empty string')
  if (!spec) throw CeroError.REQUIRED('spec')

  const held = await lock(dir)
  // construct first, ready inside the try: a corrupt dir must still close everything
  // a swap killed between its renames: the store a launch will open, never a new empty one
  const root = new HypercoreStorage(await current(dir))
  const store = new Corestore(root, { manifestVersion: 2 })
  const local = new Local(null, spec, { store, storageKey })
  try {
    await root.ready()
    await store.ready()
    await local.ready()
    const setup = (await local.store.get('keypair')).data?.setup
    if (WAITING[setup]) return WAITING[setup]
    return (await local.store.get('device')).data ? 'ready' : null
  } finally {
    await local.close().catch(safetyCatch)
    await store.close().catch(safetyCatch)
    await root.close().catch(safetyCatch)
    await held.close()
  }
}
