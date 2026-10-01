import ReadyResource from 'ready-resource'
import BluetoothSwarm from 'ble-swarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'

import { Identity } from '@cero-base/core/identity'
import { CeroError } from '@cero-base/core/errors'

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
   * @param {boolean} [opts.on]  The radio at open; off unless `true`. Nothing is stored.
   * @param {string} [opts.topic]  The default topic; without one, the channel's own.
   * @param {number} [opts.maxOutbound]  Max concurrent outbound links; gossip covers the rest.
   * @param {number} [opts.maxInbound]   Max concurrent inbound sessions; newcomers past this are refused.
   * @param {'l2cap' | 'gatt'} [opts.pipe]  Data pipe — 'l2cap' (default, faster) or 'gatt'. Both peers must match.
   */
  constructor(network, opts) {
    const { identity, keyPair, backend, on = false, topic, maxOutbound, maxInbound, pipe } = opts
    if (typeof on !== 'boolean') throw CeroError.INVALID('on is true or false')
    checkTopic(topic)
    super()
    /** @private */
    this._on = on
    // what this device tells its links, signed, and what each link told, by its key
    /** @private */
    this._info = null
    /** @private */
    this._heard = new Map()
    /** @private */
    this._senders = new Set()
    // the link each peer's info came over: a newer one replaces it, and only the current one forgets
    /** @private */
    this._links = new Map()
    // the channel's own topic, or a global one when channelless; strangers still sync nothing
    /** @private */
    this._base = crypto.hash(b4a.from(network.channel || 'cero-ble'))
    /** @private */
    this._topic = topicOf(this._base, topic)
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
    this.swarm.on('update', () => this.emit('update'))
    this.swarm.on('connection', (conn) => this._attach(network.inject(conn)))
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
    if (this._on) await this.start()
  }

  /**
   * Turn the radio on or off, on `opts.topic` or else the default topic. A new topic drops the
   * links on the old one.
   *
   * @param {boolean} on
   * @param {{ topic?: string }} [opts]
   * @returns {Promise<void>}
   */
  async set(on, opts = {}) {
    if (typeof on !== 'boolean') {
      throw CeroError.INVALID('nearby takes true or false, then { topic }')
    }
    if (!opts || typeof opts !== 'object' || Object.keys(opts).some((k) => k !== 'topic')) {
      throw CeroError.INVALID('nearby takes { topic } after true or false')
    }
    checkTopic(opts.topic)
    const topic = opts.topic === undefined ? this._topic : topicOf(this._base, opts.topic)
    if (!on) await this.stop()
    await this.swarm.setTopic(topic)
    if (on) await this.start()
  }

  /** @private */
  async _close() {
    await this.swarm.destroy()
  }

  /**
   * What a peer hears when a Bluetooth link opens: whose device this is, signed, with `info`.
   *
   * @param {{ name: string | null, isMobile: boolean }} info
   */
  tell({ name, isMobile }) {
    this._say({ id: this._id, proof: this._proof, name, isMobile })
  }

  /** @private */
  _say(info) {
    this._info = info
    for (const send of this._senders) send()
  }

  /**
   * Who a linked device says it is: its person, who signed the key it links with, its name and
   * whether it is a phone. `null` until it said, or when that signature is not its person's.
   *
   * @param {string} hex  A key of `peers`.
   * @returns {{ id: string, name: string | null, isMobile: boolean } | null}
   */
  told(hex) {
    const info = this._heard.get(hex)
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
   * Stop advertising/scanning and drop links.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    await this.swarm.stop()
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

  // silent until needed: bytes on a link at open trip hyperswarm's duplicate guard
  /** @private */
  _attach(conn) {
    const mux = Protomux.from(conn)
    const hex = b4a.toHex(conn.remotePublicKey)
    let message = null
    const send = () => {
      if (!message) {
        const channel = mux.createChannel({ protocol: 'cero/info' })
        if (channel === null) return
        message = channel.addMessage({
          encoding: c.json,
          onmessage: (info) => {
            if (!info || typeof info !== 'object') return
            this._heard.set(hex, info)
            this.emit('update')
          }
        })
        channel.open()
      }
      if (this._info) message.send(this._info)
    }
    mux.pair({ protocol: 'cero/info' }, send)
    this._senders.add(send)
    this._links.set(hex, conn)
    conn.on('close', () => {
      this._senders.delete(send)
      if (this._links.get(hex) !== conn) return
      this._links.delete(hex)
      if (this._heard.delete(hex)) this.emit('update')
    })
    if (this._info) send()
  }
}

function checkTopic(topic) {
  if (topic !== undefined && (typeof topic !== 'string' || !topic)) {
    throw CeroError.INVALID('topic is a non-empty string')
  }
}

// the channel bounds every topic: the same topic on another channel is another topic
function topicOf(base, topic) {
  return topic === undefined ? base : crypto.hash([base, b4a.from(topic)])
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
