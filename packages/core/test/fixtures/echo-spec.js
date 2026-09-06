// Minimal HRPC + schema fixture used by rpc tests. Hand-rolled instead of
// running HRPCBuilder at test time — keeps tests fast and dependency-free.
import b4a from 'b4a'
import c from 'compact-encoding'
import RPC from 'bare-rpc'

const PING_REQ = c.string
const PING_RES = c.string
const ROW = {
  preencode(state, m) {
    c.string.preencode(state, m.id)
    c.string.preencode(state, m.text)
  },
  encode(state, m) {
    c.string.encode(state, m.id)
    c.string.encode(state, m.text)
  },
  decode(state) {
    return { id: c.string.decode(state), text: c.string.decode(state) }
  }
}

const ACTION_PROMOTE = {
  preencode(state, m) {
    c.string.preencode(state, m.id)
    c.string.preencode(state, m.role)
  },
  encode(state, m) {
    c.string.encode(state, m.id)
    c.string.encode(state, m.role)
  },
  decode(state) {
    return { id: c.string.decode(state), role: c.string.decode(state) }
  }
}

const ENCODINGS = new Map([['@echo/ping', { req: PING_REQ, res: PING_RES }]])

const COMMANDS = new Map([
  ['@echo/ping', 1],
  [1, '@echo/ping']
])

class HRPC {
  constructor(stream) {
    this._stream = stream
    this._handlers = {}
    this._rpc = new RPC(stream, async (req) => {
      const cmd = COMMANDS.get(req.command)
      if (!cmd) return
      const enc = ENCODINGS.get(cmd)
      const handler = this._handlers[cmd]
      if (!handler) return
      const input = req.data ? c.decode(enc.req, req.data) : null
      const output = await handler(input)
      req.reply(c.encode(enc.res, output))
    })
  }

  async ping(args) {
    const enc = ENCODINGS.get('@echo/ping')
    const req = this._rpc.request(COMMANDS.get('@echo/ping'))
    req.send(c.encode(enc.req, args))
    return c.decode(enc.res, await req.reply())
  }

  onPing(fn) {
    this._handlers['@echo/ping'] = fn
  }
}

// Minimal hyperschema-shaped object — exposes only what bindCodec uses.
const schema = {
  encode(name, value) {
    const enc = byName(name)
    const state = { start: 0, end: 0, buffer: null }
    enc.preencode(state, value)
    state.buffer = b4a.alloc(state.end)
    enc.encode(state, value)
    return state.buffer
  },
  decode(name, buffer) {
    const enc = byName(name)
    const state = { start: 0, end: buffer.length, buffer }
    return enc.decode(state)
  }
}

function byName(name) {
  if (name === '@echo/row') return ROW
  if (name === '@echo/promote') return ACTION_PROMOTE
  throw new Error(`unknown schema type: ${name}`)
}

export const spec = {
  rpc: HRPC,
  schema,
  meta: { ns: 'echo' }
}

export const types = {
  ROW: '@echo/row',
  PROMOTE: '@echo/promote'
}
