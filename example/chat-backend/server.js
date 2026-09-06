import os from 'os'
import { serve as rpcServe } from '@cero-base/cero/server'

import { spec } from './spec/index.js'

export async function serve(ipc, { storage, name = os.hostname(), ...opts } = {}) {
  if (!ipc) throw new Error('ipc is required')
  return rpcServe(ipc, spec, { storage, name, ...opts })
}
