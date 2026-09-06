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
