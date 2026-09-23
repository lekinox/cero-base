import ReadyResource from 'ready-resource'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

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
 * Receives at the address a secret owns, direct from the sender or from a mirror. A message
 * that does not open is dropped; one that opens is kept in `box` until `onmessage` resolves.
 */
export class Inbox extends ReadyResource {
  /**
   * @param {import('../network/index.js').Network} network
   * @param {Uint8Array} secret
   * @param {{ box: import('./index.js').Box, onmessage: (message: Uint8Array) => unknown, onerror: (err: Error) => void }} opts
   */
  constructor(network, secret, { box, onmessage, onerror }) {
    super()
    this.network = network
    this.keyPair = keyPair(secret)
    this.address = this.keyPair.publicKey
    this.box = box
    this.onmessage = onmessage
    this.onerror = onerror
    this._seen = new Set()
    this._session = null
    this._discovery = null
  }

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

  async _close() {
    this._session?.destroy()
    await this._discovery?.destroy()
  }

  _onannounce(key) {
    const id = b4a.toHex(key)
    if (this._seen.has(id)) return
    this._seen.add(id)
    // unread, so the next announce (a mirror's, a reconnect's) retries it
    this._read(id, key).catch(() => this._seen.delete(id))
  }

  async _read(id, key) {
    const core = this.network.store.get({ key })
    let message
    try {
      message = crypto.decrypt(await core.get(0, { timeout: READ_TIMEOUT }), this.keyPair)
    } finally {
      await core.close()
    }
    if (!message) return
    const mail = { id, address: this.address, message }
    await this.box.put(mail)
    this._handle(mail)
  }

  // dropped once handled; one that throws stays for the next time this address is received
  async _handle({ id, message }) {
    try {
      await this.onmessage(message)
      await this.box.del(id)
    } catch (err) {
      this.onerror(err)
    }
  }
}
