import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import b4a from 'b4a'
import safetyCatch from 'safety-catch'

import { receive as verify } from '@cero-base/core/push'

import { Local } from '../local/index.js'

/**
 * A push the platform delivered while the app is dead, verified from its storage opened
 * read-only. `null` while the live app holds the storage, which shows the activity itself, and
 * for a push that is forged or about no handle here.
 *
 * @param {string} dir  The directory `cero()` opened.
 * @param {import('../lib/spec.js').Spec} spec
 * @param {Uint8Array} payload
 * @param {{ storageKey?: Uint8Array }} [opts]  The key `cero()` encrypts the local store with, if any.
 * @returns {Promise<{ id: string, type: string, name: string | null, newer: boolean } | null>}
 */
export async function receive(dir, spec, payload, { storageKey } = {}) {
  const storage = new HypercoreStorage(`${dir}/main`, { readOnly: true })
  let store = null
  let local = null
  try {
    await storage.ready()
    store = new Corestore(storage, { manifestVersion: 2 })
    local = new Local(null, spec, { store, storageKey })
    await local.ready()
    const { data: rows } = await local.store.get('topics')
    const handles = rows.map(({ handle, key, type, name }) => ({ id: handle, key, type, name }))
    const hit = await verify(storage, payload, handles)
    return hit && { id: hit.id, type: hit.type, name: hit.name, newer: hit.newer }
  } catch (err) {
    safetyCatch(err)
    return null
  } finally {
    await local?.close().catch(safetyCatch)
    await store?.close().catch(safetyCatch)
    await storage.close().catch(safetyCatch)
  }
}

/**
 * The bare-kit push entry: on each push the OS hands this worklet, verify it and answer with the
 * notification to show, or nothing. The request carries `storage`, `payload` (base64) and, when
 * the app encrypts its local store, `storageKey` (base64).
 *
 * @param {import('../lib/spec.js').Spec} spec
 * @returns {void}
 */
export function push(spec) {
  globalThis.BareKit.on('push', async (json, reply) => {
    let hit = null
    try {
      const { storage, storageKey, payload } = JSON.parse(json)
      hit = await receive(storage, spec, b4a.from(payload, 'base64'), {
        storageKey: storageKey ? b4a.from(storageKey, 'base64') : undefined
      })
    } catch {
      // the OS waits for an answer: whatever went wrong, no notification
      hit = null
    }
    const shown = hit?.newer ? { title: hit.name || hit.type, body: 'New activity' } : null
    reply(null, shown && JSON.stringify(shown))
  })
}
