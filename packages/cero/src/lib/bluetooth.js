import ReadyResource from 'ready-resource'
import BluetoothSwarm from 'ble-swarm'
import crypto from 'hypercore-crypto'
import safetyCatch from 'safety-catch'
import b4a from 'b4a'

import { Pairing } from '@cero-base/core/pairing'
import { Invite } from '@cero-base/core/invite'

/**
 * `me.bluetooth` — the app-facing surface for nearby (Bluetooth) sync, a thin facade over
 * ble-swarm.
 *
 * @extends ReadyResource
 */
export class Bluetooth extends ReadyResource {
  /**
   * @param {object} handle           Root cero Handle (network + identity + channel).
   * @param {object} [opts]
   * @param {any} [opts.backend]      Injected bare-bluetooth-shaped backend (tests); omitted → ble-swarm loads its own, null/false → unsupported.
   * @param {boolean} [opts.autoStart]  Start on handle open (from `cero({ bluetooth: true })`).
   * @param {number} [opts.maxOutbound]  Max concurrent outbound links; gossip covers the rest.
   * @param {number} [opts.maxInbound]   Max concurrent inbound sessions; newcomers past this are refused.
   * @param {'l2cap' | 'gatt'} [opts.pipe]  Data pipe — 'l2cap' (default, faster) or 'gatt'. Both peers must match.
   */
  constructor(handle, { backend, autoStart, maxOutbound, maxInbound, pipe } = {}) {
    super()
    this._handle = handle
    this._autoStart = autoStart === true
    /** @type {{ hex: string, count: number, timer: any } | null} active invite rendezvous (single topic — one at a time) */
    this._announce = null
    this._restorePending = false

    const identity = handle.identity
    // one mesh topic per channel, or a global one when channelless; strangers still sync nothing
    this._topic = crypto.hash(b4a.from(handle.network.channel || 'cero-ble'))
    this.swarm = new BluetoothSwarm({
      backend,
      // the swarm identity, so one person over Wi-Fi and BLE dedupes to one peer
      keyPair: { publicKey: identity.publicKey, secretKey: identity.secretKey },
      topic: this._topic,
      tag: 'cero-ble',
      pipe,
      maxOutbound,
      maxInbound
    })
    this.swarm.on('update', () => {
      // retune to the mesh only once the pairing link's initial replication drained
      if (this._restorePending && this.swarm.peers.size === 0) {
        this._restorePending = false
        this.swarm.setTopic(this._topic).catch(safetyCatch)
      }
      this.emit('update')
    })
    this.swarm.on('connection', (conn) => {
      this._handle.network.inject(conn)
    })
  }

  /** @returns {'unsupported'|'unauthorized'|'off'|'waiting'|'starting'|'on'} */
  get state() {
    return this.swarm.state
  }

  /** @returns {Map<string, any>} Live BLE links, keyed by peer public key. */
  get peers() {
    return this.swarm.peers
  }

  async _open() {
    if (this._autoStart) await this.start()
  }

  async _close() {
    this._clearAnnounce()
    await this.swarm.destroy()
  }

  /**
   * Begin advertising + scanning. Idempotent; no-op when unsupported.
   *
   * @returns {Promise<void>}
   */
  async start() {
    await this.swarm.start()
  }

  /**
   * Stop advertising/scanning and drop links; open invite rendezvous end with the radio.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this._clearAnnounce()
    await this.swarm.stop()
    // while stopped setTopic sticks; a start() + announce() during the await wins
    if (!this._announce) await this.swarm.setTopic(this._topic)
  }

  /**
   * Offline join rendezvous: retune the radio to the invite-derived topic so holder and
   * joiner find each other with zero DHT.
   *
   * @param {string} invite  Z32 invite string.
   * @returns {() => void}
   */
  announce(invite) {
    if (!this.swarm.supported) return () => {}
    if (this.state !== 'on' && this.state !== 'waiting' && this.state !== 'starting') {
      return () => {}
    }
    const topic = Pairing.inviteTopic(invite)
    if (!topic) return () => {}

    const hex = b4a.toString(topic, 'hex')
    if (this._announce && this._announce.hex !== hex) this._stopAnnounce()
    if (!this._announce) {
      const entry = { hex, count: 0, timer: null }
      const { expires } = Invite.parse(invite)
      if (expires > 0) {
        entry.timer = setTimeout(() => this._stopAnnounce(), Math.max(0, expires - Date.now()))
      }
      this._announce = entry
      this._restorePending = false
      this.swarm.setTopic(topic).catch(safetyCatch)
    }
    const entry = this._announce
    entry.count++

    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      if (this._announce === entry && --entry.count <= 0) this._stopAnnounce()
    }
  }

  /**
   * Host-lifecycle pause (app backgrounded): radio down, user intent kept.
   *
   * @returns {Promise<void>}
   */
  async suspend() {
    await this.swarm.suspend()
  }

  /**
   * Resume after a host-lifecycle pause.
   *
   * @returns {Promise<void>}
   */
  async resume() {
    await this.swarm.resume()
  }

  _stopAnnounce() {
    this._clearAnnounce()
    if (this.swarm.peers.size > 0) this._restorePending = true
    else this.swarm.setTopic(this._topic).catch(safetyCatch)
  }

  _clearAnnounce() {
    const e = this._announce
    if (!e) return
    if (e.timer) clearTimeout(e.timer)
    this._announce = null
    this._restorePending = false
  }
}
