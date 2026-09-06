#!/usr/bin/env node
import { dial } from '../src/transport.js'
import { connect } from '../src/connect.js'
import { formatHandles, formatState, formatError, formatEvent, formatStats } from '../src/format.js'

const argv = process.argv.slice(2)
const ti = argv.indexOf('--token')
const token = ti >= 0 ? argv.splice(ti, 2)[1] : undefined
const [arg, ...refs] = argv
if (!arg) {
  console.log('usage: cero-tools [host:]<port> [--token <token>] [refs...]')
  process.exit(1)
}

const [hostPart, portPart] = arg.includes(':') ? arg.split(':') : [undefined, arg]
const host = hostPart
const port = Number(portPart)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid port '${portPart}' — expected an integer 1–65535`)
  process.exit(1)
}

const socket = dial({ host, port })
socket.on('error', (err) => {
  console.error(
    err.code === 'ECONNREFUSED'
      ? `no tap on ${host ?? '127.0.0.1'}:${port} — is the app running with devtools()?`
      : `connection error: ${err.message}`
  )
  process.exit(1)
})

const session = await connect(socket, { token })

console.log(formatHandles(await session.handles()))

for (const ref of refs) {
  try {
    console.log(formatState(ref, await session.get(ref)))
  } catch (err) {
    console.log(formatError(ref, err)) // a bad ref shouldn't kill the session
  }
}

const events = session.events()
const live = session.stats()
events.on('data', (e) => console.log(formatEvent(e)))
live.on('data', (s) => console.log(formatStats(s)))

process.on('SIGINT', () => {
  session.close()
  process.exit(0)
})
