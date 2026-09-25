import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { Inbox, keyPair } from './inbox.js'
import { Post } from './post.js'
import { CeroError } from '../lib/errors.js'

/**
 * @typedef {object} Mail
 * @property {string} id                 Unique per message, hex.
 * @property {Uint8Array} address        Where it goes, or where it arrived.
 * @property {Uint8Array} message
 * @property {Uint8Array[]} [mirrors]    Where a sent message waits for an owner who is offline.
 *
 * @typedef {object} Box                 Where mail is kept; memory unless given a persistent one.
 * @property {() => Promise<Mail[]>} list
 * @property {(mail: Mail) => Promise<unknown>} put
 * @property {(id: string) => Promise<unknown>} del
 *
 * @typedef {object} MailboxOpts
 * @property {Box} [inbox]                   Keeps a received message until it was handled.
 * @property {Box} [outbox]                  Keeps a sent message until someone read it.
 * @property {(err: Error) => void} [onerror] Called when a message fails to be handled or sent.
 */

/**
 * A device's mailbox. It receives at the addresses it holds the secret of, and sends to any
 * address. Both ends keep their mail until it is done with: the outbox until someone read it,
 * the inbox until it was handled. Give it persistent boxes and that survives a restart: it
 * sends again what was not read and hands over again what was not handled, so a message may
 * arrive twice, never not at all.
 */
export class Mailbox extends ReadyResource {
  /**
   * @param {import('../network/index.js').Network} network  Needs a store: messages travel as cores in it.
   * @param {MailboxOpts} [opts]
   */
  constructor(
    network,
    { inbox = memory(), outbox = memory(), onerror = (err) => console.error(err) } = {}
  ) {
    super()
    if (!network?.store) throw CeroError.REQUIRED('store')
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

  /** @private */
  async _open() {
    await this.network.ready()
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
   * over again the next time this address is received.
   *
   * @param {Uint8Array} secret
   * @param {(message: Uint8Array) => unknown} onmessage
   * @returns {{ close: () => Promise<void> }}
   */
  receive(secret, onmessage) {
    const inbox = new Inbox(this.network, secret, {
      box: this.inbox,
      onmessage,
      onerror: this.onerror
    })
    this._track(inbox)
    inbox.ready().catch(this.onerror)
    return inbox
  }

  /**
   * Send a message to an address. Resolves once the outbox keeps it; it is delivered in the
   * background, and dropped from the outbox once someone read it.
   *
   * @param {Uint8Array} address
   * @param {Uint8Array} message
   * @param {{ mirrors?: Uint8Array[] }} [opts]  Where it waits for an owner who is offline; the network's by default.
   * @returns {Promise<void>}
   */
  async send(address, message, { mirrors = this.network.mirrors } = {}) {
    if (!this.opened) await this.ready()
    const mail = { id: b4a.toHex(crypto.randomBytes(16)), address, message, mirrors }
    await this.outbox.put(mail)
    this._deliver(mail)
  }

  /** @private */
  _deliver({ id, address, message, mirrors }) {
    const post = new Post(this.network, address, message, { mirrors })
    this._track(post)
    deliver(post, () => this.outbox.del(id)).catch(safetyCatch)
  }

  /** @private */
  _track(resource) {
    this._resources.add(resource)
    resource.once('close', () => this._resources.delete(resource))
  }
}

// wait until a post is read once, then close it
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
    put: async (mail) => kept.set(mail.id, mail),
    del: async (id) => kept.delete(id)
  }
}
