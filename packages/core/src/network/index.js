import NoiseSecretStream from '@hyperswarm/secret-stream'
import Autobee from 'autobee'
import BlindPeering from 'blind-peering'
import ProtomuxWakeup from 'protomux-wakeup'
import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import { decode as decodeKey } from 'hypercore-id-encoding'
import { hash } from 'hypercore-crypto'
import HyperDHT from 'hyperdht'
import Replicator from 'hyperjoin'
import b4a from 'b4a'

import { CeroError } from '../lib/errors.js'
import { Discovery } from './discovery.js'

// a live remote answers our header in milliseconds; udx gives up on a silent one only after ~13 s
const SILENT_TIMEOUT = 3000
// the replicator runs a failed query again only in 10 min: after these, then the last over and over, while it keeps failing
const RELOOKUPS = [1000, 5000, 20000, 60000]

function toKey(k) {
  return typeof k === 'string' ? decodeKey(k) : k
}

/** @type {(topic: Uint8Array, channel: string | null) => Uint8Array} */
export function channelTopic(topic, channel) {
  return channel ? hash([topic, b4a.from(channel)]) : topic
}

/**
 * @typedef {object} NetworkOpts
 * @property {Array<{ host: string, port: number }>} [bootstrap]    Custom DHT bootstrap nodes.
 * @property {(remotePublicKey: Uint8Array, payload: unknown) => boolean} [firewall]  Incoming-connection filter.
 * @property {Array<string | Uint8Array>} [relayThrough]           Blind relay public keys; a connection goes through one only when a direct one fails or this device sits behind a randomizing NAT.
 * @property {string} [channel]                                     Optional network-isolation label; only same-channel peers meet.
 * @property {import('corestore')} store                            Corestore; every connection replicates it, so every core it holds rides every peer.
 * @property {Array<string | Uint8Array>} [mirrors]                Blind-peer public keys; each attached database/blob core is mirrored through them for offline sync.
 * @property {(err: Error) => void} [onerror]                      Background-task error handler.
 * @property {{ active?: number, idle?: number }} [presence]        The budget for topics in the rotation: how many announce at once, and the ms one keeps its slot before a touched one may take it.
 *
 * @typedef {object} Entry  One replicator session per topic, shared by every join of it.
 * @property {string} id
 * @property {import('./discovery.js').Session} session
 * @property {import('corestore')} store  The store session the replicator session lives on.
 * @property {number} refs  Joins holding the topic.
 * @property {number} pins  Joins pinning it.
 */

/**
 * Peer discovery and connections on hyperjoin, plus a shared wakeup channel. Every connection,
 * the replicator's or injected, replicates the store.
 */
export class Network extends ReadyResource {
  /** @param {NetworkOpts} opts */
  constructor({
    bootstrap,
    firewall,
    relayThrough,
    channel,
    store,
    mirrors,
    presence,
    onerror = (err) => console.error(err)
  } = {}) {
    super()
    if (!store) throw CeroError.REQUIRED('store')
    this.bootstrap = bootstrap || null
    this.firewall = firewall || null
    this.relayThrough = relayThrough?.map(toKey) || null
    this.channel = channel || null
    /** @type {import('corestore')} */
    this.store = store
    /** @type {Uint8Array[]} */
    this.mirrors = (mirrors || []).map(toKey)
    /** @type {{ active: number, idle: number }} */
    this.presence = { active: 8, idle: 30_000, ...presence }

    /** @private */
    this._replicator = null
    /** @private */
    this._dht = null
    /** @type {import('protomux-wakeup')} */
    this.wakeup = new ProtomuxWakeup()

    /** @private @type {Map<string, Entry>} */
    this._sessions = new Map()
    /** @private @type {Set<Discovery>} */
    this._discoveries = new Set()
    /** @private */
    this._injected = new Set()
    /** @private */
    this._blindPeering = null
    /** @private */
    this._peeringClosed = false
    /** @private */
    this._listening = null
    /** @private */
    this._refreshing = false
    /** @private */
    this._resuming = null
    /** @private */
    this._relookup = null
    /** @private */
    this._onerror = onerror
  }

  /** @returns {import('hyperjoin') | null} The underlying hyperjoin replicator, or null before ready / after close. */
  get replicator() {
    return this._replicator
  }

