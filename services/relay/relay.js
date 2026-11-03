// A HyperDHT node that accepts blind-relay sessions: peers that can't
// holepunch tunnel their (already encrypted) UDX streams through it.
import fs from 'fs'
import DHT from 'hyperdht'
import BlindRelay from 'blind-relay'
import z32 from 'z32'

const DEFAULTS = {
  maxPerKey: 8,
  maxPerIp: 256,
  maxUnpairedPerIp: 16,
  maxSessions: 2000,
  maxLinks: 16,
  pairTimeout: 10000,
  idleTimeout: 60000
}

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

// Counts by network, not address: IPv6 hosts hold a whole /64 and mint addresses freely.
export function subnet(ip) {
  if (!ip.includes(':')) return ip
  const [head, tail = ''] = ip.split('::')
  const groups = head ? head.split(':') : []
  const rest = tail ? tail.split(':') : []
  const missing = ip.includes('::') ? 8 - groups.length - rest.length : 0
  const all = [...groups, ...Array(missing).fill('0'), ...rest]
  return all
    .slice(0, 4)
    .map((g) => parseInt(g || '0', 16).toString(16))
    .join(':')
}

// Open by design (every device has its own key), so bound abuse: sessions are
// capped per public key, per IP (keys are free to mint) and in total, with a
// lower per-IP cap while unpaired. A session that never pairs is dropped, so is
// one that holds no live link for idleTimeout, and one asking for more than
// maxLinks pairings. (Reaches into blind-relay@1.6.1 session internals, hence the pin.)
export async function start({ keyFile, port, bootstrap, ...opts }) {
  const cfg = { ...DEFAULTS, ...opts }
  for (const [name, n] of Object.entries(cfg)) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`)
  }

  const dht = new DHT({ port, bootstrap, ephemeral: false, firewalled: false })
  const relay = new BlindRelay.Server({ createStream: (o) => dht.createRawStream(o) })
  const byKey = counter(cfg.maxPerKey)
  const byIp = counter(cfg.maxPerIp)
  const unpaired = counter(cfg.maxUnpairedPerIp)
  const all = counter(cfg.maxSessions)

  const server = dht.createServer((socket) => {
    const key = socket.remotePublicKey.toString('hex')
    const ip = subnet(socket.rawStream.remoteHost)
    socket.on('error', () => {})
    if (byKey.full(key) || byIp.full(ip) || unpaired.full(ip) || all.full('')) {
      return socket.destroy()
    }

    let waiting = true
    let timer
    const arm = (ms) => {
      clearTimeout(timer)
      timer = setTimeout(() => socket.destroy(), ms)
    }
    const paired = () => {
      if (!waiting) return
      waiting = false
      unpaired.drop(ip)
    }

    byKey.add(key)
    byIp.add(ip)
    unpaired.add(ip)
    all.add('')
    arm(cfg.pairTimeout)
    socket.on('close', () => {
      clearTimeout(timer)
      byKey.drop(key)
      byIp.drop(ip)
      if (waiting) unpaired.drop(ip)
      all.drop('')
    })

    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', () => {})

    const onpair = session._pair.onmessage
    session._pair.onmessage = (msg, s) => {
      if (session._pairing.size + session._links.size >= cfg.maxLinks) return socket.destroy()
      return onpair(msg, s)
    }
    session.on('pair', (isInitiator, token, stream) => {
      clearTimeout(timer)
      paired()
      stream.once('close', () => {
        if (!session._links.size) arm(cfg.idleTimeout)
      })
    })
  })
  await server.listen(keyPair(keyFile))
  return { dht, server, relay, close: () => server.close().then(() => dht.destroy()) }
}

const ENV = {
  MAX_PER_KEY: 'maxPerKey',
  MAX_PER_IP: 'maxPerIp',
  MAX_UNPAIRED_PER_IP: 'maxUnpairedPerIp',
  MAX_SESSIONS: 'maxSessions',
  MAX_LINKS_PER_SESSION: 'maxLinks',
  PAIR_TIMEOUT: 'pairTimeout',
  IDLE_TIMEOUT: 'idleTimeout'
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
