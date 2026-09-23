import AbortController from 'bare-abort-controller'
import b4a from 'b4a'
import c from 'compact-encoding'
import safetyCatch from 'safety-catch'

import { Pairing } from '@cero-base/core/pairing'
import { Identity } from '@cero-base/core/identity'
import { CeroError } from '@cero-base/core/errors'
import { epochEntries } from '@cero-base/core/database/encryption'

/**
 * One handle being joined. It knocks with the latest invite and waits as long as it takes: the
 * caller's timeout only ends the caller's wait. What it learns is saved as it goes, the writer
 * before the first knock and the keys once the reply lands, so a join resumed after a restart
 * picks up where it stopped. It ends admitted, denied, expired or cancelled; a close only pauses
 * it. How it ends reaches the caller, or `onerror` once nobody waits.
 */
export class Join {
  /**
   * @param {import('./index.js').Handle} root
   * @param {{ type: string, discoveryKey: Uint8Array, routes?: Record<string, Function>, onend: () => void }} opts
   */
  constructor(root, { type, discoveryKey, routes, onend }) {
    this.root = root
    this.type = type
    this.id = b4a.toHex(discoveryKey)
    this.routes = routes
    this.invite = null
    this.waiting = 0
    this.cancelled = false
    this._knocking = null // aborts the knock in flight
    this._row = null
    this.done = new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject
    })
    this.done.catch(safetyCatch)
    this._onend = onend
  }

  /**
   * Knock with `invite`, taking over from an older knock: the writer stays, so a reply to the
   * older one still lands.
   *
   * @param {string} invite
   */
  async knock(invite) {
    this.invite = invite
    this._knocking?.abort()
    const knocking = new AbortController()
    this._knocking = knocking
    const nearby = this.root.bluetooth?.announce(invite)
    try {
      const row = await this._save({ invite })
      const writer = { publicKey: row.publicKey, secretKey: row.secretKey }
      const { mailbox, identity } = this.root
      const opts = { identity, writer, timeout: 0, signal: knocking.signal }
      const reply = row.key
        ? unpack(row)
        : await this._keep(await Pairing.join(mailbox, invite, opts))
      this._end(this._resolve, await this.root._enter(this.type, reply, this.routes))
      await this._forget()
    } catch (err) {
      if (knocking !== this._knocking) return
      // a close pauses the join, anything else ends it
      if (err.code !== 'CLOSED' || this.cancelled) await this._forget()
      if (err.code !== 'CLOSED' && !this.waiting) this.root._onerror(err)
      this._end(this._reject, err)
    } finally {
      nearby?.()
    }
  }

  close() {
    this._knocking?.abort()
  }

  // ends it for good: the knock forgets its row as it unwinds, so no restart resumes it
  async cancel() {
    this.cancelled = true
    this._knocking?.abort()
    await this.done.catch(safetyCatch)
  }

  // the first save fixes the writer, later ones add what was learned
  async _save(fields) {
    const store = this.root.local?.store
    this._row ??= (store && (await store.get('joins', this.id)).data) || Identity.randomKeyPair()
    this._row = { ...this._row, id: this.id, type: this.type, ...fields }
    await store?.put('joins', this._row)
    return this._row
  }

  // the reply, kept so a restart opens the handle without knocking again
  async _keep(reply) {
    const { key, encryptionKey, epochs } = reply
    await this._save({ key, encryptionKey, epochs: c.encode(epochEntries, epochs) })
    return reply
  }

  async _forget() {
    await this.root.local?.store.del('joins', this.id).catch(safetyCatch)
  }

  _end(settle, value) {
    this._onend()
    settle(value)
  }
}

/**
 * Wait for a join, but stop waiting after `ms`; the join itself goes on.
 *
 * @param {Promise<any>} done
 * @param {number} ms  `0` waits as long as the join takes.
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
