import NoiseSecretStream from '@hyperswarm/secret-stream'
import Autobee from 'autobee'
import BlindPeering from 'blind-peering'
import ProtomuxWakeup from 'protomux-wakeup'
import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import { decode as decodeKey } from 'hypercore-id-encoding'
import { hash } from 'hypercore-crypto'
import HyperDHT from 'hyperdht'
import Replicator from '@holepunchto/replicator'
import b4a from 'b4a'

import { CeroError } from '../lib/errors.js'
import { Discovery, stamp } from './discovery.js'

// a live remote answers our header in milliseconds; udx gives up on a silent one only after ~13 s
const SILENT_TIMEOUT = 3000
// the replicator re-queries a topic every 10 min on its own: too slow for a device that resumed before its network was back
const RELOOKUPS = [5000, 20000, 60000]
// how often the rotation runs: a touched topic waits at most this plus `idle` for a slot
const INTERVAL = 1000
// peers joining at once look up before either announce lands; the replicator looks again only in 10 min
const REQUERY = [1000, 3000]

/** @type {(topic: Uint8Array, channel: string | null) => Uint8Array} */
export function channelTopic(topic, channel) {
  return channel ? hash([topic, b4a.from(channel)]) : topic
}

/**
 * @typedef {object} NetworkOpts
 * @property {import('../identity/index.js').Identity} [identity]  Long-lived keypair used as the peer identity.
 * @property {Array<{ host: string, port: number }>} [bootstrap]    Custom DHT bootstrap nodes.
 * @property {(remotePublicKey: Uint8Array, payload: unknown) => boolean} [firewall]  Incoming-connection filter.
 * @property {Uint8Array[]} [relayThrough]                          Relay public keys to tunnel through.
 * @property {string} [channel]                                     Optional network-isolation label; only same-channel peers meet.
 * @property {import('corestore')} store                            Corestore; every connection replicates it, so every core it holds rides every peer.
 * @property {Array<string | Uint8Array>} [mirrors]                Blind-peer public keys; each attached database/blob core is mirrored through them for offline sync.
 * @property {(err: Error) => void} [onerror]                      Background-task error handler.
 * @property {{ active?: number, idle?: number }} [presence]        The budget for topics in the rotation: how many announce at once, and the ms one keeps its slot before a touched one may take it.
 *
 * @typedef {object} Entry  One replicator session per topic, shared by every join of it.
 * @property {string} id
 * @property {Uint8Array} key  The topic as joined, channelled.
 * @property {import('./discovery.js').Session | null} session  Null while the last one leaves.
 * @property {import('corestore') | null} store
 * @property {number} refs
 * @property {boolean} pin
 * @property {number} priority
 * @property {Promise<void> | null} closing  The previous session's leave, while a join waits on it.
 */

/**
 * Peer discovery and connections on the Holepunch replicator, plus a shared wakeup channel.
 * Every connection, replicator or injected, replicates the store.
 */
export class Network extends ReadyResource {
  /** @param {NetworkOpts} opts */
  constructor({
    identity,
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
    this.identity = identity || null
    this.bootstrap = bootstrap || null
    this.firewall = firewall || null
    this.relayThrough = relayThrough || null
    this.channel = channel || null
    /** @type {import('corestore')} */
    this.store = store
    /** @type {Uint8Array[]} */
    this.mirrors = (mirrors || []).map((k) => (typeof k === 'string' ? decodeKey(k) : k))
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
    this._refreshing = false
    /** @private */
    this._relookup = null
    /** @private */
    this._resuming = null
    /** @private */
    this._onerror = onerror
  }

  /** @returns {import('@holepunchto/replicator') | null} The underlying replicator, or null before ready / after close. */
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

  /** @returns {Set<import('@hyperswarm/secret-stream')>} Live connection streams — replicator and injected. */
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
      interval: INTERVAL,
      // a handle owns its topic for life and leaves by destroying its discovery
      gcIdleTime: Infinity,
      // the replicator's own re-lookup sleeps inside flush(); ours runs beside it
      dhtFastRetry: 0
    }
    if (this.identity) {
      opts.keyPair = { publicKey: this.identity.publicKey, secretKey: this.identity.secretKey }
    }
    if (this.firewall) opts.firewall = this.firewall
    if (this.relayThrough) opts.relayThrough = this.relayThrough

