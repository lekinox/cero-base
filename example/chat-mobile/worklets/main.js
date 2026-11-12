/* global BareKit, Bare */
import fs from 'fs'
import { isInitialized } from 'chat-backend'
import { serve } from 'chat-backend/server'

const storage = Bare.argv[0]
const ipc = BareKit.IPC
const errLog = storage + '/error.log'

function logError(label, err) {
  const msg = `[${label}] ${err.stack || err.message || err}\n`
  console.error(msg)
  try {
    fs.appendFileSync(errLog, new Date().toISOString() + ' ' + msg)
  } catch {}
}

Bare.on('unhandledRejection', (err) => {
  logError('unhandledRejection', err)
})

Bare.on('uncaughtException', (err) => {
  logError('uncaughtException', err)
})

// the app cannot read the store itself: its first message asks what the store holds, before the RPC takes the stream
await new Promise((resolve) => ipc.once('data', resolve))
ipc.pause()
ipc.write(Buffer.from(JSON.stringify(await isInitialized(storage))))

await serve(ipc, { storage })
