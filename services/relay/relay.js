// A HyperDHT node that accepts blind-relay sessions: peers that can't
// holepunch tunnel their (already encrypted) UDX streams through it.
import fs from 'fs'
import DHT from 'hyperdht'
import BlindRelay from 'blind-relay'
import z32 from 'z32'

const DEFAULTS = { maxPerKey: 8, maxPerIp: 256, maxSessions: 2000, pairTimeout: 10000 }

// The keypair is a 32-byte seed in a file, so the public key survives restarts.
function keyPair(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, DHT.keyPair().secretKey.subarray(0, 32), { mode: 0o600 })
  }
  return DHT.keyPair(fs.readFileSync(file))
}

// counts of open sessions per key, refusing past max
function counter(max) {
  const counts = new Map()
  return {
    full: (k) => (counts.get(k) || 0) >= max,
    add: (k) => counts.set(k, (counts.get(k) || 0) + 1),
    drop(k) {
      const left = counts.get(k) - 1
      if (left) counts.set(k, left)
      else counts.delete(k)
    }
  }
}

// Open by design (every device has its own key), so bound abuse: sessions are
// capped per public key, per IP (keys are free to mint) and in total, and a
// session that never pairs is dropped so it can't hold a slot.
export async function start({ keyFile, port, bootstrap, ...opts }) {
  const cfg = { ...DEFAULTS, ...opts }
  for (const [name, n] of Object.entries(cfg)) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`)
  }

  const dht = new DHT({ port, bootstrap, ephemeral: false, firewalled: false })
  const relay = new BlindRelay.Server({ createStream: (o) => dht.createRawStream(o) })
  const byKey = counter(cfg.maxPerKey)
  const byIp = counter(cfg.maxPerIp)
  const all = counter(cfg.maxSessions)

  const server = dht.createServer((socket) => {
    const key = socket.remotePublicKey.toString('hex')
    const ip = socket.rawStream.remoteHost
    socket.on('error', () => {})
    if (byKey.full(key) || byIp.full(ip) || all.full('')) return socket.destroy()

    byKey.add(key)
    byIp.add(ip)
    all.add('')
    const timer = setTimeout(() => socket.destroy(), cfg.pairTimeout)
    socket.on('close', () => {
      clearTimeout(timer)
      byKey.drop(key)
      byIp.drop(ip)
      all.drop('')
    })

    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', () => {})
    session.once('pair', () => clearTimeout(timer))
  })
  await server.listen(keyPair(keyFile))
  return { dht, server, relay, close: () => server.close().then(() => dht.destroy()) }
}

const ENV = {
  MAX_PER_KEY: 'maxPerKey',
  MAX_PER_IP: 'maxPerIp',
  MAX_SESSIONS: 'maxSessions',
  PAIR_TIMEOUT: 'pairTimeout'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { KEY_FILE = '/data/key', PORT = '49738' } = process.env
  const caps = Object.entries(ENV)
    .filter(([env]) => process.env[env] !== undefined)
    .map(([env, name]) => [name, Number(process.env[env])])
  start({ keyFile: KEY_FILE, port: Number(PORT), ...Object.fromEntries(caps) }).then(
    ({ server }) => console.log(`Listening at ${z32.encode(server.publicKey)}`),
    (e) => {
      console.error(`relay: ${e.message}`)
      process.exit(1)
    }
  )
}
