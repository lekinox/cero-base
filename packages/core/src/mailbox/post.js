import ReadyResource from 'ready-resource'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

/**
 * One sealed message on its way to an address: written to a fresh core, announced to peers
 * receiving at the address, and deposited on `mirrors` for an owner who is offline.
 * `delivered` resolves on the first read, by the owner or by a mirror holding it for them.
 * Given a `core` instead, it announces that core as it is.
 */
export class Post extends ReadyResource {
  /**
   * @param {import('../network/index.js').Network} network
   * @param {Uint8Array} address
   * @param {Uint8Array | null} message
   * @param {{ mirrors?: Uint8Array[], core?: import('hypercore') }} [opts]
   */
  constructor(network, address, message, { mirrors = [], core = null } = {}) {
    super()
    this.network = network
    this.address = address
    this.message = message
    this.mirrors = mirrors
    /** @type {Promise<void>} */
    this.delivered = new Promise((resolve) => {
      /** @private */
      this._ondelivered = resolve
    })
    /** @private */
    this._core = core
    /** @private */
    this._session = null
    /** @private */
    this._discovery = null
  }

  /** @private */
  async _open() {
    const { network, address } = this
    const core = this._core || network.store.get({ name: b4a.toHex(crypto.randomBytes(32)) })
    this._core = core
    await core.ready()
    core.once('upload', () => this._ondelivered())
    if (this.message) await core.append(crypto.encrypt(this.message, address))

    const wakeup = [{ key: core.key, length: core.length }]
    const session = network.wakeup.session(address, {
      discoveryKey: crypto.discoveryKey(address),
      onpeeractive: (peer) => session.announce(peer, wakeup)
    })
    this._session = session
    // a topic this network already joined has active peers that will not fire onpeeractive again
    for (const peer of session.peers) if (peer.active) session.announce(peer, wakeup)
    this._discovery = network.join(crypto.discoveryKey(address))
    if (this.mirrors.length) {
      const opts = { keys: this.mirrors, pick: this.mirrors.length, referrer: address }
      network.peering().addCoreBackground(core, opts)
    }
  }

  /** @private */
  async _close() {
    this._session?.destroy()
    await this._discovery?.destroy()
    await this._core?.close()
  }
}
