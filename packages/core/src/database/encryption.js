import Autobee from 'autobee'
import autobeeEncryption from 'autobee-encryption'
import crypto from 'hypercore-crypto'
import c from 'compact-encoding'
import b4a from 'b4a'

import { CeroError } from '../lib/errors.js'

const { AutobeeEncryption, WriterEncryption } = autobeeEncryption

// the same derivation constant autobee-encryption uses
const NS_HASH_KEY = crypto.namespace('autobase', 4)[2]

const NS_BLOBS = crypto.namespace('cero/blobs', 1)[0]

/**
 * Encryption key for a rotation epoch's blob cores.
 *
 * @param {Uint8Array} entropy
 * @returns {Uint8Array}
 */
export function blobEpochKey(entropy) {
  return crypto.hash([NS_BLOBS, entropy])
}

// autobee news WriterEncryption directly, so epoch awareness is patched onto the
// autobee-encryption prototype. Epoch 0 keeps the upstream derivation, epoch n derives
// from the keyring; without a keyring behaviour is identical to upstream
const baseGetKeys = AutobeeEncryption.prototype.getKeys

AutobeeEncryption.prototype.getKeys = async function (id, ctx) {
  if (!id) return baseGetKeys.call(this, id, ctx)

  const keyring = this.auto?.keyring
  const entropy = keyring && keyring.entropy(id)
  if (!entropy) {
    // a writer autobee freezes over this throw and only wakeup() re-adds it
    if (ctx?.key && this.auto?._epochStalled) {
      this.auto._epochStalled.add(b4a.toString(ctx.key, 'hex'))
      this.auto._scheduleEpochRetry()
    }
    throw CeroError.UNKNOWN_EPOCH(id)
  }

  const block = this.blockKey(entropy, ctx)
  return { id, block, hash: crypto.hash([NS_HASH_KEY, block]) }
}

/** Prime a keyring from a local core's persisted epoch stash. */
export async function loadEpochs(keyring, local) {
  const saved = await local.getUserData('cero/epochs').catch(() => null)
  if (!saved) return
  try {
    for (const e of c.decode(epochEntries, saved)) keyring.add(e.stamp, e.entropy, e.epoch)
  } catch {
    // corrupt userData — epochs re-hydrate from announcements
  }
}

AutobeeEncryption.prototype.update = async function (ctx) {
  const current = this.auto?.keyring ? this.auto.keyring.current : 0
  if (!this.keys || this.keys.id !== current) this.keys = await this.get(current, ctx)
}

/**
 * Wire codec for a rotation announcement's envelope list — one sealed box
 * per remaining member, addressed by member id.
 */
export const wraps = c.array({
  preencode(state, w) {
    c.string.preencode(state, w.id)
    c.buffer.preencode(state, w.box)
  },
  encode(state, w) {
    c.string.encode(state, w.id)
    c.buffer.encode(state, w.box)
  },
  decode(state) {
    return { id: c.string.decode(state), box: c.buffer.decode(state) }
  }
})

/**
 * Wire codec for locally persisted / pairing-delivered epoch secrets.
 */
export const epochEntries = c.array({
  preencode(state, e) {
    c.uint.preencode(state, e.epoch)
    c.uint.preencode(state, e.stamp)
    c.fixed32.preencode(state, e.entropy)
  },
  encode(state, e) {
    c.uint.encode(state, e.epoch)
    c.uint.encode(state, e.stamp)
    c.fixed32.encode(state, e.entropy)
  },
  decode(state) {
    return {
      epoch: c.uint.decode(state),
      stamp: c.uint.decode(state),
      entropy: c.fixed32.decode(state)
    }
  }
})

/**
 * Per-database registry of rotation epochs.
 */
export class Keyring {
  constructor() {
    /** @type {Map<number, Uint8Array>} stamp → entropy */
    this.entropies = new Map()
    /** @type {Map<number, number>} stamp → apply-order sequence */
    this.seqs = new Map()
    /** stamp used for new blocks — the adopted epoch with the highest seq */
    this.current = 0
    /** highest adopted apply-order sequence (0 = base era) */
    this.seq = 0
    /** bumped on every add/remove — cheap change detection for retries */
    this.version = 0
  }

