import { decodeId } from '@cero-base/core/blobs/codec'

import { put, get, set } from '../lib/operators.js'

/**
 * Write `row`'s name and `fields`, read from `from`, onto row `id` of `to`. A file is copied
 * into `to`'s handle, so it resolves there for everyone in it. Nothing is written when there is
 * no row or it already matches: an unconditional set on every open is an op in the log forever.
 *
 * @param {import('../lib/refs.js').Ref} from
 * @param {Record<string, unknown>} row
 * @param {Record<string, object>} fields
 * @param {import('../lib/refs.js').Ref} to
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function mirror(from, row, fields, to, id) {
  const { data: was } = await get(to, id)
  if (!was) return
  const files = from.handle.store.refs[from.name]?.files || []
  const out = {}
  let changed = false
  for (const k of ['name', ...Object.keys(fields)]) {
    const file = files.includes(k) && idOf(row[k])
    const prev = idOf(was[k])
    if (!file) {
      out[k] = row[k]
      changed ||= was[k] !== row[k]
    } else if (prev && (await get(to.handle.files, prev)).data?.from === file) {
      out[k] = prev
    } else {
      const data = await from.handle._bytes(file)
      const { type } = decodeId(file)
      const copy = { data, type, name: row[k]?.name ?? null, from: file }
      out[k] = (await put(to.handle.files, copy)).data.id
      changed = true
    }
  }
  if (changed) await set(to, { id, ...out }, { upsert: false })
}

function idOf(value) {
  return typeof value === 'string' ? value : value?.id || null
}
