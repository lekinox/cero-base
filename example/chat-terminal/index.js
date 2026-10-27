#!/usr/bin/env node

import os from 'os'
import readline from 'readline'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { cero } from '@cero-base/cero'
import { spec, isInitialized } from 'chat-backend'

const HELP = `chat-terminal — a tiny p2p chat over cero

Usage:
  chat-terminal [--storage <dir>] [--name <name>]                   create a room (host)
  chat-terminal --join <invite> [--storage <dir>] [--name <name>]   join a room
  chat-terminal --phrase "<words>" --storage <dir>                    recover your identity on this machine
  chat-terminal --link <invite> --storage <dir>                       link this machine as a device of yours
  chat-terminal --help

Options:
  --join <invite>     join an existing room (default: create a new one)
  --phrase <words>    the phrase printed on your first run; makes this machine your device too
  --link <invite>     a device invite from /link on a machine of yours; same, with no phrase here
  --name <name>       display name (default: hostname)
  --storage <dir>     storage directory (default: a tmp dir)
  --bootstrap <h:p>   DHT bootstrap node, for a local testnet (or CERO_BOOTSTRAP)
  --help              show this help
`

main().catch((err) => {
  console.error(err?.stack || err?.message || err)
  process.exit(1)
})

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    return
  }

  const name = opts.name || os.hostname()
  const storage = opts.storage || mkdtempSync(join(os.tmpdir(), 'chat-terminal-'))
  const bootstrap = parseBootstrap(opts.bootstrap || process.env.CERO_BOOTSTRAP)

  const fresh = !opts.phrase && !opts.link && !(await isInitialized(storage))
  const me = await cero(storage, spec, {
    name,
    bootstrap,
    phrase: opts.phrase,
    invite: opts.link,
    onrequest: (id) => console.log(`# device request ${id}: /approve it on your other machine`)
  })
  // a recovered or linked identity keeps its name unless one is given
  if (fresh || opts.name) await cero.set(me.profile, { name })

  const room = opts.join ? await cero.open(me.room, { invite: opts.join }) : await ownRoom(me, name)

  console.log(`# chat-terminal`)
  console.log(`# you: ${name} (${me.id.slice(0, 8)})`)
  console.log(`# room: ${room.id.slice(0, 8)}`)
  if (fresh) {
    console.log(`# phrase (keep it, it recovers you on another machine): ${await cero.phrase(me)}`)
  }
  if (!opts.join) {
    const inv = await cero.invite(room)
    console.log(`# invite (share to add peers):`)
    console.log(inv)
  }
  console.log(
    `# type a message and hit enter; /invite for another invite; /link to add a device of yours; /quit to exit`
  )

  // a device of yours asking in: approve it once the id matches the one it shows
  const requestStream = cero.watch(me.requests, { admitted: false })
  const announced = new Set()
  requestStream.on('data', (event) => {
    for (const r of event.data) {
      if (announced.has(r.id)) continue
      announced.add(r.id)
      console.log(`# device request ${r.id}: /approve ${r.id} or /deny ${r.id}`)
    }
  })

  const names = new Map()
  const learn = (rows) => {
    for (const m of rows || []) if (m.name) names.set(m.id, m.name)
  }
  learn((await cero.get(room.members)).data)
  const memberStream = cero.watch(room.members)
  memberStream.on('data', (event) => learn(event.data))

  const stream = cero.watch(room.messages)
  const seen = new Set()
  stream.on('data', (event) => {
    for (const m of event.data) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      const who =
        names.get(m.memberId) || (m.memberId === me.id ? name : m.memberId?.slice(0, 8)) || 'peer'
      console.log(`<${who}> ${m.text}`)
    }
  })

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  })
  rl.on('line', async (line) => {
    const text = line.trim()
    if (!text) return
    if (text === '/quit') return shutdown()
    if (text === '/invite') {
      console.log(await cero.invite(room))
      return
    }
    if (text === '/link') {
      console.log(`# device invite (use it with --link on your other machine):`)
      console.log(await cero.invite(me))
      return
    }
    const [command, id] = text.split(/\s+/)
    if (command === '/approve' || command === '/deny') {
      const { data } = await cero.get(me.requests, { admitted: false })
      const request = data.find((r) => r.id === id)
      if (!request) return console.error(`! no pending device request ${id}`)
      if (command === '/approve') await cero.accept(me, request)
      else await cero.deny(me, request, 'denied')
      console.log(`# device request ${id} ${command === '/approve' ? 'approved' : 'denied'}`)
      return
    }
    try {
      await cero.put(room.messages, { text })
    } catch (err) {
      console.error(`! ${err?.code || err?.message || err}`)
    }
  })
  rl.on('close', shutdown)
  process.on('SIGINT', shutdown)

  let closing = false
  async function shutdown() {
    if (closing) return
    closing = true
    memberStream.destroy()
    requestStream.destroy()
    stream.destroy()
    try {
      await cero.close(me)
    } catch {}
    process.exit(0)
  }
}

// a recovered identity already has rooms: reopen the first, otherwise create one
async function ownRoom(me, name) {
  const { data: rooms } = await cero.get(me.room)
  if (rooms.length) return cero.open(me.room, { id: rooms[0].id })
  return cero.open(me.room, { name: `${name}'s room` })
}

function parseBootstrap(raw) {
  if (!raw) return null
  return raw.split(',').map((pair) => {
    const [host, port] = pair.split(':')
    return { host, port: Number(port) }
  })
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--create') out.create = true
    else if (a === '--join') out.join = argv[++i]
    else if (a === '--phrase') out.phrase = argv[++i]
    else if (a === '--link') out.link = argv[++i]
    else if (a === '--name') out.name = argv[++i]
    else if (a === '--storage') out.storage = argv[++i]
    else if (a === '--bootstrap') out.bootstrap = argv[++i]
    else {
      out.help = true
      out._unknown = a
    }
  }
  return out
}