  /** @returns {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} ascending by seq */
  all() {
    return [...this.entropies]
      .map(([stamp, entropy]) => ({ epoch: this.seqs.get(stamp) || 0, stamp, entropy }))
      .sort((a, b) => a.epoch - b.epoch)
  }

  /**
   * @param {number} stamp
   * @param {Uint8Array} entropy
   * @param {number} [seq]  Apply-order sequence; drives `current` selection.
   */
  add(stamp, entropy, seq = 0) {
    if (!Number.isInteger(stamp) || stamp <= 0 || stamp > 0xffffffff) {
      throw CeroError.INVALID(`epoch stamp: ${stamp}`)
    }
    if (!b4a.isBuffer(entropy) || entropy.byteLength !== 32) {
      throw CeroError.INVALID('epoch entropy must be 32 bytes')
    }
    this.entropies.set(stamp, entropy)
    if (seq) this.seqs.set(stamp, seq)
    const effective = this.seqs.get(stamp) || 0
    if (this.current === 0 || (effective > 0 && effective >= this.seq)) {
      this.seq = effective
      this.current = stamp
    }
    this.version++
  }

  /**
   * @param {number} stamp
   * @returns {Uint8Array | null}
   */
  entropy(stamp) {
    return this.entropies.get(stamp) || null
  }

  /**
   * Forget an epoch (used to undo an add whose persistence failed).
   *
   * @param {number} stamp
   */
  remove(stamp) {
    this.entropies.delete(stamp)
    this.seqs.delete(stamp)
    this.current = 0
    this.seq = 0
    for (const [s, q] of this.seqs) {
      if (q >= this.seq) {
        this.seq = q
        this.current = s
      }
    }
    this.version++
  }
}

/**
 * The epoch-aware provider — the class itself is upstream WriterEncryption; the epoch
 * behavior lives on the (patched) base prototype above.
 */
export class EpochEncryption extends WriterEncryption {}

/**
 * Autobee with a rotation keyring. Every provider autobee constructs (view/system factory,
 * foreign cores, ActiveWriters) picks the epochs up through the patched base class and
 * this `keyring` property.
 */
export class EpochAutobee extends Autobee {
  constructor(store, key, handlers = {}) {
    super(store, key, handlers)
    this.keyring = handlers.keyring || null
    this._epochStalled = new Set()
    this._epochRetry = null
    this._epochRetryDelay = 1000
    this._epochRetrySeen = 0
  }

  async _close() {
    if (this._epochRetry) clearTimeout(this._epochRetry)
    this._epochRetry = null
    return super._close()
  }

  // an UNKNOWN_EPOCH from the drain parks the pass; the retry wakes the stalled cores once the
  // announcement lands. Forward the arguments: the local drain passes { local: true }
  async _bumpPendingWriters(...args) {
    try {
      return await super._bumpPendingWriters(...args)
    } catch (err) {
      if (err?.code !== 'UNKNOWN_EPOCH') throw err
      this._scheduleEpochRetry()
      return false
    }
  }

  // hints read the system bee outside the guarded drain; park and retry like everything else
  async _applyWakeupHints() {
    try {
      return await super._applyWakeupHints()
    } catch (err) {
      if (err?.code !== 'UNKNOWN_EPOCH') throw err
      this._scheduleEpochRetry()
      return []
    }
  }

  // a stalled core produces no wake-up of its own, only wakeup() re-adds it; exponential backoff
  _scheduleEpochRetry() {
    if (this._epochRetry || this.closing) return
    const version = this.keyring ? this.keyring.version : 0
    if (version !== this._epochRetrySeen) {
      this._epochRetrySeen = version
      this._epochRetryDelay = 1000
    }
    this._epochRetry = setTimeout(() => {
      this._epochRetry = null
      if (this.closing) return
      for (const hex of this._epochStalled) {
        this.wakeup({ key: b4a.from(hex, 'hex'), length: 0 }).catch(noop)
      }
      this._epochStalled.clear()
      this.update().catch(noop)
    }, this._epochRetryDelay)
    this._epochRetryDelay = Math.min(this._epochRetryDelay * 2, 60000)
  }
}

function noop() {}
