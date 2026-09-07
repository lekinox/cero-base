import safetyCatch from 'safety-catch'
import b4a from 'b4a'

import { ACTIVE, PASSIVE } from '../lib/constants.js'

const rank = (mode) => (mode === ACTIVE ? 2 : mode === PASSIVE ? 1 : 0)

/**
 * Which handles swarm. Ranked by last touch: the latest `active` search and announce, the
 * next `announced` announce only, the rest leave their topic. A handle moves up at once and
 * down only after `idle` ms. A pinned handle always searches, outside the budget.
 *
 * @typedef {{ mode: 'active' | 'passive' | null, touch: () => void, off: () => void, remove: () => void }} Slot
 */
export class Presence {
  /**
   * @param {import('./index.js').Network} network
   * @param {{ active?: number, announced?: number, idle?: number }} [opts]
   */
  constructor(network, { active = 8, announced = 8, idle = 30_000 } = {}) {
    this.network = network
    this.active = active
    this.announced = announced
    this.idle = idle
    this.entries = new Map()
  }

  /**
   * Register a topic. One entry per topic, shared by every slot on it until all are removed;
   * a new entry starts untouched, at the bottom.
   *
   * @param {Uint8Array} topic
   * @param {{ pinned?: boolean }} [opts]
   * @returns {Slot}
   */
  add(topic, { pinned = false } = {}) {
    const id = b4a.toString(topic, 'hex')
    let e = this.entries.get(id)
    if (!e) {
      e = {
        topic,
        pinned,
        refs: 0,
        touched: 0,
        off: false,
        discovery: null,
        timer: null,
        pending: null
      }
      this.entries.set(id, e)
    }
    e.refs++
    this.refresh()
    const presence = this
    return {
      get mode() {
        return e.discovery ? e.discovery.mode : null
      },
      touch() {
        e.touched = Date.now()
        e.off = false
        presence.refresh()
      },
      off() {
        e.off = true
        presence.refresh()
      },
      remove() {
        if (--e.refs > 0) return
        presence.entries.delete(id)
        presence._leave(e)
      }
    }
  }

  /**
   * @param {Uint8Array} topic
   * @returns {'active' | 'passive' | null}
   */
  mode(topic) {
    const e = this.entries.get(b4a.toString(topic, 'hex'))
    return e?.discovery ? e.discovery.mode : null
  }

  refresh() {
    if (this.network.closing || this.network.closed) return
    const ranked = []
    for (const e of this.entries.values()) {
      if (e.pinned) this._want(e, ACTIVE)
      else if (e.off) this._want(e, null)
      else ranked.push(e)
    }
    ranked.sort((a, b) => b.touched - a.touched)
    ranked.forEach((e, i) => {
      this._want(e, i < this.active ? ACTIVE : i < this.active + this.announced ? PASSIVE : null)
    })
  }

  close() {
    for (const e of this.entries.values()) clearTimeout(e.timer)
    this.entries.clear()
  }

  // up at once, down after idle: a room at the edge of the budget must not churn the DHT
  _want(e, mode) {
    const current = e.discovery ? e.discovery.mode : null
    if (rank(mode) < rank(current)) {
      e.pending = mode
      if (!e.timer) e.timer = setTimeout(() => this._settle(e), this.idle)
      return
    }
    clearTimeout(e.timer)
    e.timer = null
    if (mode === current) return
    if (!e.discovery) e.discovery = this.network.join(e.topic, { mode })
    else e.discovery.activate().catch(safetyCatch)
  }

  _settle(e) {
    e.timer = null
    if (e.pending === PASSIVE) e.discovery.deactivate().catch(safetyCatch)
    else this._leave(e)
  }

  _leave(e) {
    clearTimeout(e.timer)
    e.timer = null
    e.discovery?.destroy().catch(safetyCatch)
    e.discovery = null
  }
}
