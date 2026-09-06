import NoiseSecretStream from '@hyperswarm/secret-stream'
import Autobee from 'autobee'
import BlindPairing from 'blind-pairing'
import BlindPeering from 'blind-peering'
import Protomux from 'protomux'
import ProtomuxWakeup from 'protomux-wakeup'
import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import { decode as decodeKey } from 'hypercore-id-encoding'
import { hash } from 'hypercore-crypto'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import c from 'compact-encoding'

import { ACTIVE, PASSIVE } from '../lib/constants.js'
import { CeroError } from '../lib/errors.js'
import { Discovery } from './discovery.js'

export function channelTopic(topic, channel) {
  return channel ? hash([topic, b4a.from(channel)]) : topic
}

/**
 * @typedef {object} NetworkOpts
 * @property {import('../identity/index.js').Identity} [identity]  Long-lived keypair used as the swarm identity.
 * @property {Array<{ host: string, port: number }>} [bootstrap]    Custom DHT bootstrap nodes.
 * @property {(remotePublicKey: Uint8Array, payload: any) => boolean} [firewall]  Incoming-connection filter.
 * @property {Uint8Array[]} [relayThrough]                          Relay public keys to tunnel through.
 * @property {number[]} [backoffs]                                  Reconnect backoff tiers in ms; the default escalates to ~10min, far too slow for local nets.
 * @property {string} [channel]                                     Optional network-isolation label; only same-channel peers meet.
 * @property {any} [store]                                          Corestore; required for mirrors (blind peers replicate its cores).
 * @property {Array<string | Uint8Array>} [mirrors]                Blind-peer public keys; each attached room/blob core is mirrored through them for offline sync.
 *
 * @typedef {{ replicate: (stream: any) => any }} Replicable
 */

/**
 * Hyperswarm peer-discovery + replication multiplexer. Wraps a swarm and a
 * shared wakeup channel, replicating any attached resource onto every peer.
 */
export class Network extends ReadyResource {
  /** @param {NetworkOpts} [opts] */
  constructor({
    identity,
    bootstrap,
    firewall,
    relayThrough,
    backoffs,
    channel,
    store,
    mirrors
  } = {}) {
    super()
    this.identity = identity || null
    this.bootstrap = bootstrap || null
    this.firewall = firewall || null
    this.relayThrough = relayThrough || null
    this.backoffs = backoffs || null
    this.channel = channel || null
    this.store = store || null
    this.mirrors = (mirrors || []).map((k) => (typeof k === 'string' ? decodeKey(k) : k))

    this._swarm = null
    this.wakeup = new ProtomuxWakeup()

    this.info = null
    this._peerInfo = new Map()
    this._infoSenders = new Set()

    this._replicateables = new Set()
    this._discoveries = new Set()
    this._injected = new Set()
    this._blind = null
    this._blindPeering = null
  }

  /** @returns {any} The underlying hyperswarm, or null before ready / after close. */
  get swarm() {
    return this._swarm
  }

  /** @returns {Map<string, any>} Known peers keyed by public-key string. */
  get peers() {
    return this.swarm ? this.swarm.peers : new Map()
  }

  /** @returns {Set<any>} Live connection streams — swarm and injected. */
  get connections() {
    if (!this._injected.size) return this.swarm ? this.swarm.connections : new Set()
    return new Set([...(this.swarm ? this.swarm.connections : []), ...this._injected])
  }

  /** @returns {boolean} */
  get suspended() {
    return this.swarm?.suspended === true
  }

  async _open() {
    const opts = {}
    if (this.identity) {
      opts.keyPair = { publicKey: this.identity.publicKey, secretKey: this.identity.secretKey }
    }
    if (this.bootstrap) opts.bootstrap = this.bootstrap
    if (this.firewall) opts.firewall = this.firewall
    if (this.relayThrough) opts.relayThrough = this.relayThrough
    if (this.backoffs) opts.backoffs = this.backoffs

    const swarm = (this._swarm = new Hyperswarm(opts))
    swarm.on('connection', (stream, info) => {
      if (this.closing || this.closed) {
        stream.destroy()
        return
      }
      this.wakeup.addStream(stream)
      this._attachInfo(stream)
      for (const r of this._replicateables) replicateInto(r, stream)
      this.emit('connection', stream, info)
    })

    if (this.store && this.mirrors.length) {
      this._blindPeering = new BlindPeering(swarm.dht, this.store, {
        blindPeers: this.mirrors.map((key) => ({ key })),
        wakeup: this.wakeup,
        pick: 2
      })
    }
  }

