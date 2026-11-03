// Verify the blind relay: peers forced through it connect, and abuse is bounded
// (per-key, per-IP and unpaired-session limits; bad config refuses to start).
// Runs on a local testnet, no network needed.
//
//   node services/relay/test.mjs
//
// Exits 0 and prints ✅ if every check passes; non-zero otherwise.
import { spawnSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import DHT from 'hyperdht'
import createTestnet from '@hyperswarm/testnet'
import { start } from './relay.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const keyFile = () => join(mkdtempSync(join(tmpdir(), 'relay-test-')), 'key')

let failed = 0
const check = (name, ok) => {
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}

// a session counts as served if it opens and the relay keeps it
async function served(node, relay, keyPair = DHT.keyPair()) {
  const s = node.connect(relay.server.publicKey, { keyPair })
  s.on('error', () => {})
  const opened = await new Promise((r) => {
    s.on('open', () => r(true))
    s.on('close', () => r(false))
  })
  await sleep(700)
  return opened && !s.destroyed ? s : null
}

async function relayed(testnet) {
  const relay = await start({ keyFile: keyFile(), bootstrap: testnet.bootstrap })
  const a = testnet.createNode()
  const b = testnet.createNode()
  const server = b.createServer()
  const got = new Promise((resolve) =>
    server.on('connection', (s) => {
      s.on('error', () => {})
      s.once('data', resolve)
    })
  )
  await server.listen()

  const socket = a.connect(server.publicKey, { relayThrough: relay.server.publicKey })
  socket.on('error', () => {})
  socket.on('open', () => socket.write('relay ok'))
  const msg = await Promise.race([got, sleep(20000)])

  // on localhost a direct holepunch can win the race; the relay must still pair both peers
  for (let i = 0; i < 200 && !relay.relay.stats.pairings.matched; i++) await sleep(100)
  check(
    'peers connect through the relay',
    msg?.toString() === 'relay ok' && relay.relay.stats.pairings.matched > 0
  )
  await Promise.all([a.destroy(), b.destroy(), relay.close()])
}

async function perKey(testnet) {
  const relay = await start({ keyFile: keyFile(), bootstrap: testnet.bootstrap, maxPerKey: 2 })
  const a = testnet.createNode()
  const kp = DHT.keyPair()
  const first = [await served(a, relay, kp), await served(a, relay, kp)]
  check('per key: sessions up to the cap are served', first.every(Boolean))
  check('per key: the next session from that key is refused', !(await served(a, relay, kp)))
  check('per key: another key is still served', Boolean(await served(a, relay)))
  await Promise.all([a.destroy(), relay.close()])
}

async function perIp(testnet) {
  const relay = await start({ keyFile: keyFile(), bootstrap: testnet.bootstrap, maxPerIp: 2 })
  const a = testnet.createNode()
  const first = [await served(a, relay), await served(a, relay)]
  check('per IP: sessions up to the cap are served', first.every(Boolean))
  check('per IP: a fresh key from the same IP is refused', !(await served(a, relay)))
  await Promise.all([a.destroy(), relay.close()])
}

async function unpaired(testnet) {
  const relay = await start({
    keyFile: keyFile(),
    bootstrap: testnet.bootstrap,
    maxPerKey: 1,
    pairTimeout: 1500
  })
  const a = testnet.createNode()
  const kp = DHT.keyPair()
  const s = await served(a, relay, kp)
  check('unpaired: first session is served', Boolean(s))
  check('unpaired: the key is full while it is held', !(await served(a, relay, kp)))
  await sleep(2000)
  check('unpaired: the idle socket is destroyed after the timeout', s.destroyed)
  check('unpaired: its slot is free again', Boolean(await served(a, relay, kp)))
  await Promise.all([a.destroy(), relay.close()])
}

function badEnv() {
  const run = (env) =>
    spawnSync(process.execPath, [fileURLToPath(new URL('./relay.js', import.meta.url))], {
      env: { ...process.env, KEY_FILE: keyFile(), ...env },
      timeout: 15000
    })
  for (const [name, value] of [
    ['MAX_PER_KEY', '0'],
    ['MAX_PER_IP', 'abc'],
    ['MAX_SESSIONS', '1.5'],
    ['PAIR_TIMEOUT', '-1'],
    ['MAX_PER_KEY', 'Infinity']
  ]) {
    const { status, stderr } = run({ [name]: value })
    check(
      `bad env ${name}=${value} refuses to start`,
      status === 1 && /positive integer/.test(stderr)
    )
  }
}

async function main() {
  const testnet = await createTestnet(3)
  await relayed(testnet)
  await perKey(testnet)
  await perIp(testnet)
  await unpaired(testnet)
  badEnv()
  await testnet.destroy()
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ relay ok')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('error:', e.message)
  process.exit(2)
})
