import { cero } from '@cero-base/cero/client'
import { spec } from './spec/index.js'

export const restore = cero.restore
export const link = cero.link

export async function connect(ipc, { name, phrase, invite, onrequest } = {}) {
  const me = await cero(ipc, spec)
  if (phrase) await cero.restore(me, phrase)
  if (invite) await cero.link(me, invite, { onrequest })
  if (name) await cero.set(me.profile, { name })
  return me
}
