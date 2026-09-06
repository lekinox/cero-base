import b4a from 'b4a'

const BYTES = '$b'
// cap a frame and the backlog so a bad length prefix cannot grow memory without bound
const MAX_FRAME = 16 * 1024 * 1024

function toWire(v) {
  if (b4a.isBuffer(v)) return { [BYTES]: b4a.toString(v, 'hex') }
  if (Array.isArray(v)) return v.map(toWire)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v)) o[k] = toWire(v[k])
    return o
  }
  return v
}

function fromWire(v) {
  if (Array.isArray(v)) return v.map(fromWire)
  if (v && typeof v === 'object') {
    if (typeof v[BYTES] === 'string') return b4a.from(v[BYTES], 'hex')
    const o = {}
    for (const k of Object.keys(v)) o[k] = fromWire(v[k])
    return o
  }
  return v
}

/**
 * Length-prefixed JSON framing over a Duplex `stream`. Buffers incoming chunks
 * and delivers each decoded frame to `onMessage`; `send` writes a framed frame.
 */
export class Framed {
  constructor(stream, onMessage) {
    this.stream = stream
    this.onMessage = onMessage
    this.buf = b4a.alloc(0)
    stream.on('data', (chunk) => this._ondata(chunk))
  }

  /**
   * Encode `obj` to wire form and write it as one length-prefixed frame.
   * @param {object} obj - message to send
   * @returns {void}
   */
  send(obj) {
    // drop a consumer that has stopped reading rather than buffer unbounded
    if ((this.stream.writableLength ?? 0) > MAX_FRAME) {
      this.stream.destroy()
      return
    }
    const body = b4a.from(JSON.stringify(toWire(obj)))
    const head = b4a.alloc(4)
    new DataView(head.buffer, head.byteOffset, 4).setUint32(0, body.length, true)
    this.stream.write(b4a.concat([head, body]))
  }

  _ondata(chunk) {
    this.buf = b4a.concat([this.buf, chunk])
    while (this.buf.length >= 4) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0, true)
      if (len > MAX_FRAME) {
        this.stream.destroy() // oversized/garbage prefix — drop the connection
        return
      }
      if (this.buf.length < 4 + len) break
      const body = b4a.toString(this.buf.subarray(4, 4 + len))
      this.buf = this.buf.subarray(4 + len)
      let msg
      try {
        msg = fromWire(JSON.parse(body))
      } catch {
        continue
      }
      this.onMessage(msg)
    }
  }
}
