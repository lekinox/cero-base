// Verify the pulse service: it prints its key, passes a time on to the devices that follow its
// key, keeps it for those that follow later, refuses one not signed by that key, stops cleanly
// on SIGTERM and comes back with the same key and times. Runs on a local testnet, no network needed.
//
//   node services/pulse/test.mjs
//
// Exits 0 and prints ✅ if every check passes; non-zero otherwise.
import { spawn } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import DHT from 'hyperdht'
import createTestnet from '@hyperswarm/testnet'
import Client from 'hypertracker/client'
import crypto from 'hypercore-crypto'
import z32 from 'z32'

const script = fileURLToPath(new URL('./pulse.js', import.meta.url))

let failed = 0
const check = (name, ok) => {
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}

async function until(fn, ms = 20000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

// the script as a container runs it, resolving once it prints its key
function run(storage, testnet) {
  const bootstrap = testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, STORAGE: storage, PORT: '0', BOOTSTRAP: bootstrap },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  const key = new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => {
      const [, key] = data.toString().match(/Listening at (\w+)/) || []
      if (key) resolve(z32.decode(key))
    })
    exited.then(() => reject(new Error('exited before it listened')))
  })
  return { child, key, exited }
}

function client(testnet, key) {
  const c = new Client(key, { dht: new DHT({ bootstrap: testnet.bootstrap }) })
  c.heard = []
  c.on('announce', ({ publicKey, bumped }) => c.heard.push({ publicKey, bumped }))
  c.end = async () => {
    await c.close()
    await c.dht.destroy()
  }
  return c
}

async function main() {
  const testnet = await createTestnet(3)
  const storage = mkdtempSync(join(tmpdir(), 'pulse-test-'))
  const room = crypto.keyPair()
  const at = Date.now()

  const first = run(storage, testnet)
  const key = await first.key
  check('prints its public key', key.byteLength === 32)

  const writer = client(testnet, key)
  const reader = client(testnet, key)
  reader.subscribe(room.publicKey, { since: 0 })
  await until(() => reader.channel?.opened)
  writer.announce(room, { bump: at })
  check(
    'a time told reaches a device that follows the key',
    await until(() => reader.heard.some((h) => h.bumped === at))
  )

  const late = client(testnet, key)
  late.subscribe(room.publicKey, { since: at })
  check(
    'a device that follows later gets the time kept',
    await until(() => late.heard.some((h) => h.bumped === at))
  )

  const forged = { publicKey: room.publicKey, secretKey: crypto.keyPair().secretKey }
  writer.announce(forged, { bump: at + 1 })
  writer.announce(room, { bump: at + 2 })
  await until(() => reader.heard.some((h) => h.bumped === at + 2))
  check('a time signed by another key is refused', !reader.heard.some((h) => h.bumped === at + 1))

  const stopped = Date.now()
  first.child.kill('SIGTERM')
  const code = await first.exited
  check(`SIGTERM stops it cleanly (exit ${code} in ${Date.now() - stopped} ms)`, code === 0)

  const second = run(storage, testnet)
  check('a restart on the same storage keeps its key', (await second.key).equals(key))
  const again = client(testnet, key)
  again.subscribe(room.publicKey, { since: at + 2 })
  check('and the times it kept', await until(() => again.heard.some((h) => h.bumped === at + 2)))

  for (const c of [writer, reader, late, again]) await c.end()
  second.child.kill('SIGTERM')
  await second.exited
  await testnet.destroy()
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ pulse ok')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('error:', e.message)
  process.exit(2)
})