  async _close() {
    for (const conn of [...this._injected]) {
      try {
        conn.destroy()
      } catch (err) {
        safetyCatch(err)
      }
    }
    this._injected.clear()

    // stop discovery now, never await the DHT unannounce round-trips
    for (const d of [...this._discoveries]) d.destroy().catch(safetyCatch)
    this._discoveries.clear()

    // the swarm dies first with force, so per-topic unannounces become no-ops
    const swarm = this._swarm
    this._swarm = null
    if (swarm) {
      // force destroy still awaits a server.close round-trip; cap it
      await Promise.race([
        swarm.destroy({ force: true }).catch(safetyCatch),
        new Promise((r) => setTimeout(r, 750))
      ])
    }

    if (this._blindPeering) {
      try {
        await this._blindPeering.close()
      } catch (err) {
        safetyCatch(err)
      }
      this._blindPeering = null
    }

    if (this._blind) {
      try {
        await (await this._blind).close()
      } catch (err) {
        safetyCatch(err)
      }
      this._blind = null
    }

    if (this.wakeup) {
      try {
        await this.wakeup.destroy()
      } catch (err) {
        safetyCatch(err)
      }
    }
  }

  /**
   * Feed an externally-established connection — a Bluetooth L2CAP channel, a serial link, an
   * in-process pair, any duplex — into the network.
   *
   * @param {any} stream  Duplex transport, or a ready NoiseSecretStream.
   * @param {{ isInitiator?: boolean }} [opts]  Which side initiates the noise handshake (raw duplexes only).
   * @returns {any} The encrypted connection stream.
   */
  inject(stream, { isInitiator } = {}) {
    if (this.closing || this.closed) throw CeroError.CLOSED('Network')
    if (!stream) throw CeroError.REQUIRED('stream')
    // the swarm identity, so two radios between one pair dedupe to one peer
    const keyPair = this.identity
      ? { publicKey: this.identity.publicKey, secretKey: this.identity.secretKey }
      : (this.swarm?.keyPair ?? undefined)
    const conn =
      stream.noiseStream === stream
        ? stream
        : new NoiseSecretStream(isInitiator === true, stream, keyPair ? { keyPair } : undefined)

    // blind-pairing sends on the lowest-rtt channel; an injected duplex has no rtt, so give it one
    if (conn.rawStream && conn.rawStream.rtt === undefined) conn.rawStream.rtt = 0

    this._injected.add(conn)
    conn.on('close', () => this._injected.delete(conn))
    conn.on('error', safetyCatch) // a dropped radio link must not crash the host

    this.wakeup.addStream(conn)
    this._attachInfo(conn)
    for (const r of this._replicateables) replicateInto(r, conn)
    this.emit('connection', conn, { injected: true })
    return conn
  }

  /**
   * Lazily create the network-shared BlindPairing.
   *
   * @returns {Promise<any>}
   */
  async blind() {
    if (this.closing || this.closed) throw CeroError.CLOSED('Network')
    if (!this._blind) {
      const blind = new BlindPairing(this.swarm)
      this._blind = blind.ready().then(() => {
        // blind-pairing only watches the swarm; injected connections must reach it too
        this.on('connection', (conn, info) => {
          if (info?.injected) blind._onconnection(conn)
        })
        for (const conn of this._injected) blind._onconnection(conn)
        return blind
      })
    }
    return this._blind
  }

  /**
   * Re-attach pairing channels on injected connections. blind-pairing only auto-attaches
   * refs that existed when a connection arrived — swarm peers meet again over topic joins,
   * injected links (Bluetooth,.
   *
   * @returns {Promise<void>}
   */
  async refreshInjected() {
    if (!this._blind || !this._injected.size) return
    const blind = await this._blind
    for (const conn of this._injected) blind._onconnection(conn)
  }

  /**
   * Declare this peer's self-reported info ({ name, ... }).
   *
   * @param {object | null} info
   */
  setInfo(info) {
    this.info = info || null
    if (!this.info) return
    for (const send of this._infoSenders) send()
  }

  /**
   * Info a connected peer declared about itself, or null.
   *
   * @param {Uint8Array | string} key  Peer public key (bytes or hex).
   * @returns {object | null}
   */
  getInfo(key) {
    const hex = typeof key === 'string' ? key : b4a.toString(key, 'hex')
    return this._peerInfo.get(hex) ?? null
  }

  /**
   * Wait for pending DHT announces and lookups to settle, bounded by timeout.
   *
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<void>}
   */
  async flush({ timeout = 500 } = {}) {
    if (!this._swarm) return
    await Promise.race([this._swarm.flush(), new Promise((r) => setTimeout(r, timeout))])
  }

