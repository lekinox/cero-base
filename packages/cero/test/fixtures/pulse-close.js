import process from 'process'
import Client from 'hypertracker/client'
import HyperDHT from 'hyperdht'
import crypto from 'hypercore-crypto'
import hid from 'hypercore-id-encoding'

import { cero, put } from '../../src/index.js'
import { bundled, pulse } from '../../src/extensions/index.js'
import { spec } from './spec/pulse/index.js'

// a device that writes and closes, fails to open, closes as it waits for a write it heard of, or
// writes with no service and waits to be killed, in its own process
const [dir, bootstrap, key, mode, id] = process.argv.slice(-5)
const extensions = [...bundled, pulse(key)]
const opts = { bootstrap: JSON.parse(bootstrap), extensions, keepOpen: 0 }

if (mode === 'throw') {
  extensions.push(() => {
    throw new Error('a setup that fails')
  })
  await cero(dir, spec, opts).catch(() => {})
} else if (mode === 'wake') {
  const a = await cero(`${dir}/a`, spec, opts)
  const b = await cero(`${dir}/b`, spec, opts)
  const room = await cero.open(a.team, { name: 'clinic' })
  const joined = await cero.open(b.team, await cero.invite(room))
  for await (const { data } of cero.watch(joined.status)) if (data.writable) break
  // b holds all a wrote before it closes the room
  await put(room.messages, { text: 'hello' })
  for await (const { data } of cero.watch(joined.messages)) if (data.length) break
  await cero.close(joined)
  const { encryptionKey } = room.store
  await a.close()
  // a member's bump, and no device to catch up with: b waits as it closes
  const opened = new Promise((resolve) => b.once('handle', resolve))
  const dht = new HyperDHT({ bootstrap: JSON.parse(bootstrap) })
  const member = new Client(hid.decode(key), { dht })
  const [ns] = crypto.namespace('cero/bump', 1)
  member.announce(crypto.keyPair(crypto.hash([ns, encryptionKey])), { bump: Date.now() + 1000 })
  await opened
  await member.close()
  await dht.destroy()
  await b.close()
} else if (mode === 'owe') {
  const me = await cero(dir, spec, { ...opts, extensions: [pulse(key)] })
  const room = await cero.open(me.team, { id })
  await put(room.messages, { text: 'offline' })
  for await (const { data } of cero.watch(me.local.pulses)) {
    if (data.find((row) => row.id === id)?.owed) break
  }
  console.log('owed')
} else {
  const me = await cero(dir, spec, opts)
  const room = await cero.open(me.team, { name: 'clinic' })
  await put(room.messages, { text: 'hi' })
  await put(room.messages, { text: 'again' })
  await me.close()
}
if (mode !== 'owe') console.log('closed')
