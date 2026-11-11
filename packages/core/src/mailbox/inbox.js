import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { CeroError } from '../lib/errors.js'

const NS = b4a.from('cero/mailbox')
// a read holds its slot until its message was handled, `timeout` at most to open it and as long
// again to handle it: a peer announcing keys nobody serves holds PER_PEER of the READS at
// most, however often it reconnects, and the peers take their turns, so mail from the others
// reads in the slots left
const READS = 16
const PER_PEER = 4
// a connection's keys waiting: what a mirror announces of one address at once. Past it a sender's
// posts are asked to announce again once its queue is empty; a mirror answers no such lookup
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

// per store, the cores being read or erased: a core opened while its purge runs reads a header
// half deleted and throws where no caller can catch it, so the two never overlap
const using = new WeakMap()

function exclusive(store, key, fn) {
  const id = b4a.toHex(key)
  let held = using.get(store)
  if (!held) using.set(store, (held = new Map()))
  const run = (held.get(id) || Promise.resolve()).then(fn)
  const done = run.then(noop, noop)
  held.set(id, done)
  done.then(() => held.get(id) === done && held.delete(id))
  return run
}

/**
 * Erase the core a message travelled in, once nothing reads it. Corestore leaves a core that
 * still has a session open, and that is an error here, not silence. Nothing is erased once `live`
 * says no, or the store is closing. Resolves true once no such core is stored.
 *
 * @param {import('corestore')} store
 * @param {Uint8Array} key
 * @param {() => boolean} [live]
 * @returns {Promise<boolean>}
 */
export function erase(store, key, live = () => true) {
  return exclusive(store, key, async () => {
    if (!live() || store.closing) return false
    if (!(await store.storage.hasCore(crypto.discoveryKey(key)))) return true
    const [gone] = await store.purge(key)
    if (!gone) throw CeroError.CONFLICT(`mailbox: ${b4a.toHex(key)} is still open, not erased`)
    return true
  })
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
   * @param {{ box: import('./index.js').Box, onmessage: (message: Uint8Array) => unknown, onerror: (err: Error) => void, keep?: boolean, timeout?: number, after?: Promise<void>[] }} opts  `after`: closes to wait for before it opens.
   */
  constructor(
    network,
    secret,
    { box, onmessage, onerror, keep = true, timeout = 30000, after = [] }
  ) {
    super()
    this.network = network
    this.keyPair = keyPair(secret)
    this.address = this.keyPair.publicKey
    this.box = box
    this.onmessage = onmessage
    this.onerror = onerror
    this.keep = keep
    this.timeout = timeout
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
    this._erasing = new Set()
    /** @private */
    this._landing = new Set() // reads, up to their row in the box
    /** @private */
    this._waiting = new Set() // cores open for a block still to come
    /** @private */
    this._after = after
    /** @private */
    this._session = null
    /** @private */
    this._discovery = null
  }

  /** @private */
  async _open() {
    // one still closing at this address may yet leave a row: the box is read once it has
    await Promise.allSettled(this._after)
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
            handled: mail.handled,
            fetched: mail.fetched
          })
        }
        handled.push(mail)
        continue
      }
      this._mail.set(mail.id, { key: b4a.from(mail.id, 'hex'), queued: 0, busy: true })
      this._resume(mail).catch((err) => this.onerror(err))
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
    // nothing more is fetched: its sender counts a message delivered once its block is stored
    for (const core of this._waiting) core.close().catch(safetyCatch)
    await Promise.allSettled([...this._landing, ...this._erasing])
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
        .catch((err) => this.onerror(err))
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
    const landing = this._land(id, key)
    this._landing.add(landing)
    const mail = await landing.finally(() => this._landing.delete(landing))
    if (!mail) return
    // past it the slot is free, and the message stays in the box until its handler resolves
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, this.timeout)
      timer.unref()
      this._handle(mail).finally(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // in the box before anything else: its sender has it as delivered from the moment it was stored
  /** @private */
  async _land(id, key) {
    const { held, message } = await this._unseal(key, { timeout: this.timeout })
    // a core this device already held is not the inbox's to erase, whatever is announced here
    const fetched = !held
    if (!message) {
      await this._drop(id, fetched, true)
      return null
    }
    await this.box.put({ id, address: this.address, message: EMPTY, fetched })
    return { id, message, fetched }
  }

  // kept from before a restart: the message is in its core, held here since it was read
  /** @private */
  async _resume({ id, fetched }) {
    const { held, message } = await this._unseal(b4a.from(id, 'hex'), { wait: false })
    if (message) return this._handle({ id, message, fetched })
    // a read its own close cut short says nothing of the row: it waits for the next inbox at its address
    if (this.closing) return this._settle(id)
    await this.box.del(id)
    await this._drop(id, fetched && held, false)
  }

  // the message in a core, and whether this device held the core before
  /** @private */
  _unseal(key, opts) {
    const { store } = this.network
    return exclusive(store, key, async () => {
      const held = await store.storage.hasCore(crypto.discoveryKey(key))
      // checked last before the core opens: a close from here on finds it among those waiting
      if (this.closing) opts = { wait: false }
      if (!held && opts.wait === false) return { held, message: null }
      const core = store.get({ key })
      this._waiting.add(core)
      try {
        return { held, message: crypto.decrypt(await core.get(0, opts), this.keyPair) }
      } catch {
        return { held, message: null } // nobody served it in time, or the inbox closed
      } finally {
        this._waiting.delete(core)
        await core.close()
      }
    })
  }

  // none once closing: the next mailbox open erases what was handled with keep false
  /** @private */
  async _erase(key) {
    const erasing = erase(this.network.store, key, () => !this.closing)
    this._erasing.add(erasing)
    try {
      return await erasing
    } finally {
      this._erasing.delete(erasing)
    }
  }

  // nothing of it stays, so the next announce (a mirror's, a reconnect's) reads it again
  /** @private */
  async _drop(id, fetched, retry) {
    try {
      if (fetched) await this._erase(b4a.from(id, 'hex'))
    } finally {
      this._settle(id, retry)
    }
  }

  // dropped once handled; one that throws stays for the next time this address is received
  /** @private */
  async _handle({ id, message, fetched }) {
    // closing, it hands nothing over: the message waits in the box for the next inbox at its address
    if (this.closing) return this._settle(id)
    let taken
    try {
      taken = (await this.onmessage(message)) !== false
    } catch (err) {
      return this.onerror(err)
    }
    try {
      // turned away as the inbox closes, it is kept as handled for the next start to erase
      if (!taken && !(this.closing && fetched)) {
        await this.box.del(id)
        return await this._drop(id, fetched, false)
      }
      // on a handled row, `fetched` is a core still to erase: the next start does it if this cannot
      const erasing = (!taken || !this.keep) && fetched
      const handled = await this._remember(id, erasing)
      if (erasing && (await this._erase(b4a.from(id, 'hex')))) {
        await this.box.put({ id, address: this.address, message: EMPTY, handled })
      }
      this._settle(id)
    } catch (err) {
      // closed meanwhile, its box may be gone with it: unrecorded, it comes again the next time its address is received
      if (!this.closed) this.onerror(err)
    }
  }

  // in place of its row
  /** @private */
  async _remember(id, fetched) {
    const handled = Date.now()
    await this.box.put({ id, address: this.address, message: EMPTY, handled, fetched })
    this._handled.set(id, handled)
    await this._prune()
    return handled
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

function noop() {}

function isTime(handled) {
  return handled > EPOCH && handled <= Date.now()
}

function idle(ids, mail) {
  for (const id of ids) if (!mail.get(id).busy) return id
  return null
}
