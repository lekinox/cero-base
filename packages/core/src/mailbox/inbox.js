import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { CeroError } from '../lib/errors.js'

const NS = b4a.from('cero/mailbox')
const READ_TIMEOUT = 30000
// a read holds its slot until its message was handled, READ_TIMEOUT at most to open it and as
// long again to handle it: a peer announcing keys nobody serves holds PER_PEER of the READS at
// most, however often it reconnects, and the peers take their turns, so mail from the others
// reads in the slots left
const READS = 16
const PER_PEER = 4
// a connection's keys waiting: what a mirror announces of one address at once. Past it the peer
// is asked to announce again once its queue is empty
const QUEUED = 32
// a handled id is remembered this long, so a mirror announcing it again hands nothing over.
// Nothing bounds how long a mirror holds a core: one it announces after this is handed over again
const HANDLED_FOR = 30 * 24 * 60 * 60 * 1000
// a ceiling far above use, past which the oldest handled id goes
const HANDLED = 65536
// no row this code wrote is older: a `handled` before it, or ahead of now, is no time
const EPOCH = Date.UTC(2026, 0)
const EMPTY = b4a.alloc(0)

/**
 * The keypair behind the address a secret owns.
 *
 * @param {Uint8Array} secret
 * @returns {{ publicKey: Uint8Array, secretKey: Uint8Array }}
 */
export function keyPair(secret) {
  return crypto.encryptionKeyPair(crypto.hash([NS, secret]))
}

/**
 * A handled row old enough to forget; one whose `handled` is no time is not.
 *
 * @param {import('./index.js').Mail} mail
 * @returns {boolean}
 */
export function aged({ handled }) {
  return isTime(handled) && Date.now() - handled >= HANDLED_FOR
}

/**
 * Erase the core a message travelled in. Corestore leaves a core that still has a session open,
 * and that is an error here, not silence.
 *
 * @param {import('corestore')} store
 * @param {Uint8Array} key
 * @returns {Promise<void>}
 */
export async function erase(store, key) {
  const [gone] = await store.purge(key)
  if (!gone) throw CeroError.CONFLICT(`mailbox: ${b4a.toHex(key)} is still open, not erased`)
}

/**
 * Receives at the address a secret owns, direct from the sender or from a mirror. A message
 * that does not open in time, or that `onmessage` resolves `false` on, is dropped; one that opens
 * is kept in `box` until `onmessage` resolves, as a row naming its core, never the message, and
 * its id stays there for HANDLED_FOR once handled.
 * A core the inbox fetched is erased once dropped, or once handled with `keep` false; one this
 * device held already is left alone.
 */
export class Inbox extends ReadyResource {
  /**
   * @param {import('../network/index.js').Network} network
   * @param {Uint8Array} secret
   * @param {{ box: import('./index.js').Box, onmessage: (message: Uint8Array) => unknown, onerror: (err: Error) => void, keep?: boolean }} opts
   */
  constructor(network, secret, { box, onmessage, onerror, keep = true }) {
    super()
    this.network = network
    this.keyPair = keyPair(secret)
    this.address = this.keyPair.publicKey
    this.box = box
    this.onmessage = onmessage
    this.onerror = onerror
    this.keep = keep
    /** @private */
    this._mail = new Map() // id → { key, queued, busy }: queued by peers, or read or handled now
    /** @private */
    this._turns = new Map() // peer → the ids it announced, waiting, in turn order
    /** @private */
    this._load = new Map() // remote key → its reads in flight
    /** @private */
    this._behind = new Set() // peers that announced more than QUEUED
    /** @private */
    this._reading = 0
    /** @private */
    this._handled = new Map() // id → when it was handled, oldest first
    /** @private */
    this._session = null
    /** @private */
    this._discovery = null
    /** @private */
    this._forgotten = false
  }

  /**
   * Close, and delete all the box keeps for this address: for one nothing is received at again.
   *
   * @returns {Promise<void>}
   */
  async forget() {
    this._forgotten = true
    await this.close()
    for (const mail of await this.box.list()) {
      if (b4a.equals(mail.address, this.address)) await this.box.del(mail.id)
    }
  }

  /** @private */
  async _open() {
    const handled = []
    for (const mail of await this.box.list()) {
      if (!b4a.equals(mail.address, this.address)) continue
      if (mail.handled) {
        if (!isTime(mail.handled)) {
          mail.handled = Date.now()
          await this.box.put({
            id: mail.id,
            address: this.address,
            message: EMPTY,
            handled: mail.handled
          })
        }
        handled.push(mail)
        continue
      }
      this._mail.set(mail.id, { key: b4a.from(mail.id, 'hex'), queued: 0, busy: true })
      this._resume(mail).catch(safetyCatch)
    }
    handled.sort((a, b) => a.handled - b.handled)
    for (const mail of handled) this._handled.set(mail.id, mail.handled)
    await this._prune()
    this._session = this.network.wakeup.session(this.address, {
      discoveryKey: crypto.discoveryKey(this.address),
      onannounce: (entries, peer) => this._onannounce(entries, peer),
      onpeerremove: (peer) => this._forget(peer)
    })
    // active on both ends: whichever side comes second is the one that looks the other up
    this._discovery = this.network.join(crypto.discoveryKey(this.address))
  }