    const rep = (this._replicator = new Replicator(this.store, opts))
    rep.on('error', this._onerror)
    // back online after a NAT rebind or a router restart, peers may hold a stale address for us
    dht.on('network-update', () => {
      // a tick later: the dht's own wake-up in this event would clear a refresh made now
      if (dht.online) setTimeout(() => this.closing || rep.server.refresh(), 0)
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
    if (rep) {
      await Promise.race([rep.close().catch(safetyCatch), new Promise((r) => setTimeout(r, 750))])
    }
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
    // a raw duplex handshakes as this identity
    const keyPair = this.identity
      ? { publicKey: this.identity.publicKey, secretKey: this.identity.secretKey }
      : (this._replicator?.keyPair ?? undefined)
    const conn =
      stream.noiseStream === stream
        ? stream
        : new NoiseSecretStream(isInitiator === true, stream, keyPair ? { keyPair } : undefined)

    this._injected.add(conn)
    conn.on('close', () => this._injected.delete(conn))
    conn.on('error', safetyCatch) // a dropped radio link must not crash the host

    this.store.replicate(conn)
    this._add(conn, { injected: true })
    return conn
  }

  // the replicator replicates the store on its own connections; inject does on its own
  /** @private */
  _add(conn, info) {
    this.wakeup.addStream(conn)
    this.emit('connection', conn, info)
  }

  /**
   * The blind-peering client, built on first use: a mailbox post names mirrors this network
   * may not have been given.
   *
   * @returns {import('blind-peering')}
   */
  peering() {
    if (this.closing || this.closed) throw CeroError.CLOSED('Network')
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
    // a refresh first: a join queues its announce only when the rotation runs
    // a topic leaving mid-refresh rejects it; the flush still means what it says
    await Promise.race([
      rep
        .refresh()
        .catch(safetyCatch)
        .then(() => rep.flush()),
      new Promise((r) => setTimeout(r, timeout))
    ])
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
  }

  /**
   * Resume a suspended network. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async resume() {
    if (this.closing || this.closed || !this.suspended) return
    await this._dht?.resume()
    // a leave in flight finishes first: the replicator would resume its destroyed discovery
    await Promise.all([...this._sessions.values()].map((e) => e.closing))
    this._resuming = this._replicator?.resume()
    try {
      await this._resuming
    } finally {
      this._resuming = null
    }
    await this._blindPeering?.resume()
    this._refresh()
    // the queries the replicator runs at resume can go out before the network is back
    this._relook(0)
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
      entry = {
        id,
        key,
        session: null,
        store: null,
        refs: 0,
        pin: false,
        priority: 0,
        closing: null
      }
      this._sessions.set(id, entry)
    }
    entry.refs++
    entry.pin ||= pin
    // the replicator refuses a topic whose last session is still leaving: that join waits in _leave
    if (!entry.session && !entry.closing) this._start(entry)
    else if (pin) entry.session?.pin()

    const discovery = new Discovery(this, entry)
    this._discoveries.add(discovery)
    // opening counts as a touch
    discovery.touch()
    this._refresh()
    return discovery
  }

  /**
   * Where a topic stands on this network.
   *
   * @param {Uint8Array} topic
   * @returns {'inactive' | 'pinned' | 'autostarted' | 'discovering' | 'destroyed' | null} Its session's state, null once left.
   */
  state(topic) {
    const entry = this._sessions.get(b4a.toHex(channelTopic(topic, this.channel)))
    if (!entry?.refs) return null
    return entry.session?.state ?? 'inactive'
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

  // a store session per topic: the replicator ends the session with it, and the root store collects no listener per topic
  /** @private */
  _start(entry) {
    entry.store = this.store.session()
    const session = (entry.session = this._replicator.join(entry.store, entry.key, {
      pin: entry.pin,
      priority: entry.priority,
      deferSwarming: false
    }))
    session.flush().then(() => requery(session), safetyCatch)
  }

  /** @private */
  async _leave(discovery) {
    this._discoveries.delete(discovery)
    const { entry } = discovery
    // a join still waiting on the last leave: that leave's continuation drops the entry
    if (--entry.refs > 0 || !entry.session) return
    const { session, store } = entry
    entry.session = null
    entry.store = null
    entry.pin = false
    // and never while the replicator resumes, for the same reason
    entry.closing = Promise.resolve(this._resuming).then(() => leave(session, store))
    await entry.closing
    entry.closing = null
    // joined again while it left
    if (entry.refs > 0 && this._replicator) {
      this._start(entry)
      this._refresh()
    } else this._sessions.delete(entry.id)
  }

  // many joins and touches in one tick make one refresh
  /** @private */
  _refresh() {
    if (this._refreshing) return
    this._refreshing = true
    queueMicrotask(() => {
      this._refreshing = false
      if (this._replicator && !this.closing) this._replicator.refresh().catch(safetyCatch)
    })
  }

  /** @private */
  _relook(i) {
    clearTimeout(this._relookup)
    this._relookup = setTimeout(() => {
      if (!this._replicator || this.connections.size) return
      this._lookup()
      if (i + 1 < RELOOKUPS.length) this._relook(i + 1)
    }, RELOOKUPS[i])
    this._relookup.unref()
  }

  // every topic announcing or looking up queries again; a topic mid-leave has no session
  /** @private */
  _lookup() {
    for (const { session } of this._sessions.values()) {
      if (session?.active) session.discovery?.refresh()
    }
  }
}

function requery(session) {
  const timer = setTimeout(
    () => {
      if (session.active && !session.closing) session.discovery.refresh()
    },
    REQUERY[0] + Math.random() * (REQUERY[1] - REQUERY[0])
  )
  timer.unref()
}

async function leave(session, store) {
  try {
    await session.destroy()
    await store.close()
  } catch (err) {
    safetyCatch(err)
  }
}

function dropIfSilent(conn) {
  const timer = setTimeout(() => {
    if (conn.rawStream.packetsReceived === 0) conn.destroy()
  }, SILENT_TIMEOUT)
  timer.unref()
  conn.once('close', () => clearTimeout(timer))
}

function isTopic(x) {
  return b4a.isBuffer(x) && x.length === 32
}
