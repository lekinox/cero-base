import { Worklet } from 'react-native-bare-kit'
import { Paths } from 'expo-file-system'

import bundle from '../../worklets/app.bundle.mjs'

export function getIPC() {
  const documentDir = Paths.document.uri.substring('file://'.length)
  const storage = Paths.join(documentDir, 'chat-mobile')

  const worklet = new Worklet()
  worklet.on('error', (err) => console.error('[worklet]', err))
  worklet.start('/app.bundle', bundle, [storage])

  return worklet.IPC
}

// what the worklet's store holds, asked before connecting: null, 'ready', 'recovering' or 'linking'
export function peek(ipc) {
  return new Promise((resolve, reject) => {
    ipc.once('error', reject)
    ipc.once('data', (data) => {
      ipc.pause()
      ipc.off('error', reject)
      resolve(JSON.parse(String.fromCharCode(...data)))
    })
    ipc.write(new Uint8Array(1))
  })
}