  /** @private */
  async _close() {
    this._session?.destroy()
    // the unannounce is a DHT round trip, never waited on
    this._discovery?.destroy().catch(safetyCatch)
  }

  // a key stays queued by every peer that announced it, so a read that failed is tried through the
  // next one
  /** @private */
  _onannounce(entries, peer) {
    const ids = this._turns.get(peer) || new Set()
    for (const { key } of entries) {
      const id = b4a.toHex(key)
      if (ids.has(id) || this._handled.has(id)) continue
      if (ids.size >= QUEUED) {
        this._behind.add(peer)
        break
      }
      const mail = this._mail.get(id) || { key, queued: 0, busy: false }
      this._mail.set(id, mail)
      mail.queued++
      ids.add(id)
    }
    if (ids.size && !this._turns.has(peer)) this._turns.set(peer, ids)
    this._next()
  }

  /** @private */
  _forget(peer) {
    const ids = this._turns.get(peer)
    this._behind.delete(peer)
    if (!ids) return
    this._turns.delete(peer)
    for (const id of ids) {
      const mail = this._mail.get(id)
      if (--mail.queued === 0 && !mail.busy) this._mail.delete(id)
    }
  }

  /** @private */
  _next() {
    for (const [peer, ids] of this._turns) {
      if (this._reading >= READS || this.closing) return
      const from = b4a.toHex(peer.stream.remotePublicKey)
      const load = this._load.get(from) || 0
      if (load >= PER_PEER) continue
      const id = idle(ids, this._mail)
      if (id === null) continue
      ids.delete(id)
      if (ids.size === 0 && this._behind.delete(peer)) this._session.lookup(peer)
      // to the back of the turn
      this._turns.delete(peer)
      if (ids.size) this._turns.set(peer, ids)
      const mail = this._mail.get(id)
      mail.queued--
      mail.busy = true
      this._reading++
      this._load.set(from, load + 1)
      this._read(id, mail.key)
        .catch(safetyCatch)
        .finally(() => {
          this._reading--
          const left = this._load.get(from) - 1
          if (left) this._load.set(from, left)
          else this._load.delete(from)
          this._next()
        })
    }
  }

  // done with it, unless `retry` and a peer still has it queued
  /** @private */
  _settle(id, retry = false) {
    const mail = this._mail.get(id)
    mail.busy = false
    if (retry && mail.queued > 0) return
    this._mail.delete(id)
    if (mail.queued > 0) for (const ids of this._turns.values()) ids.delete(id)
  }

  /** @private */
  async _read(id, key) {
    const { store } = this.network
    // a core this device already holds is not the inbox's to erase, whatever is announced here
    const fetched = !(await store.storage.hasCore(crypto.discoveryKey(key)))
    const message = await this._unseal(key, { timeout: READ_TIMEOUT })
    // one that lands after close is dropped as if it timed out, for the next start to read
    if (!message || this.closing) return this._drop(id, fetched, true)
    await this.box.put({ id, address: this.address, message: EMPTY, fetched })
    // past it the slot is free, and the message stays in the box until its handler resolves
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, READ_TIMEOUT)
      timer.unref()
      this._handle({ id, message, fetched }).finally(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // kept from before a restart: the message is in its core, held here since it was read
  /** @private */
  async _resume({ id, fetched }) {
    const key = b4a.from(id, 'hex')
    const held = await this.network.store.storage.hasCore(crypto.discoveryKey(key))
    const message = held ? await this._unseal(key, { wait: false }) : null
    if (message) return this._handle({ id, message, fetched })
    await this.box.del(id)
    await this._drop(id, fetched && held, false)
  }

  /** @private */
  async _unseal(key, opts) {
    const core = this.network.store.get({ key })
    try {
      return crypto.decrypt(await core.get(0, opts), this.keyPair)
    } catch {
      return null // nobody served it in time
    } finally {
      await core.close()
    }
  }

  // nothing of it stays, so the next announce (a mirror's, a reconnect's) reads it again
  /** @private */
  async _drop(id, fetched, retry) {
    try {
      if (fetched) await erase(this.network.store, b4a.from(id, 'hex'))
    } finally {
      this._settle(id, retry)
    }
  }

  // dropped once handled; one that throws stays for the next time this address is received
  /** @private */
  async _handle({ id, message, fetched }) {
    try {
      if ((await this.onmessage(message)) === false) {
        await this.box.del(id)
        return await this._drop(id, fetched, false)
      }
      await this._remember(id)
      if (!this.keep && fetched) await erase(this.network.store, b4a.from(id, 'hex'))
      this._settle(id)
    } catch (err) {
      this.onerror(err)
    }
  }

  // in place of its row
  /** @private */
  async _remember(id) {
    const handled = Date.now()
    await this.box.put({ id, address: this.address, message: EMPTY, handled })
    if (this._forgotten) return this.box.del(id)
    this._handled.set(id, handled)
    await this._prune()
  }

  // the oldest go once HANDLED_FOR old, or past the ceiling
  /** @private */
  async _prune() {
    for (const [id, handled] of this._handled) {
      if (this._handled.size <= HANDLED && Date.now() - handled < HANDLED_FOR) break
      this._handled.delete(id)
      await this.box.del(id)
    }
  }
}

function isTime(handled) {
  return handled > EPOCH && handled <= Date.now()
}

function idle(ids, mail) {
  for (const id of ids) if (!mail.get(id).busy) return id
  return null
}
