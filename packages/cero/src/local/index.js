import ReadyResource from 'ready-resource'

import { Storage } from '@cero-base/core/storage'
import { CeroError } from '@cero-base/core/errors'

import { Ref } from '../lib/refs.js'

/**
 * @typedef {object} LocalOpts
 * @property {any} [root]   Pre-existing HypercoreStorage to reuse.
 * @property {any} [store]  Pre-existing Corestore to reuse.
 * @property {Uint8Array} [storageKey]  32-byte key encrypting the local store at rest.
 */

/**
 * Per-device, single-writer storage for cero — holds the master seed, device keypair and
 * any per-handle keypairs.
 */
export class Local extends ReadyResource {
  /**
   * @param {string | null} dir   Directory for the local store, or `null` when reusing an external `store`.
   * @param {any} spec            Built cero spec — must include `spec.local.database` and `spec.meta.local`.
   * @param {LocalOpts} [opts]
   */
  constructor(dir, spec, { root, store, storageKey } = {}) {
    super()
    if (!root && !store && (typeof dir !== 'string' || !dir)) {
      throw CeroError.REQUIRED('dir, root, or store')
    }
    if (!spec?.local?.database) throw CeroError.REQUIRED('spec.local.database')
    if (!spec?.meta?.local) throw CeroError.REQUIRED('spec.meta.local')

    this.dir = dir
    this.spec = spec
    this.store = Storage.bee(dir, {
      spec: { database: spec.local.database, meta: spec.meta.local },
      root,
      store,
      storageKey
    })
  }

  async _open() {
    await this.store.ready()
    Ref.attach(this, this.store.refs)
  }

  async _close() {
    await this.store.close()
  }
}
