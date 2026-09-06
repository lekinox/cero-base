import BlobServer from 'hypercore-blob-server'
import { decodeId } from './index.js'

/**
 * @typedef {{ key: Buffer, encryptionKey: Buffer | null }} Resolved
 */

/**
 * HTTP server that turns a string file id into a renderable localhost URL.
 */
export class FileServer {
  /**
   * @param {object} opts
   * @param {import('corestore')} opts.store
   * @param {(coreKey: Buffer, info: object) => Resolved | null | Promise<Resolved | null>} opts.resolve
   */
  constructor({ store, resolve }) {
    this.resolve = resolve
    this.server = new BlobServer(store.session(), {
      resolve: (key, info) => this.resolve(key, info)
    })
  }

  get port() {
    return this.server.port
  }

  async listen() {
    await this.server.listen()
  }

  /**
   * Build a renderable localhost URL for a string file id.
   *
   * @param {string} id
   * @returns {string}
   */
  getLink(id) {
    const { coreKey, blobId, type } = decodeId(id)
    return this.server.getLink(coreKey, { blob: blobId, type })
  }

  async close() {
    await this.server.close()
  }
}
