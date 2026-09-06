/* global Bare */
import goodbye from 'graceful-goodbye'
import { serve } from 'chat-backend/server'

const storage = Bare.argv[2]
const ipc = Bare.IPC

Bare.on('uncaughtException', (err) => {
  console.error('[worker:uncaughtException]', err?.code, err?.message)
  console.error(err?.stack)
})

Bare.on('unhandledRejection', (reason) => {
  console.error('[worker:unhandledRejection]', reason)
})

let server
try {
  server = await serve(ipc, { storage })
} catch (err) {
  console.error(`__BOOT_ERROR__${err.message}`)
  Bare.exit(1)
}

goodbye(() => server.close())
