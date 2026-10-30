import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { CeroError } from '../lib/errors.js'

const NS = b4a.from('cero/mailbox')
const READ_TIMEOUT = 30000

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
 * that does not open is dropped; one that opens is kept in `box` until `onmessage` resolves.
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
    this._seen = new Set()
    /** @private */
    this._session = null
    /** @private */
    this._discovery = null
  }

  /** @private */
  async _open() {
    for (const mail of await this.box.list()) {
      if (!b4a.equals(mail.address, this.address)) continue
      this._seen.add(mail.id)
      this._handle(mail)
    }
    this._session = this.network.wakeup.session(this.address, {
      discoveryKey: crypto.discoveryKey(this.address),
      onannounce: (entries) => {
        for (const { key } of entries) this._onannounce(key)
      }
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

  /** @private */
  _onannounce(key) {
    const id = b4a.toHex(key)
    if (this._seen.has(id)) return
    this._seen.add(id)
    // unread, so the next announce (a mirror's, a reconnect's) retries it
    this._read(id, key).catch(() => this._seen.delete(id))
  }

  /** @private */
  async _read(id, key) {
    const { store } = this.network
    // a core this device already holds is not the inbox's to erase, whatever is announced here
    const fetched = !(await store.storage.hasCore(crypto.discoveryKey(key)))
    const core = store.get({ key })
    let message
    try {
      message = crypto.decrypt(await core.get(0, { timeout: READ_TIMEOUT }), this.keyPair)
    } finally {
      await core.close()
    }
    if (!message) {
      if (fetched) await erase(store, key)
      return
    }
    const mail = { id, address: this.address, message, fetched }
    await this.box.put(mail)
    this._handle(mail)
  }

  // dropped once handled; one that throws stays for the next time this address is received
  /** @private */
  async _handle({ id, message, fetched }) {
    try {
      await this.onmessage(message)
      await this.box.del(id)
      if (!this.keep && fetched) await erase(this.network.store, b4a.from(id, 'hex'))
    } catch (err) {
      this.onerror(err)
    }
  }
}
