/* global BareKit, Bare */
import fs from 'fs'
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

await serve(ipc, { storage })
