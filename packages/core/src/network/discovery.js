import safetyCatch from 'safety-catch'

import { ACTIVE, PASSIVE } from '../lib/constants.js'
import { CeroError } from '../lib/errors.js'

/**
 * Handle for a single topic membership on a {@link Network}. Wraps a hyperswarm
 * PeerDiscovery session and lets it switch between active/passive announce/lookup.
 */
/**
 * @typedef {{ refresh(opts?: object): Promise<void>, flushed(): Promise<boolean>, destroy(): Promise<void> }} Session
 *   The hyperswarm session `swarm.join()` returns, as far as this file uses it.
 */

export class Discovery {
  /**
   * @param {import('./index.js').Network} network  Owning network.
   * @param {Session} session  Hyperswarm PeerDiscovery session from `swarm.join()`.
   * @param {'active' | 'passive'} mode
   */
  constructor(network, session, mode) {
    this.network = network
    /** @type {Session} */
    this.session = session
    /** @private */
    this._mode = mode
    /** @private */
    this._destroyed = false
    /** @private */
    this._timer = null
    // a passive join only announces: the active peer's second lookup finds it
    if (mode === ACTIVE) this._requery().catch(safetyCatch)
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

  // peers joining at once look up before either announce lands; hyperswarm looks again in 10 min
  /** @private */
  async _requery() {
    await this.session.flushed()
    if (this._destroyed) return
    this._timer = setTimeout(
      () => this.session.refresh().catch(safetyCatch),
      1000 + Math.random() * 2000
    )
    this._timer.unref()
  }

  /**
   * Leave the topic and tear down the session. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._destroyed) return
    this._destroyed = true
    clearTimeout(this._timer)
    this.network._discoveries.delete(this)
    try {
      await this.session.destroy()
    } catch (err) {
      safetyCatch(err)
    }
  }
}
