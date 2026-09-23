import ReadyResource from 'ready-resource'
import b4a from 'b4a'

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

/**
 * One of the mailbox's boxes, kept in the local store so mail survives a restart.
 *
 * @param {import('@cero-base/core/storage').Storage} store
 * @param {'inbox' | 'outbox'} name
 * @returns {import('@cero-base/core/mailbox').Box}
 */
export function box(store, name) {
  return {
    list: async () => (await store.get(name)).data.map(unpack),
    put: (mail) => store.put(name, { ...mail, mirrors: b4a.concat(mail.mirrors || []) }),
    del: (id) => store.del(name, id)
  }
}

function unpack({ id, address, message, mirrors }) {
  const keys = []
  for (let i = 0; i < (mirrors?.byteLength || 0); i += 32) keys.push(mirrors.subarray(i, i + 32))
  return { id, address, message, mirrors: keys }
}
