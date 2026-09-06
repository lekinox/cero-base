import * as cero from '@cero-base/cero/client'
import { spec } from './spec/index.js'

export const restore = cero.restore

export async function connect(ipc, { name, phrase } = {}) {
  const me = await cero.connect(ipc, spec)
  if (phrase) await cero.restore(me, phrase)
  if (name) await cero.set(me.profile, { name })
  return me
}
