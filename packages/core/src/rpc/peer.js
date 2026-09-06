import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import FramedStream from 'framed-stream'

import { bindCodec } from './index.js'
import { CeroError } from '../lib/errors.js'

/**
 * Shared RPC peer: wraps an IPC duplex in a length-framed stream and constructs the spec's
 * hrpc binding.
 */
export class RPCPeer extends ReadyResource {
  /**
   * @param {any} ipc                                Duplex IPC stream (e.g. a socket or pipe).
   * @param {import('./index.js').Spec} spec         Spec object exposing `rpc` and `schema`.
   */
  constructor(ipc, spec) {
    super()
    if (!ipc) throw CeroError.REQUIRED('ipc')
    if (!spec) throw CeroError.REQUIRED('spec')
    if (!spec.rpc) throw CeroError.REQUIRED('spec.rpc')

    this.ipc = ipc
    this.spec = spec
    this.framed = new FramedStream(ipc)
    this.rpc = new spec.rpc(this.framed)
    // pause after hrpc attaches its listener, streamx resumes on attach
    this.framed.pause()
  }

  async _open() {
    if (!this.spec.codec) bindCodec(this.spec)
    this.framed.resume()
  }

  async _close() {
    if (this.framed && !this.framed.destroyed) {
      try {
        this.framed.destroy()
      } catch (err) {
        safetyCatch(err)
      }
    }
  }
}
