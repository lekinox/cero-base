/* global Bare */
import goodbye from 'graceful-goodbye'
import { serve } from 'chat-backend/server'

const storage = Bare.argv[2]
// host:port,host:port: a local test network instead of the public one
const bootstrap = Bare.argv[3]?.split(',').map((node) => {
  const [host, port] = node.split(':')
  return { host, port: Number(port) }
})
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
  server = await serve(ipc, { storage, ...(bootstrap && { bootstrap }) })
} catch (err) {
  console.error(`__BOOT_ERROR__${err.message}`)
  Bare.exit(1)
}

goodbye(() => server.close())
