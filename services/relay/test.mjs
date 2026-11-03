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
import BlindRelay from 'blind-relay'
import { start, subnet } from './relay.js'

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

// a raw blind-relay client session; pairs by token without any real traffic
async function session(node, relay) {
  const socket = node.connect(relay.server.publicKey, { keyPair: DHT.keyPair() })
  socket.on('error', () => {})
  await new Promise((r) => socket.once('open', r))
  const client = BlindRelay.Client.from(socket, { id: socket.publicKey })
  // resolves once paired; connect() then opens the raw stream through the relay so bytes can flow
  const pair = (token, isInitiator) =>
    new Promise((resolve) => {
      const raw = node.createRawStream()
      raw.on('error', () => {})
      client
        .pair(isInitiator, token, raw)
        .on('error', () => {})
        .on('data', (id) => {
          const { socket: udp, remotePort, remoteHost } = socket.rawStream
          resolve({ raw, connect: () => raw.connect(udp, id, remotePort, remoteHost) })
        })
    })
  return { socket, client, pair }
}

const token = () => DHT.keyPair().publicKey

async function unpairedPerIp(testnet) {
  const relay = await start({
    keyFile: keyFile(),
    bootstrap: testnet.bootstrap,
    maxUnpairedPerIp: 2,
    maxPerIp: 10,
    pairTimeout: 60000
  })
  const a = testnet.createNode()
  const [x, y] = [await session(a, relay), await session(a, relay)]
  const t = token()
  await Promise.all([x.pair(t, true), y.pair(t, false)])
  check('unpaired per IP: paired sessions are accepted', relay.relay.stats.pairings.matched === 1)
  const held = [await served(a, relay), await served(a, relay)]
  check('unpaired per IP: unpaired sessions up to the cap are served', held.every(Boolean))
  check(
    'unpaired per IP: the next unpaired session from that IP is refused',
    !(await served(a, relay))
  )
  check(
    'unpaired per IP: paired sessions are untouched',
    !x.socket.destroyed && !y.socket.destroyed && relay.relay.stats.sessions.active === 4
  )
  await Promise.all([a.destroy(), relay.close()])
}

function ipv6() {
  check(
    'IPv6 addresses in one /64 count together',
    subnet('2001:db8::1') === subnet('2001:db8:0:0:ffff::2') &&
      subnet('2001:db8:0:0:1::') === subnet('2001:DB8::abcd')
  )
  check(
    'IPv6 addresses in different /64s, and IPv4, stay apart',
    subnet('2001:db8:0:1::1') !== subnet('2001:db8::1') &&
      subnet('1.2.3.4') === '1.2.3.4' &&
      subnet('1.2.3.4') !== subnet('1.2.3.5')
  )
}

async function maxLinks(testnet) {
  const relay = await start({
    keyFile: keyFile(),
    bootstrap: testnet.bootstrap,
    maxLinks: 2,
    pairTimeout: 60000
  })
  const a = testnet.createNode()
  const s = await session(a, relay)
  s.pair(token(), true)
  s.pair(token(), true)
  await sleep(700)
  check('links: pairings up to the cap are accepted', !s.socket.destroyed)
  s.pair(token(), true)
  await sleep(700)
  check('links: the next pairing from that session destroys it', s.socket.destroyed)
  await Promise.all([a.destroy(), relay.close()])
}

async function idle(testnet) {
  const relay = await start({
    keyFile: keyFile(),
    bootstrap: testnet.bootstrap,
    idleTimeout: 1500,
    pairTimeout: 60000
  })
  const a = testnet.createNode()

  // a pair that never carries data times out
  let [x, y] = [await session(a, relay), await session(a, relay)]
  let t = token()
  await Promise.all([x.pair(t, true), y.pair(t, false)])
  await sleep(3000)
  check(
    'idle: a paired link that carries no bytes is closed',
    x.socket.destroyed && y.socket.destroyed
  )

  // one carrying data is kept, then closed once it goes quiet
  ;[x, y] = [await session(a, relay), await session(a, relay)]
  t = token()
  const [px, py] = await Promise.all([x.pair(t, true), y.pair(t, false)])
  px.connect()
  py.connect()
  // both ends talk, as a real handshake does: the relay only forwards once both link streams connected
  px.raw.on('data', () => {})
  py.raw.on('data', () => {})
  const talk = setInterval(() => {
    px.raw.write(Buffer.alloc(200))
    py.raw.write(Buffer.alloc(20))
  }, 300)
  await sleep(4500)
  check(
    'idle: a link carrying data keeps both sessions open',
    !x.socket.destroyed && !y.socket.destroyed
  )
  clearInterval(talk)
  await sleep(3500)
  check(
    'idle: the sessions close once the link goes quiet',
    x.socket.destroyed && y.socket.destroyed
  )
  await Promise.all([a.destroy(), relay.close()])
}

async function selfPair(testnet) {
  const relay = await start({
    keyFile: keyFile(),
    bootstrap: testnet.bootstrap,
    pairTimeout: 60000
  })
  const a = testnet.createNode()
  const s = await session(a, relay)
  const t = token()
  s.pair(t, true)
  await sleep(500)
  check('self pairing: the first request is accepted', !s.socket.destroyed)
  s.client._pair.send({ isInitiator: false, token: t, id: 1, seq: 0 })
  await sleep(700)
  check(
    'self pairing: pairing with itself destroys the session',
    s.socket.destroyed && relay.relay.stats.pairings.matched === 0
  )
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
    ['MAX_PER_KEY', 'Infinity'],
    ['MAX_UNPAIRED_PER_IP', '0'],
    ['MAX_LINKS_PER_SESSION', '0'],
    ['IDLE_TIMEOUT', 'x']
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
  await unpairedPerIp(testnet)
  ipv6()
  await maxLinks(testnet)
  await idle(testnet)
  await selfPair(testnet)
  badEnv()
  await testnet.destroy()
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ relay ok')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('error:', e.message)
  process.exit(2)
})
