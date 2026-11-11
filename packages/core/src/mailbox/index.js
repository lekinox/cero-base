import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { Inbox, keyPair, erase, aged } from './inbox.js'
import { Post } from './post.js'
import { CeroError } from '../lib/errors.js'

/**
 * @typedef {object} Mail
 * @property {string} id                 Unique per message, hex.
 * @property {string} [name]             The core it travels in, so a restart sends it on the same core.
 * @property {Uint8Array} address        Where it goes, or where it arrived.
 * @property {Uint8Array} message      Sent: as `sealed` says. Received: empty, it stays in its core.
 * @property {Uint8Array[]} [mirrors]    Where a sent message waits for an owner who is offline.
 * @property {boolean} [keep]            False erases the sender's copy once a device or a mirror stored it.
 * @property {boolean} [fetched]         The inbox fetched the core it arrived in, so it may erase it; on a handled row, it still has to.
 * @property {number} [handled]          When it was handled: the id is remembered for a while.
 * @property {boolean} [sealed]          Sent: `message` is sealed to the address, not in the clear.
 *
 * @typedef {object} Box                 Where mail is kept; memory unless given a persistent one.
 * @property {() => Promise<Mail[]>} list
 * @property {(id: string) => Promise<Mail | null>} get   The one row under an id, null when there is none.
 * @property {(mail: Mail) => Promise<unknown>} put
 * @property {(id: string) => Promise<unknown>} del
 *
 * @typedef {object} MailboxOpts
 * @property {Box} [inbox]                   Keeps a received message until it was handled.
 * @property {Box} [outbox]                  Keeps a sent message until a device or a mirror stored it.
 * @property {(err: Error) => void} [onerror] Called when a message fails to be handled or sent.
 */

/**
 * A device's mailbox. It receives at the addresses it holds the secret of, and sends to any
 * address. Both ends keep their mail until it is done with: the outbox until a device or a
 * mirror stored it, the inbox until it was handled. Give it persistent boxes and that survives a
 * restart: it sends again what was not stored and hands over again what was not handled, so a
 * message may arrive twice, never not at all.
 */
export class Mailbox extends ReadyResource {
  /**
   * @param {import('../network/index.js').Network} network  Messages travel as cores in its store.
   * @param {MailboxOpts} [opts]
   */
  constructor(
    network,
    { inbox = memory(), outbox = memory(), onerror = (err) => console.error(err) } = {}
  ) {
    super()
    if (!network) throw CeroError.REQUIRED('network')
    this.network = network
    this.inbox = inbox
    this.outbox = outbox
    this.onerror = onerror
    /** @private */
    this._resources = new Set() // inboxes, and posts not read yet
  }

  /**
   * The address a secret owns: share it, anyone can send to it, only the secret opens.
   *
   * @param {Uint8Array} secret
   * @returns {Uint8Array}
   */
  static getAddress(secret) {
    return keyPair(secret).publicKey
  }

  /**
   * The key pair behind the address: seal to `publicKey` with `crypto.encrypt`, open with
   * `crypto.decrypt(sealed, pair)`.
   *
   * @param {Uint8Array} secret
   * @returns {{ publicKey: Uint8Array, secretKey: Uint8Array }}
   */
  static keyPair(secret) {
    return keyPair(secret)
  }

  /** @private */
  async _open() {
    await this.network.ready()
    // at any address, one received at again or not: handled rows that aged go, and a core its
    // inbox had to leave as it closed is erased
    for (const mail of await this.inbox.list()) {
      if (aged(mail)) await this.inbox.del(mail.id)
      else if (mail.handled && mail.fetched) await this._owed(mail)
    }
    for (const mail of await this.outbox.list()) this._deliver(mail)
  }

  /** @private */
  async _close() {
    const open = [...this._resources]
    this._resources.clear()
    await Promise.allSettled(open.map((resource) => resource.close()))
  }

