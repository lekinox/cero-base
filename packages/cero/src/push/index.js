import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import b4a from 'b4a'
import safetyCatch from 'safety-catch'

import c from 'compact-encoding'
import { verify, decrypt } from '@cero-base/core/push'
import { CeroError } from '@cero-base/core/errors'
import { epochEntries } from '@cero-base/core/database/encryption'

import { Local } from '../local/index.js'

/**
 * A push verified against the handles the topics rows name, with the row it wrote when the block
 * rode along and this device holds the handle's keys.
 *
 * @param {import('hypercore-storage')} storage
 * @param {import('../lib/spec.js').Spec} spec
 * @param {Uint8Array} payload
 * @param {Array<{ id: string, handle: string, type: string, key: Uint8Array, name: string | null, encryptionKey?: Uint8Array | null, epochs?: Uint8Array | null }>} rows  The root's `topics` rows.
 * @returns {Promise<{ id: string, type: string, name: string | null, newer: boolean, ref: string | null, row: object | null } | null>}
 */
export async function read(storage, spec, payload, rows) {
  const handles = rows.map(({ handle, key, type, name }) => ({ id: handle, key, type, name }))
  const hit = await verify(storage, payload, handles)
  if (!hit) return null
  const keys = rows.find((r) => r.handle === hit.id)
  const row = await rowOf(storage, spec, hit, keys)
  return { id: hit.id, type: hit.type, name: hit.name, newer: hit.newer, ref: hit.ref, row }
}

// the row a push's block holds: null when none rode along, or it does not decode with what we hold
async function rowOf(storage, spec, hit, { encryptionKey, epochs }) {
  if (!hit.block || !encryptionKey) return null
  try {
    const body = await decrypt(storage, hit, {
      encryptionKey,
      epochs: epochs ? c.decode(epochEntries, epochs) : []
    })
    return body ? (spec.handles[hit.type].dispatch.decode(body).value ?? null) : null
  } catch (err) {
    safetyCatch(err)
    return null
  }
}

/**
 * A push the platform delivered while the app is dead, verified from its storage opened
 * read-only. `null` while the live app holds the storage, which shows the activity itself, and
 * for a push that is forged or about no handle here.
 *
 * @param {string} dir  The directory `cero()` opened.
 * @param {import('../lib/spec.js').Spec} spec
 * @param {Uint8Array} payload
 * @param {{ storageKey?: Uint8Array }} [opts]  The key `cero()` encrypts the local store with, if any.
 * @returns {Promise<{ id: string, type: string, name: string | null, newer: boolean, ref: string | null, row: object | null } | null>}
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
    return await read(storage, spec, payload, rows)
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
 * The bare-kit push entry: on each push the OS hands this worklet, verify it and, for one about
 * new data on a handle this device holds, answer with what the show handler returns: the
 * notification, `{ title, body }`, or nothing. The request carries `storage`, `payload` (base64) and, when the
 * app encrypts its local store, `storageKey` (base64).
 *
 * @param {import('../lib/spec.js').Spec} spec
 * @param {(push: { id: string, type: string, name: string | null, newer: boolean, ref: string | null, row: object | null }) => { title: string, body: string } | null | undefined | Promise<{ title: string, body: string } | null | undefined>} show  The show handler: what to show for a verified push, as `cero.receive` would give it to the app.
 * @returns {void}
 */
export function push(spec, show) {
  if (typeof show !== 'function') throw CeroError.INVALID('push: a show handler says what to show')
  globalThis.BareKit.on('push', async (json, reply) => {
    let shown = null
    try {
      const { storage, storageKey, payload } = JSON.parse(json)
      const hit = await receive(storage, spec, b4a.from(payload, 'base64'), {
        storageKey: storageKey ? b4a.from(storageKey, 'base64') : undefined
      })
      if (hit?.newer) shown = await show(hit)
    } catch {
      // the OS waits for an answer: whatever went wrong, no notification
      shown = null
    }
    reply(null, shown ? JSON.stringify(shown) : null)
  })
}
