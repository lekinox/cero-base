import safetyCatch from 'safety-catch'

import { CeroError } from '../lib/errors.js'

let last = 0
// strictly increasing: topics at the same rank swap slots every rotation, the active one always ranks lower
export function stamp() {
  return (last = Math.max(Date.now(), last + 1))
}

/**
 * @typedef {object} Session  The replicator session a topic has, as far as this file uses it.
 * @property {Uint8Array} topic
 * @property {'inactive' | 'pinned' | 'autostarted' | 'discovering' | 'destroyed'} state
 * @property {boolean} active
 * @property {number} priority
 * @property {() => void} pin
 * @property {() => void} unpin
 * @property {() => Promise<void>} flush
 * @property {() => Promise<void>} destroy
 * @property {{ refresh(): void } | null} discovery
 */

/**
 * Handle for one topic membership on a {@link Network}: a view on the replicator session the
 * topic has, shared by every join of it. Pinned, it announces and looks up until released; in
 * the rotation, it announces while it holds a slot, ranked by its last touch.
 */
export class Discovery {
  /**
   * @param {import('./index.js').Network} network  Owning network.
   * @param {import('./index.js').Entry} entry  The topic's session, shared by every join of it.
   */
  constructor(network, entry) {
    this.network = network
    /** @private */
    this.entry = entry
    /** @private */
    this._destroyed = false
  }

  /** @returns {Session | null} The replicator session, null while the topic's last one is still leaving. */
  get session() {
    return this.entry.session
  }

  /** @returns {'inactive' | 'pinned' | 'autostarted' | 'discovering' | 'destroyed'} */
  get state() {
    return this.session?.state ?? 'inactive'
  }

  /** @returns {boolean} Whether the topic announces or looks up right now. */
  get active() {
    return this.session?.active ?? false
  }

  /** @returns {boolean} */
  get destroyed() {
    return this._destroyed
  }

  /**
   * Pin the topic and look up now: it announces and looks up until `deactivate()`, outside the
   * rotation's budget.
   *
   * @returns {Promise<void>}
   */
  async activate() {
    if (this._destroyed) throw CeroError.DESTROYED('Discovery')
    this.entry.pin = true
    this.session?.pin()
    // on a pinned session this forces a fresh query without unpinning
    this.session?.discover()
    await this._refresh()
  }

  /**
   * Unpin the topic: the rotation decides, by its last touch.
   *
   * @returns {Promise<void>}
   */
  async deactivate() {
    if (this._destroyed) throw CeroError.DESTROYED('Discovery')
    this.entry.pin = false
    this.session?.unpin()
    await this._refresh()
  }

  /** Rank the topic first in the rotation, as just used. */
  touch() {
    this._rank(stamp())
  }

  /** Rank the topic last: it keeps a slot only while one is spare. */
  release() {
    this._rank(0)
  }

  /** @private */
  _rank(priority) {
    this.entry.priority = priority
    if (this.session) this.session.priority = priority
    if (!this.active) this.network._refresh()
  }

  /**
   * Wait for the current announce or lookup to settle.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    await this.entry.closing
    if (this._destroyed) return
    // a refresh first: a join queues its announce only when the rotation runs
    await this._refresh()
    await this.session?.flush()
  }

  // another topic leaving mid-refresh rejects it; this one's state was still applied
  /** @private */
  async _refresh() {
    await this.network.replicator.refresh().catch(safetyCatch)
  }

  /**
   * Leave the topic, once every join of it has. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._destroyed) return
    this._destroyed = true
    await this.network._leave(this)
  }
}