  /**
   * Receive the messages sent to the address `secret` owns, until the returned inbox closes.
   * A message stays in the inbox until `onmessage` resolves; one it did not finish is handed
   * over again the next time this address is received. One it resolves `false` on was not for
   * this address: it is erased as one that does not open.
   *
   * @param {Uint8Array} secret
   * @param {(message: Uint8Array) => unknown} onmessage
   * @param {{ keep?: boolean, timeout?: number }} [opts]  `keep`: false erases each message from this device once handled; one that was being read when the app was killed or its inbox closed is handed over at the next start and stays on the device. `timeout`: ms a message has to arrive once announced, and again to be handled, 30 s by default.
   * @returns {{ close: () => Promise<void> }}
   */
  receive(secret, onmessage, { keep = true, timeout } = {}) {
    const address = keyPair(secret).publicKey
    // an inbox still closing at this address may yet leave a row: this one opens once it has, and finds it
    const after = [...this._resources]
      .filter((r) => r instanceof Inbox && r.closing && b4a.equals(r.address, address))
      .map((r) => r.closing)
    const inbox = new Inbox(this.network, secret, {
      box: this.inbox,
      onmessage,
      onerror: this.onerror,
      keep,
      timeout,
      after
    })
    this._track(inbox)
    inbox.ready().catch(this.onerror)
    return inbox
  }

  /**
   * Send a message to an address. Resolves once the outbox keeps it; it is delivered in the
   * background, and dropped from the outbox once the owner or a mirror stored it.
   *
   * @param {Uint8Array} address
   * @param {Uint8Array} message
   * @param {{ mirrors?: Uint8Array[], keep?: boolean }} [opts]  `mirrors`: where it waits for an owner who is offline, the network's by default. `keep`: false erases it from this device once a device or a mirror stored it.
   * @returns {Promise<void>}
   */
  async send(address, message, { mirrors = this.network.mirrors, keep = true } = {}) {
    // a send racing the close fails as the mailbox closing, never as the storage under it
    if (this.closing) throw CeroError.CLOSED('Mailbox')
    if (!this.opened) await this.ready()
    const name = b4a.toHex(crypto.randomBytes(32))
    const mail = {
      id: b4a.toHex(crypto.randomBytes(16)),
      name,
      address,
      message: crypto.encrypt(message, address),
      mirrors,
      keep,
      sealed: true
    }
    try {
      await this.outbox.put(mail)
    } catch (err) {
      if (this.closing) throw CeroError.CLOSED('Mailbox')
      throw err
    }
    if (this.closing) throw CeroError.CLOSED('Mailbox')
    this._deliver(mail)
  }

  /** @private */
  _deliver({ id, name, address, message, mirrors, keep = true, sealed = false }) {
    const post = new Post(this.network, address, message, { mirrors, name, sealed })
    this._track(post)
    deliver(post, () => this.outbox.del(id))
      .then(() => keep || this._erase(post.key).catch(this.onerror))
      .catch(safetyCatch)
  }

  /** @private */
  _erase(key) {
    return erase(this.network.store, key, () => !this.closing)
  }

  // an erase its inbox had to leave, done once and then no longer owed
  /** @private */
  async _owed({ id, address, handled }) {
    try {
      if (await this._erase(b4a.from(id, 'hex'))) {
        await this.inbox.put({ id, address, message: b4a.alloc(0), handled })
      }
    } catch (err) {
      this.onerror(err)
    }
  }

  /** @private */
  _track(resource) {
    this._resources.add(resource)
    resource.once('close', () => this._resources.delete(resource))
  }
}

// wait until a post is stored once, then close it
async function deliver(post, ondelivered) {
  try {
    await post.ready()
    await post.delivered
    await ondelivered()
  } finally {
    await post.close()
  }
}

/** @returns {Box} */
function memory() {
  const kept = new Map()
  return {
    list: async () => [...kept.values()],
    get: async (id) => kept.get(id) ?? null,
    put: async (mail) => kept.set(mail.id, mail),
    del: async (id) => kept.delete(id)
  }
}