  /** @returns {import('hyperdht') | null} The DHT the replicator and the mirrors share. */
  get dht() {
    return this._dht
  }

  /** @returns {Map<string, object>} Known peers keyed by public-key hex. */
  get peers() {
    return this._replicator ? this._replicator.peers : new Map()
  }

  /** @returns {Set<import('@hyperswarm/secret-stream')>} Live connection streams — the replicator's and injected. */
  get connections() {
    const streams = new Set(this._injected)
    if (this._replicator) for (const c of this._replicator.connections) streams.add(c.stream)
    return streams
  }

  /** @returns {boolean} */
  get suspended() {
    return this._replicator?.suspended === true
  }

  /** @private */
  async _open() {
    // timeouts follow each node's measured round trip, not a flat second a try
    const dht = (this._dht = new HyperDHT({
      bootstrap: this.bootstrap,
      adaptiveTimeout: { min: 150, max: 1000 }
    }))
    const opts = {
      dht,
      slots: this.presence.active,
      minActiveTime: this.presence.idle,
      // a join owns its topic until it is destroyed
      gcIdleTime: Infinity,
      // dial a peer the moment it is found, where the replicator waits up to 500 ms
      jitter: 0
    }
    if (this.firewall) opts.firewall = this.firewall
    if (this.relayThrough) opts.relayThrough = this.relayThrough

    const rep = (this._replicator = new Replicator(this.store, opts))
    // back online after a NAT rebind or a router restart, peers may hold a stale address for us
    dht.on('network-update', () => {
      if (!dht.online) return
      // the queries sent while it was away failed
      this._watch(this._lookup()).catch(safetyCatch)
      // a tick later: the dht's own wake-up in this event would clear a refresh made now
      setTimeout(() => this.closing || rep.server.refresh(), 0)
    })
    rep.on('connected', ({ stream, info }) => {
      if (this.closing || this.closed) {
        stream.destroy()
        return
      }
      dropIfSilent(stream)
      this._add(stream, info)
    })
    await rep.ready()
    // the server listens in the background and a topic announces only once it does; with nothing joined, a flush ends there
    this._listening = rep.flush()

    if (this.mirrors.length) this.peering()
  }

