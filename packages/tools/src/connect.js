import { Readable } from 'streamx'

import { Framed } from './protocol.js'

/**
 * @typedef {object} Query  Opaque query filter passed to the server.
 */

/**
 * @typedef {Record<string, unknown>} Handle  A handle descriptor returned by the server.
 */

/**
 * Consumer SDK for a tap server reached over a local Duplex `stream`.
 *
 * @param {object} stream  A streamx Duplex connected to a tap server.
 * @returns {Promise<{ handles(): Promise<Handle[]>, get(ref: string, query?: Query, handleId?: string): Promise<unknown>, watch(ref: string, query?: Query, handleId?: string): import('streamx').Readable, events(): import('streamx').Readable, stats(): import('streamx').Readable, close(): void }>}
 */
export async function connect(stream, { token } = {}) {
  return new Session(stream, { token })
}

export class Session {
  constructor(stream, { token } = {}) {
    this.stream = stream
    this.token = token || null
    this.pending = new Map()
    this.streams = new Map()
    this.seq = 0
    this.wire = new Framed(stream, (msg) => this._onmessage(msg))
    stream.on('error', () => {}) // a transport error shouldn't crash the consumer
    stream.on('close', () => this._onclose())
  }

  /**
   * Lists the handles exposed by the server.
   *
   * @returns {Promise<Handle[]>} Resolves to the handle descriptors.
   */
  handles() {
    return this._request('handles', {})
  }

  /**
   * Reads the current value for `ref`.
   *
   * @param {string} ref  Reference to read.
   * @param {Query} [query]  Optional query filter.
   * @param {string} [handleId]  Optional handle to scope the read.
   * @returns {Promise<unknown>} Resolves to the value.
   */
  get(ref, query, handleId) {
    return this._request('get', { ref, query, handleId })
  }

  /**
   * Watches `ref` for changes, emitting frames as they arrive.
   *
   * @param {string} ref  Reference to watch.
   * @param {Query} [query]  Optional query filter.
   * @param {string} [handleId]  Optional handle to scope the watch.
   * @returns {import('streamx').Readable} Cancels its server-side source when destroyed.
   */
  watch(ref, query, handleId) {
    return this._stream('watch', { ref, query, handleId })
  }

  /**
   * Streams server events.
   *
   * @returns {import('streamx').Readable} Cancels its server-side source when destroyed.
   */
  events() {
    return this._stream('events', {})
  }

  /**
   * Streams server stats.
   *
   * @returns {import('streamx').Readable} Cancels its server-side source when destroyed.
   */
  stats() {
    return this._stream('stats', {})
  }

  /**
   * Closes the session by ending the underlying stream.
   *
   * @returns {void}
   */
  close() {
    this.stream.end()
  }

  // fail in-flight requests and end live streams
  _onclose() {
    for (const { reject } of this.pending.values()) {
      reject(new TapError('connection closed', 'CLOSED'))
    }
    this.pending.clear()
    for (const r of this.streams.values()) r.push(null)
    this.streams.clear()
  }

  _onmessage(msg) {
    if ('frame' in msg || msg.end) {
      const r = this.streams.get(msg.id)
      if (!r) return
      if (msg.end) {
        this.streams.delete(msg.id)
        r.push(null)
      } else {
        r.push(msg.frame)
      }
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.ok === false) p.reject(new TapError(msg.error, msg.code))
    else p.resolve(msg.data)
  }

  _newId() {
    return ++this.seq
  }

  _send(frame) {
    this.wire.send(this.token ? { token: this.token, ...frame } : frame)
  }

  _request(method, fields) {
    return new Promise((resolve, reject) => {
      const id = this._newId()
      this.pending.set(id, { resolve, reject })
      this._send({ id, method, ...fields })
    })
  }

  _stream(method, fields) {
    const id = this._newId()
    const r = new Readable({
      destroy: (cb) => {
        if (this.streams.delete(id)) {
          this._send({ id: this._newId(), method: 'cancel', cancelId: id })
        }
        cb(null)
      }
    })
    this.streams.set(id, r)
    this._send({ id, method, ...fields })
    return r
  }
}

class TapError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}
