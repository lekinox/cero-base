import safetyCatch from 'safety-catch'

import { ACTIVE, PASSIVE } from '../lib/constants.js'
import { CeroError } from '../lib/errors.js'

/**
 * Handle for a single topic membership on a {@link Network}. Wraps a hyperswarm
 * PeerDiscovery session and lets it switch between active/passive announce/lookup.
 */
export class Discovery {
  /**
   * @param {import('./index.js').Network} network  Owning network.
   * @param {any} session  Hyperswarm PeerDiscovery session from `swarm.join()`.
   * @param {'active' | 'passive'} mode
   */
  constructor(network, session, mode) {
    this.network = network
    this.session = session
    this._mode = mode
    this._destroyed = false
  }

  /** @returns {'active' | 'passive'} */
  get mode() {
    return this._mode
  }

  /** @returns {boolean} */
  get destroyed() {
    return this._destroyed
  }

  /**
   * Switch to active (client+server) announce/lookup.
   *
   * @returns {Promise<void>}
   */
  async activate() {
    if (this._destroyed) throw CeroError.DESTROYED('Discovery')
    this._mode = ACTIVE
    await this.session.refresh({ client: true, server: true })
  }

  /**
   * Switch to passive announce.
   *
   * @returns {Promise<void>}
   */
  async deactivate() {
    if (this._destroyed) throw CeroError.DESTROYED('Discovery')
    this._mode = PASSIVE
    await this.session.refresh({ client: false, server: true })
  }

  /**
   * Wait for the current announce/lookup to settle.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this._destroyed) return
    await this.session.flushed()
  }

  /**
   * Leave the topic and tear down the session. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this.network._discoveries.delete(this)
    try {
      await this.session.destroy()
    } catch (err) {
      safetyCatch(err)
    }
  }
}
