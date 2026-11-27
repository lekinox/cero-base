import { CeroError } from '../lib/errors.js'

let last = 0
// strictly increasing: topics at the same rank swap slots every rotation, the active one always ranks lower
function stamp() {
  return (last = Math.max(Date.now(), last + 1))
}

/**
 * @typedef {object} Session  The hyperjoin session a topic has, as far as cero uses it.
 * @property {'inactive' | 'pinned' | 'autostarted' | 'discovering' | 'destroyed'} state
 * @property {boolean} active
 * @property {number} priority
 * @property {Promise<void> | null} closing
 * @property {{ refresh(): void } | null} discovery
 * @property {() => void} pin
 * @property {() => void} unpin
 * @property {() => void} discover
 * @property {() => Promise<void>} flush
 * @property {() => Promise<void>} destroy
 * @property {(event: string, listener: (session: Session) => void) => void} on
 */

/**
 * Handle for one topic membership on a {@link Network}: a view on the session the topic has,
 * shared by every join of it. Pinned, it announces and looks up until released; in the
 * rotation, it announces while it holds a slot, ranked by its last touch.
 */
export class Discovery {
  /**
   * @param {import('./index.js').Network} network  Owning network.
   * @param {import('./index.js').Entry} entry  The topic's session, shared by every join of it.
   * @param {boolean} pin
   */
  constructor(network, entry, pin) {
    this.network = network
    /** @private */
    this.entry = entry
    /** @private */
    this._pinned = false
    /** @private */
    this._destroyed = false
    this._pin(pin)
    // an open ranks it first, and takes no slot from a topic in use
    this._rank(stamp())
  }

  /** @returns {Session} */
  get session() {
    return this.entry.session
  }

  /** @returns {'inactive' | 'pinned' | 'autostarted' | 'discovering' | 'destroyed'} */
  get state() {
    return this.session.state
  }

  /** @returns {boolean} Whether the topic announces or looks up right now. */
  get active() {
    return this.session.active
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
    this._pin(true)
    // on a pinned session this asks for a fresh query
    this.session.discover()
    await this.network._rotate()
  }

  /**
   * Unpin the topic: the rotation decides, by its last touch.
   *
   * @returns {Promise<void>}
   */
  async deactivate() {
    if (this._destroyed) throw CeroError.DESTROYED('Discovery')
    this._pin(false)
    await this.network._rotate()
  }

  /** The topic was just used: it ranks first, and announces from now until `idle` ms after its last use, slot or not. */
  touch() {
    this._rank(stamp())
    this.network._use(this.entry)
  }

  /** Rank the topic last: it keeps a slot only while one is spare. */
  release() {
    this._rank(0)
  }

  /**
   * Wait for the current announce or lookup to settle.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this._destroyed) return
    await this.network._settle(this.session)
  }

  /**
   * Leave the topic, once every join of it has. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._pin(false)
    await this.network._leave(this)
  }

  // the session stays pinned while any join of the topic pins it
  /** @private */
  _pin(pinned) {
    if (pinned === this._pinned) return
    this._pinned = pinned
    this.entry.pins += pinned ? 1 : -1
    this.network._apply(this.entry)
  }

  /** @private */
  _rank(priority) {
    this.session.priority = priority
    if (!this.active) this.network._refresh()
  }
}
