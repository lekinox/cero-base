import ReadyResource from 'ready-resource'
import BluetoothSwarm from 'ble-swarm'
import crypto from 'hypercore-crypto'
import safetyCatch from 'safety-catch'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'

import { Identity } from '@cero-base/core/identity'
import { Invite } from '@cero-base/core/invite'

// what a person signs to claim one of its devices: the key that device links with
const DEVICE = b4a.from('cero/device')

/**
 * `me.bluetooth` — the app-facing surface for nearby (Bluetooth) sync, a thin facade over
 * ble-swarm.
 *
 * @extends ReadyResource
 */
export class Bluetooth extends ReadyResource {
  /**
   * @param {import('@cero-base/core/network').Network} network  Where links go: its channel scopes the mesh.
   * @param {object} opts
   * @param {import('@cero-base/core/identity').Identity} opts.identity  Signs this device's key for the peers it links with.
   * @param {import('@cero-base/core/identity').KeyPair} opts.keyPair  This device's writer keypair.
   * @param {object | null} [opts.backend]  Injected bare-bluetooth-shaped backend (tests); omitted → ble-swarm loads its own, null/false → unsupported.
   * @param {boolean} [opts.autoStart]  Start on open (from `cero({ bluetooth: true })`).
   * @param {number} [opts.maxOutbound]  Max concurrent outbound links; gossip covers the rest.
   * @param {number} [opts.maxInbound]   Max concurrent inbound sessions; newcomers past this are refused.
   * @param {'l2cap' | 'gatt'} [opts.pipe]  Data pipe — 'l2cap' (default, faster) or 'gatt'. Both peers must match.
   */
  constructor(network, { identity, keyPair, backend, autoStart, maxOutbound, maxInbound, pipe }) {
    super()
    /** @private */
    this._network = network
    /** @private */
    this._autoStart = autoStart === true
    /** @type {{ hex: string, count: number, timer: ReturnType<typeof setTimeout> | null } | null} active invite rendezvous (single topic — one at a time) */
    this._announce = null
    /** @private */
    this._restorePending = false

    // one mesh topic per channel, or a global one when channelless; strangers still sync nothing
    /** @private */
    this._topic = crypto.hash(b4a.from(network.channel || 'cero-ble'))
    /** @private */
    this._id = identity.id
    /** @private */
    this._proof = b4a.toString(identity.sign(b4a.concat([DEVICE, keyPair.publicKey])), 'hex')
    /** @type {import('ble-swarm')} */
    this.swarm = new BluetoothSwarm({
      backend,
      // this device's writer keypair, kept across launches: a person's devices each have one, so
      // they link to each other, where ble-swarm refuses a remote with its own key
      keyPair,
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
      network.inject(conn)
    })
  }

  /** @returns {'unsupported'|'unauthorized'|'off'|'waiting'|'starting'|'on'} */
  get state() {
    return this.swarm.state
  }

  /** @returns {Map<string, object>} Live BLE links, keyed by peer public key. */
  get peers() {
    return this.swarm.peers
  }

  /** @private */
  async _open() {
    if (this._autoStart) await this.start()
  }

  /** @private */
  async _close() {
    this._clearAnnounce()
    await this.swarm.destroy()
  }

  /**
   * What a peer hears when a Bluetooth link opens: whose device this is, signed, with `info`.
   *
   * @param {{ name: string | null, isMobile: boolean }} info
   */
  tell({ name, isMobile }) {
    this._network.setInfo({ id: this._id, proof: this._proof, name, isMobile })
  }

  /**
   * Who a linked device says it is: its person, who signed the key it links with, its name and
   * whether it is a phone. `null` until it said, or when that signature is not its person's.
   *
   * @param {string} hex  A key of `peers`.
   * @returns {{ id: string, name: string | null, isMobile: boolean } | null}
   */
  told(hex) {
    const info = this._network.getInfo(hex)
    if (!signed(info, b4a.from(hex, 'hex'))) return null
    const name = typeof info.name === 'string' ? info.name : null
    return {
      id: info.id,
      device: hid.encode(b4a.from(hex, 'hex')),
      name,
      isMobile: info.isMobile === true
    }
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
    let parsed
    try {
      parsed = Invite.parse(invite)
    } catch {
      return () => {}
    }

    const hex = b4a.toHex(parsed.discoveryKey)
    if (this._announce && this._announce.hex !== hex) this._stopAnnounce()
    if (!this._announce) {
      const entry = { hex, count: 0, timer: null }
      const { expires } = parsed
      if (expires > 0) {
        entry.timer = setTimeout(() => this._stopAnnounce(), Math.max(0, expires - Date.now()))
      }
      this._announce = entry
      this._restorePending = false
      this.swarm.setTopic(parsed.discoveryKey).catch(safetyCatch)
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

  /** @private */
  _stopAnnounce() {
    this._clearAnnounce()
    if (this.swarm.peers.size > 0) this._restorePending = true
    else this.swarm.setTopic(this._topic).catch(safetyCatch)
  }

  /** @private */
  _clearAnnounce() {
    const e = this._announce
    if (!e) return
    if (e.timer) clearTimeout(e.timer)
    this._announce = null
    this._restorePending = false
  }
}

function signed(info, key) {
  if (typeof info?.id !== 'string' || typeof info.proof !== 'string') return false
  try {
    return Identity.verify(
      hid.decode(info.id),
      b4a.concat([DEVICE, key]),
      b4a.from(info.proof, 'hex')
    )
  } catch {
    return false
  }
}
