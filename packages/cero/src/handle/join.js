import AbortController from 'bare-abort-controller'
import b4a from 'b4a'
import c from 'compact-encoding'
import safetyCatch from 'safety-catch'

import { Pairing } from '@cero-base/core/pairing'
import { Identity } from '@cero-base/core/identity'
import { CeroError } from '@cero-base/core/errors'
import { epochEntries } from '@cero-base/core/database/encryption'

/**
 * One handle being joined. It joins with the latest invite and waits as long as it takes: the
 * caller's timeout only ends the caller's wait. What it learns is saved as it goes, the writer
 * before the join is written and the keys once the reply lands, so a join resumed after a restart
 * picks up where it stopped. It ends admitted, denied, expired or cancelled; a close only pauses
 * it. How it ends reaches the caller, or `onerror` once nobody waits.
 */
export class Join {
  /**
   * @param {import('./index.js').Handle} root
   * @param {{ type: string, spec: object, discoveryKey: Uint8Array, onend: () => void }} opts
   */
  constructor(root, { type, spec, discoveryKey, onend }) {
    this.root = root
    this.type = type
    this.spec = spec
    this.id = b4a.toHex(discoveryKey)
    this.invite = null
    this.waiting = 0
    this.cancelled = false
    /** @private */
    this._running = null // aborts the attempt in flight
    /** @private */
    this._row = null
    /** @type {Promise<import('./index.js').Handle>} */
    this.done = new Promise((resolve, reject) => {
      /** @private */
      this._resolve = resolve
      /** @private */
      this._reject = reject
    })
    this.done.catch(safetyCatch)
    /** @private */
    this._onend = onend
  }

  /**
   * Join with `invite`, taking over from an older attempt: the writer stays, so a reply to the
   * older one still lands.
   *
   * @param {string} invite
   */
  async start(invite) {
    this.invite = invite
    this._running?.abort()
    const running = new AbortController()
    this._running = running
    const nearby = this.root._bluetooth?.announce(invite)
    try {
      const row = await this._save({ invite })
      const writer = { publicKey: row.publicKey, secretKey: row.secretKey }
      const { mailbox, identity } = this.root
      const opts = { identity, spec: this.spec, writer, timeout: 0, signal: running.signal }
      const reply = row.key
        ? unpack(row)
        : await this._keep(await Pairing.join(mailbox, invite, opts))
      this._end(this._resolve, await this.root._enter(this.type, reply))
      await this._forget()
    } catch (err) {
      if (running !== this._running) return
      // a close pauses the join, anything else ends it
      if (err.code !== 'CLOSED' || this.cancelled) await this._forget()
      if (err.code !== 'CLOSED' && !this.waiting) this.root._onerror(err)
      this._end(this._reject, err)
    } finally {
      nearby?.()
    }
  }

  close() {
    this._running?.abort()
  }

  // ends it for good: the attempt forgets its row as it unwinds, so no restart resumes it
  async cancel() {
    this.cancelled = true
    this._running?.abort()
    await this.done.catch(safetyCatch)
  }

  // the first save fixes the writer, later ones add what was learned
  /** @private */
  async _save(fields) {
    const store = this.root.local?.store
    this._row ??= (store && (await store.get('joins', this.id)).data) || Identity.randomKeyPair()
    this._row = { ...this._row, id: this.id, type: this.type, ...fields }
    await store?.put('joins', this._row)
    return this._row
  }

  // the reply, kept so a restart opens the handle without joining again
  /** @private */
  async _keep(reply) {
    const { key, encryptionKey, epochs } = reply
    await this._save({ key, encryptionKey, epochs: c.encode(epochEntries, epochs) })
    return reply
  }

  /** @private */
  async _forget() {
    await this.root.local?.store.del('joins', this.id).catch(safetyCatch)
  }

  /** @private */
  _end(settle, value) {
    this._onend()
    settle(value)
  }
}

/**
 * Wait for a join, but stop waiting after `ms`; the join itself goes on.
 *
 * @param {Promise<import('./index.js').Handle>} done
 * @param {number} ms  `0` waits as long as the join takes.
 * @returns {Promise<import('./index.js').Handle>}
 */
export async function wait(done, ms) {
  if (!ms) return done
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(CeroError.TIMEOUT('join')), ms)
  })
  try {
    return await Promise.race([done, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function unpack({ key, encryptionKey, epochs, publicKey, secretKey }) {
  const writer = { publicKey, secretKey }
  return { key, encryptionKey, epochs: epochs ? c.decode(epochEntries, epochs) : [], writer }
}
