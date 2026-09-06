import Hyperblobs from 'hyperblobs'
import ReadyResource from 'ready-resource'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'

import { NAMESPACE } from '../lib/constants.js'
import { CeroError } from '../lib/errors.js'
import { encodeId, decodeId } from './codec.js'

const NS = `${NAMESPACE}/blobs`

/**
 * @typedef {object} BlobsOpts
 * @property {object} store                                           Corestore (or compatible) used to host the blob core.
 * @property {import('../identity/index.js').Identity} [identity]     Identity supplying the default encryption key.
 * @property {import('../network/index.js').Network} [network]        Optional network used to announce + replicate the core.
 * @property {Uint8Array} [key]                                       Pre-existing blob core key — joins an existing blob feed.
 * @property {Uint8Array} [encryptionKey]                             Explicit encryption key, overrides `identity.encryptionKey`.
 *
 * @typedef {import('./codec.js').RawBlobId} RawBlobId
 */

/** Thin wrapper over a single Hyperblobs core; deals only in raw blobIds. */
export class Blobs extends ReadyResource {
  /** @param {BlobsOpts} [opts] */
  constructor({ store, identity, network, key, encryptionKey, name } = {}) {
    super()
    if (!store) throw CeroError.REQUIRED('store')
    if (!identity && !encryptionKey) throw CeroError.REQUIRED('identity or encryptionKey')

    this.store = store
    this.identity = identity || null
    this.network = network || null
    this.encryptionKey = encryptionKey || (identity && identity.encryptionKey) || null
    this.name = name || 'blobs'

    this._coreKey = key || null
    this.core = null
    this.hyperblobs = null
    this._discovery = null
  }

  /**
   * Canonical z32 id of the underlying core (null until ready).
   *
   * @returns {string | null}
   */
  get id() {
    return this.key ? hid.encode(this.key) : null
  }

  /**
   * Public key of the underlying core.
   *
   * @returns {Uint8Array | null}
   */
  get key() {
    return this.core ? this.core.key : null
  }

  /**
   * Discovery key derived from the core key, used for swarm topics.
   *
   * @returns {Uint8Array | null}
   */
  get discoveryKey() {
    return this.core ? this.core.discoveryKey : null
  }

  async _open() {
    await this.store.ready()
    if (this.network) await this.network.ready()

    const opts = { encryptionKey: this.encryptionKey }
    if (this._coreKey) opts.key = this._coreKey
    else opts.name = this.name

    const ns = this.store.namespace(NS)
    this.core = ns.get(opts)
    await this.core.ready()

    this.hyperblobs = new Hyperblobs(this.core)
    await this.hyperblobs.ready()

    if (this.network) {
      this.network.attach(this.core)
      this._discovery = this.network.join(this.core.discoveryKey)
    }
  }

  async _close() {
    if (this._discovery) await this._discovery.destroy()
    if (this.network && this.core) this.network.detach(this.core)
    if (this.hyperblobs) await this.hyperblobs.close()
    if (this.core) await this.core.close()
  }

  /**
   * Store a buffer or readable stream, returning its raw hyperblobs blobId.
   *
   * @param {Uint8Array | import('streamx').Readable} input
   * @returns {Promise<RawBlobId>}
   */
  async put(input) {
    this._guard()
    if (input == null) throw CeroError.REQUIRED('input')
    if (b4a.isBuffer(input)) return this.hyperblobs.put(b4a.toBuffer(input))
    if (isReadable(input)) return this._putStream(input)
    throw CeroError.INVALID('input must be a buffer or a Readable stream')
  }

  /**
   * Resolve the blob bytes for a raw blobId. Fetches from peers if not local.
   *
   * @param {RawBlobId} blobId
   * @param {object} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async get(blobId, opts) {
    this._guard()
    return this.hyperblobs.get(blobId, opts)
  }

  /**
   * Streaming counterpart of `get` — a Readable over the blob bytes.
   *
   * @param {RawBlobId} blobId
   * @param {object} [opts]
   * @returns {import('streamx').Readable}
   */
  createReadStream(blobId, opts) {
    this._guard()
    return this.hyperblobs.createReadStream(blobId, opts)
  }

  /**
   * Clear the blocks backing a raw blobId from the local core.
   *
   * @param {RawBlobId} blobId
   * @returns {Promise<void>}
   */
  async clear(blobId) {
    this._guard()
    await this.hyperblobs.clear(blobId)
  }

  /**
   * @param {import('streamx').Readable} input
   * @returns {Promise<RawBlobId>}
   */
  async _putStream(input) {
    const ws = this.hyperblobs.createWriteStream()
    await new Promise((resolve, reject) => {
      input.on('error', reject)
      ws.on('error', reject)
      ws.on('close', resolve)
      input.pipe(ws)
    })
    return ws.id
  }

  _guard() {
    if (this.closed) throw CeroError.CLOSED('Blobs')
    if (!this.opened) throw CeroError.NOT_READY('Blobs', 'blobs')
  }
}

/**
 * @param {unknown} x
 * @returns {x is import('streamx').Readable}
 */
function isReadable(x) {
  return x && typeof x.pipe === 'function' && typeof x.on === 'function'
}

export { encodeId, decodeId }
