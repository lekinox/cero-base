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
  chat-terminal --help

Options:
  --join <invite>     join an existing room (default: create a new one)
  --phrase <words>    the phrase printed on your first run; makes this machine your device too
  --name <name>       display name (default: hostname)
  --storage <dir>     storage directory (default: a tmp dir)
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

  const fresh = !opts.phrase && !(await isInitialized(storage))
  const me = await cero(storage, spec, { name, bootstrap, phrase: opts.phrase })
  await cero.set(me.profile, { name })

  const room = opts.join ? await cero.open(me.room, { invite: opts.join }) : await ownRoom(me, name)

  console.log(`# chat-terminal`)
  console.log(`# you: ${name} (${me.id.slice(0, 8)})`)
  console.log(`# room: ${room.id.slice(0, 8)}`)
  if (fresh) {
    console.log(`# phrase (keep it, it recovers you on another machine): ${me.identity.toPhrase()}`)
  }
  if (!opts.join) {
    const inv = await room.invite()
    console.log(`# invite (share to add peers):`)
    console.log(inv)
  }
  console.log(`# type a message and hit enter; /invite for another invite; /quit to exit`)

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
      console.log(await room.invite())
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
    stream.destroy()
    try {
      await me.close()
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