  /**
   * Pause the swarm — keeps state, drops sockets. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async suspend() {
    if (this.closing || this.closed) return
    await this._blindPeering?.suspend()
    try {
      await this._swarm?.suspend()
    } catch (err) {
      safetyCatch(err)
    }
  }

  /**
   * Resume a suspended swarm. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async resume() {
    if (this.closing || this.closed) return
    try {
      await this._swarm?.resume()
    } catch (err) {
      safetyCatch(err)
    }
    await this._blindPeering?.resume()
  }

  /**
   * Announce/lookup on a 32-byte topic and return a Discovery handle.
   *
   * @param {Uint8Array} topic
   * @param {{ mode?: 'active' | 'passive' }} [opts]  `active` = client+server, `passive` = server-only
   * @returns {Discovery}
   */
  join(topic, { mode = ACTIVE } = {}) {
    if (mode !== ACTIVE && mode !== PASSIVE) {
      throw CeroError.INVALID('mode must be "active" or "passive"')
    }
    if (this.closing || this.closed) throw CeroError.CLOSED('Network')
    if (!this.swarm) throw CeroError.NOT_READY('Network', 'network')
    if (!isTopic(topic)) throw CeroError.INVALID('topic must be a 32-byte buffer')

    const session = this.swarm.join(channelTopic(topic, this.channel), {
      client: mode === ACTIVE,
      server: true
    })

    const discovery = new Discovery(this, session, mode)
    this._discoveries.add(discovery)
    return discovery
  }

  /**
   * Register a replicable resource (hypercore, autobee, hyperdb).
   * It is replicated on every current and future swarm connection.
   *
   * @param {Replicable} core
   * @returns {void}
   */
  attach(core) {
    if (!core) throw CeroError.REQUIRED('core')
    this._replicateables.add(core)
    for (const stream of this.connections) replicateInto(core, stream)
    // mirror the core so it stays available while its writers are offline
    if (this._blindPeering) {
      if (Autobee.isAutobee(core)) {
        this._blindPeering.addAutobaseBackground(core)
        // the bootstrap core leaves the writer set after the local swap, but joiners boot from it
        const mirrorBootstrap = () =>
          this._blindPeering?.addCoreBackground(core.bootstrap, { referrer: core.key })
        core.ready().then(mirrorBootstrap, safetyCatch)
      } else this._blindPeering.addCoreBackground(core)
    }
  }

  /**
   * Unregister a previously attached resource. New connections will no
   * longer replicate it (existing replication streams continue).
   *
   * @param {Replicable} core
   * @returns {void}
   */
  detach(core) {
    if (!core) throw CeroError.REQUIRED('core')
    this._replicateables.delete(core)
  }

  /**
   * Replicate a one-off resource onto every current swarm connection
   * without registering it as a long-lived attachment.
   *
   * @param {Replicable} target
   * @returns {void}
   */
  replicate(target) {
    if (!target || typeof target.replicate !== 'function') {
      throw CeroError.INVALID('target must be an object with a replicate(stream) method')
    }
    for (const stream of this.connections) replicateInto(target, stream)
  }

  // silent until a side has info: bytes on a fresh connection trip hyperswarm's duplicate guard
  _attachInfo(conn) {
    const mux = Protomux.from(conn)
    let message = null
    const send = () => {
      if (!message) {
        const channel = mux.createChannel({ protocol: 'cero/info' })
        if (channel === null) return
        message = channel.addMessage({
          encoding: c.json,
          onmessage: (info) => {
            if (!info || typeof info !== 'object') return
            const hex = b4a.toString(conn.remotePublicKey, 'hex')
            this._peerInfo.set(hex, info)
            this.emit('peer-info', hex, info)
          }
        })
        channel.open()
      }
      if (this.info) message.send(this.info)
    }
    mux.pair({ protocol: 'cero/info' }, send)
    this._infoSenders.add(send)
    conn.on('close', () => this._infoSenders.delete(send))
    if (this.info) send()
  }
}

// corestore replication is store-wide: replicate each root once per connection
const replicatedRoots = new WeakMap()

function replicateInto(core, stream) {
  const root = core.store ? core.store.root || core.store : null
  if (root) {
    let seen = replicatedRoots.get(stream)
    if (!seen) replicatedRoots.set(stream, (seen = new WeakSet()))
    if (seen.has(root)) return
    seen.add(root)
  }
  try {
    core.replicate(stream)
  } catch (err) {
    safetyCatch(err)
  }
}

function isTopic(x) {
  return b4a.isBuffer(x) && x.length === 32
}