  /** @private */
  async _close() {
    clearTimeout(this._relookup)
    for (const conn of [...this._injected]) {
      try {
        conn.destroy()
      } catch (err) {
        safetyCatch(err)
      }
    }
    this._injected.clear()

    // leave every topic now, never await the DHT unannounce round-trips
    for (const d of [...this._discoveries]) d.destroy().catch(safetyCatch)

    // close still awaits the unannounces and a server.close round-trip; cap it
    const rep = this._replicator
    this._replicator = null
    if (rep) await capped(rep.close().catch(safetyCatch), 750)
    const dht = this._dht
    this._dht = null
    if (dht) await dht.destroy().catch(safetyCatch)

    if (this._blindPeering) {
      try {
        await this._blindPeering.close()
      } catch (err) {
        safetyCatch(err)
      }
      this._blindPeering = null
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
   * @param {import('streamx').Duplex} stream  Duplex transport, or a ready NoiseSecretStream.
   * @param {{ isInitiator?: boolean }} [opts]  Which side initiates the noise handshake (raw duplexes only).
   * @returns {import('@hyperswarm/secret-stream')} The encrypted connection stream.
   */
  inject(stream, { isInitiator } = {}) {
    if (this.closing || this.closed) throw CeroError.CLOSED('Network')
    if (!stream) throw CeroError.REQUIRED('stream')
    // a raw duplex handshakes as the replicator does
    const keyPair = this._replicator?.keyPair ?? undefined
    const conn =
      stream.noiseStream === stream
        ? stream
        : new NoiseSecretStream(isInitiator === true, stream, keyPair ? { keyPair } : undefined)

    this._injected.add(conn)
    conn.on('close', () => this._injected.delete(conn))
    conn.on('error', safetyCatch) // a dropped radio link must not crash the host

    // the replicator replicates the store on its own connections only
    this.store.replicate(conn)
    this._add(conn, { injected: true })
    return conn
  }

  /** @private */
  _add(conn, info) {
    this.wakeup.addStream(conn)
    this.emit('connection', conn, info)
  }

  /**
   * Stop mirroring, before the databases close: blind peering reads storage for every database it
   * mirrors, so once it is closed none of its work outlives storage. `peering()` throws CLOSED
   * after it; closing the network does it too.
   *
   * @returns {Promise<void>}
   */
  async closePeering() {
    this._peeringClosed = true
    await this._blindPeering?.close()
  }

  /**
   * The blind-peering client, built on first use: a mailbox post names mirrors this network
   * may not have been given.
   *
   * @returns {import('blind-peering')}
   */
  peering() {
    if (this.closing || this.closed || this._peeringClosed) throw CeroError.CLOSED('Network')
    if (!this._blindPeering) {
      this._blindPeering = new BlindPeering(this._dht, this.store, {
        blindPeers: this.mirrors.map((key) => ({ key })),
        wakeup: this.wakeup,
        pick: 2
      })
    }
    return this._blindPeering
  }

  /**
   * Wait for pending DHT announces, lookups and dials to settle, bounded by timeout.
   *
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<void>}
   */
  async flush({ timeout = 500 } = {}) {
    const rep = this._replicator
    if (!rep) return
    await capped(this._flush(rep), timeout)
  }

  /** @private */
  async _flush(rep) {
    // a join queues its announce only when the rotation runs
    await this._rotate()
    await rep.flush()
  }

  /**
   * Pause the network — keeps state, drops sockets. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async suspend() {
    if (this.closing || this.closed) return
    await this._blindPeering?.suspend()
    await this._replicator?.suspend()
    await this._dht?.suspend()
    clearTimeout(this._relookup)
    this._relookup = null
  }

  /**
   * Resume a suspended network. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async resume() {
    if (this.closing || this.closed || !this.suspended) return
    this._resuming = this._resume()
    try {
      await this._resuming
    } finally {
      this._resuming = null
    }
    await this._blindPeering?.resume()
    // the queries the replicator runs at resume fail when they go out before the network is back
    this._watch(this._active()).catch(safetyCatch)
    this.emit('resume')
  }

  // the replicator resumes every session it holds and a destroyed one throws there: a leave in
  // flight finishes first, and one that starts meanwhile waits in _leave
  /** @private */
  async _resume() {
    await this._dht.resume()
    const rep = this._replicator
    await Promise.all([...rep.sessions.values()].map((session) => session.closing))
    await rep.resume()
  }

  /**
   * Join a 32-byte topic and return a Discovery handle. Pinned by default: it announces and
   * looks up now; `pin: false` leaves it to the rotation.
   *
   * @param {Uint8Array} topic
   * @param {{ pin?: boolean }} [opts]
   * @returns {Discovery}
   */
  join(topic, { pin = true } = {}) {
    if (this.closing || this.closed) throw CeroError.CLOSED('Network')
    if (!this._replicator) throw CeroError.NOT_READY('Network', 'network')
    if (!isTopic(topic)) throw CeroError.INVALID('topic must be a 32-byte buffer')

    const key = channelTopic(topic, this.channel)
    const id = b4a.toHex(key)
    let entry = this._sessions.get(id)
    if (!entry) {
      // a store session per topic: the root store collects no listener per topic
      const store = this.store.session()
      const session = this._replicator.join(store, key, { deferSwarming: false })
      entry = { id, session, store, refs: 0, pins: 0 }
      this._sessions.set(id, entry)
    }
    entry.refs++

    const discovery = new Discovery(this, entry, pin)
    this._discoveries.add(discovery)
    return discovery
  }

  /**
   * Where a topic stands on this network.
   *
   * @param {Uint8Array} topic
   * @returns {'inactive' | 'pinned' | 'autostarted' | 'discovering' | null} Its session's state, null when not joined.
   */
  state(topic) {
    const entry = this._sessions.get(b4a.toHex(channelTopic(topic, this.channel)))
    return entry ? entry.session.state : null
  }

  /**
   * Whether `store` replicates on this network's connections: the network's store or a session of it.
   *
   * @param {import('corestore')} store
   * @returns {boolean}
   */
  replicates(store) {
    return (store.root || store) === (this.store.root || this.store)
  }

  /**
   * Keep a core or an autobee on the mirrors, so it stays reachable while its writers are
   * offline. It rides the connections already, from the store; a mirror drops it once it closes.
   *
   * @param {import('hypercore') | import('autobee')} core
   * @returns {void}
   */
  attach(core) {
    if (!core) throw CeroError.REQUIRED('core')
    if (!this._blindPeering) return
    if (Autobee.isAutobee(core)) core.ready().then(() => this._mirror(core), this._onerror)
    else this._blindPeering.addCoreBackground(core)
  }

  /** @private */
  _mirror(bee) {
    const peering = this._blindPeering
    if (!peering || bee.closing) return
    peering.addAutobaseBackground(bee)
    // the bootstrap core leaves the writer set after the local swap, but joiners boot from it
    peering.addCoreBackground(bee.bootstrap, { referrer: bee.key })
    // autobee links views only through a trusted head, which a fresh database's first nodes lack
    const views = bee.views().map((v) => this.store.get({ key: v.key }))
    for (const view of views) peering.addCoreBackground(view, { referrer: bee.key })
    bee.once('close', () => {
      for (const view of views) view.close().catch(safetyCatch)
    })
  }

  /** @private */
  async _leave(discovery) {
    this._discoveries.delete(discovery)
    const { entry } = discovery
    if (--entry.refs > 0) return
    try {
      await this._resuming
    } catch (err) {
      safetyCatch(err)
    }
    // joined again meanwhile and the same session carries on, or another leave of it got here first
    if (entry.refs > 0 || this._sessions.get(entry.id) !== entry) return
    this._sessions.delete(entry.id)
    try {
      await entry.session.destroy()
      await entry.store.close()
    } catch (err) {
      safetyCatch(err)
    }
  }

  // an announce starts when the rotation runs, and only once the server listens
  /** @private */
  async _settle(session) {
    await this._listening
    await this._rotate()
    await session.flush()
  }

  // many joins and touches in one tick make one rotation
  /** @private */
  _refresh() {
    if (this._refreshing) return
    this._refreshing = true
    queueMicrotask(() => {
      this._refreshing = false
      this._rotate()
    })
  }

  // a topic leaving mid-rotation rejects it; the others had their state applied
  /** @private */
  async _rotate() {
    const errors = this._errors()
    await this._replicator?.refresh().catch(safetyCatch)
    // a topic that starts announcing while the network is away
    this._watch(this._active(), errors).catch(safetyCatch)
  }

  /** @private */
  _active() {
    const sessions = []
    for (const { session } of this._sessions.values()) {
      // a topic still opening has run no query
      if (session.active && session.discovery) sessions.push(session)
    }
    return sessions
  }

  /** @private */
  _lookup() {
    const sessions = this._active()
    for (const session of sessions) session.discovery.refresh()
    return sessions
  }

  // once the queries of these sessions settle: if one failed and no try waits, they are tried again
  /** @private */
  async _watch(sessions, errors = this._errors()) {
    await settled(sessions)
    if (this._errors() > errors && this._relookup === null) this._retry(0)
  }

  // every active topic again, further apart each time, until they go through
  /** @private */
  _retry(i) {
    this._relookup = setTimeout(async () => {
      const errors = this._errors()
      await settled(this._lookup())
      if (this._errors() > errors) this._retry(Math.min(i + 1, RELOOKUPS.length - 1))
      else this._relookup = null
    }, RELOOKUPS[i])
    this._relookup.unref()
  }

  /** @private */
  _errors() {
    let errors = 0
    for (const { session } of this._sessions.values()) {
      errors += session.discovery?.stats.errors ?? 0
    }
    return errors
  }
}

function settled(sessions) {
  return Promise.all(sessions.map((session) => session.discovery.flush()))
}

// data, not packets: a peer that acked our opener and froze has answered nothing
// silent since we got it: a direct connection carries its handshake on the stream, so the count
// starts above zero
function dropIfSilent(conn) {
  const seen = conn.rawStream.bytesReceived
  const timer = setTimeout(() => {
    if (conn.rawStream.bytesReceived === seen) conn.destroy()
  }, SILENT_TIMEOUT)
  timer.unref()
  conn.once('close', () => clearTimeout(timer))
}

// the timer goes once the race settles, or it keeps a closed process alive
async function capped(promise, ms) {
  let timer = null
  try {
    await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))])
  } finally {
    clearTimeout(timer)
  }
}

function isTopic(x) {
  return b4a.isBuffer(x) && x.length === 32
}
