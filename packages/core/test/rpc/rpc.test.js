import test from 'brittle'
import b4a from 'b4a'

import { RPCServer, RPCClient, bindCodec } from '../../src/rpc/index.js'
import { spec as echoSpec, types as T } from '../fixtures/echo-spec.js'
import { pair } from '../helpers/index.js'

// ─── helpers ──────────────────────────────────────────────────────────────

function freshSpec() {
  // Re-export a fresh shallow copy so each test gets an unbound codec.
  return { rpc: echoSpec.rpc, schema: echoSpec.schema, meta: echoSpec.meta }
}

// ─── codec ────────────────────────────────────────────────────────────────

test('bindCodec: attaches all codec methods', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const c = spec.codec
  t.ok(typeof c.encodeRow === 'function')
  t.ok(typeof c.decodeRow === 'function')
  t.ok(typeof c.encodeRows === 'function')
  t.ok(typeof c.decodeRows === 'function')
  t.ok(typeof c.encodeQuery === 'function')
  t.ok(typeof c.decodeQuery === 'function')
  t.ok(typeof c.encodeCreate === 'function')
  t.ok(typeof c.decodeCreate === 'function')
  t.ok(typeof c.encodeAction === 'function')
  t.ok(typeof c.decodeAction === 'function')
})

test('bindCodec: returns spec for chaining', async (t) => {
  const spec = freshSpec()
  t.is(bindCodec(spec), spec)
})

test('bindCodec: rejects null spec', async (t) => {
  t.exception.all(() => bindCodec(null), /spec is required/)
  t.exception.all(() => bindCodec({}), /spec\.schema is required/)
})

test('encodeRow / decodeRow: round-trip', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const row = { id: 'r1', text: 'hello' }
  const buf = spec.codec.encodeRow(T.ROW, row)
  t.ok(b4a.isBuffer(buf))
  const back = spec.codec.decodeRow(T.ROW, buf)
  t.alike(back, row)
})

test('encodeRow: null row → empty buffer, decode → undefined', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const buf = spec.codec.encodeRow(T.ROW, null)
  t.is(buf.length, 0)
  t.is(spec.codec.decodeRow(T.ROW, buf), undefined)
})

test('encodeRows / decodeRows: round-trip preserves order', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const rows = [
    { id: '1', text: 'one' },
    { id: '2', text: 'two' },
    { id: '3', text: 'three' }
  ]
  const buf = spec.codec.encodeRows(T.ROW, rows)
  const back = spec.codec.decodeRows(T.ROW, buf)
  t.is(back.length, 3)
  t.alike(back, rows)
})

test('encodeRows / decodeRows: empty array round-trip', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const buf = spec.codec.encodeRows(T.ROW, [])
  const back = spec.codec.decodeRows(T.ROW, buf)
  t.alike(back, [])
})

test('decodeRows: empty buffer → []', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  t.alike(spec.codec.decodeRows(T.ROW, b4a.alloc(0)), [])
})

test('encodeQuery / decodeQuery: standard fields round-trip', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const q = { gt: 'a', lte: 'z', limit: 10, reverse: true }
  const buf = spec.codec.encodeQuery(q)
  const back = spec.codec.decodeQuery(buf)
  t.alike(back, q)
})

test('encodeQuery / decodeQuery: data escape hatch round-trips arbitrary object', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const q = { gt: 'x', limit: 5, custom: 'value', nested: { n: 42 } }
  const buf = spec.codec.encodeQuery(q)
  const back = spec.codec.decodeQuery(buf)
  t.is(back.gt, 'x')
  t.is(back.limit, 5)
  t.is(back.custom, 'value')
  t.alike(back.nested, { n: 42 })
})

test('decodeQuery: empty buffer → undefined', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  t.is(spec.codec.decodeQuery(b4a.alloc(0)), undefined)
})

test('decodeQuery: empty envelope → undefined', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const buf = spec.codec.encodeQuery(undefined)
  t.is(spec.codec.decodeQuery(buf), undefined)
})

test('decodeQuery: strips zero defaults (limit: 0, reverse: false)', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  // gt-only query — encode then decode; limit shouldn't reappear as 0, etc.
  const buf = spec.codec.encodeQuery({ gt: 'a' })
  const back = spec.codec.decodeQuery(buf)
  t.alike(back, { gt: 'a' })
  t.absent('limit' in back)
  t.absent('reverse' in back)
})

test('encodeCreate / decodeCreate: round-trip with id', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const buf = spec.codec.encodeCreate({ id: 'abc', name: 'Cesar' })
  const back = spec.codec.decodeCreate(buf)
  t.is(back.id, 'abc')
  t.is(back.name, 'Cesar')
})

test('encodeCreate: null → empty buffer; decode empty → {}', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const buf = spec.codec.encodeCreate(null)
  t.is(buf.length, 0)
  t.alike(spec.codec.decodeCreate(buf), {})
})

test('encodeAction / decodeAction: round-trip via handle ref', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const handle = { promote: { schema: T.PROMOTE } }
  const input = { id: 'u1', role: 'admin' }
  const buf = spec.codec.encodeAction(handle, 'promote', input)
  const back = spec.codec.decodeAction(handle, 'promote', buf)
  t.alike(back, input)
})

test('encodeAction: throws on unknown op', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const handle = { promote: { schema: T.PROMOTE } }
  t.exception.all(() => spec.codec.encodeAction(handle, 'nope', {}), /unknown action/)
  t.exception.all(() => spec.codec.decodeAction(handle, 'nope', b4a.alloc(0)), /unknown action/)
})

test('encodeAction: null data → empty buffer', async (t) => {
  const spec = freshSpec()
  bindCodec(spec)
  const handle = { promote: { schema: T.PROMOTE } }
  const buf = spec.codec.encodeAction(handle, 'promote', null)
  t.is(buf.length, 0)
  t.is(spec.codec.decodeAction(handle, 'promote', buf), undefined)
})

// ─── RPCServer / RPCClient construction ───────────────────────────────────

test('RPCServer: missing ipc throws', async (t) => {
  t.exception.all(() => new RPCServer(null, freshSpec()), /ipc/)
})

test('RPCServer: missing spec throws', async (t) => {
  const [s] = pair()
  t.exception.all(() => new RPCServer(s, null), /spec/)
})

test('RPCServer: missing spec.rpc throws', async (t) => {
  const [s] = pair()
  t.exception.all(() => new RPCServer(s, { schema: {} }), /spec\.rpc/)
})

test('RPCClient: missing ipc throws', async (t) => {
  t.exception.all(() => new RPCClient(null, freshSpec()), /ipc/)
})

test('RPCClient: missing spec throws', async (t) => {
  const [s] = pair()
  t.exception.all(() => new RPCClient(s, null), /spec/)
})

test('RPCClient: missing spec.rpc throws', async (t) => {
  const [s] = pair()
  t.exception.all(() => new RPCClient(s, { schema: {} }), /spec\.rpc/)
})

// ─── RPCServer / RPCClient lifecycle ──────────────────────────────────────

test('RPCServer.ready() binds codec on the spec', async (t) => {
  const spec = freshSpec()
  const [s, c] = pair()
  const server = new RPCServer(s, spec)
  await server.ready()
  t.ok(spec.codec)
  t.ok(typeof spec.codec.encodeRow === 'function')
  await server.close()
  t.ok(s.destroyed)
  c.destroy()
})

test('RPCClient.ready() binds codec on the spec', async (t) => {
  const spec = freshSpec()
  const [s, c] = pair()
  const client = new RPCClient(c, spec)
  await client.ready()
  t.ok(spec.codec)
  await client.close()
  c.destroy()
  s.destroy()
})

test('close(): destroys the stream', async (t) => {
  const spec = freshSpec()
  const [s, c] = pair()
  const server = new RPCServer(s, spec)
  await server.ready()
  await server.close()
  t.ok(s.destroyed)
  c.destroy()
})

// ─── RPCServer / RPCClient end-to-end with subclasses ────────────────────

test('early frame: a request arriving before ready() is held, then answered', async (t) => {
  class EchoServer extends RPCServer {
    async _open() {
      this.rpc.onPing(async (msg) => `pong:${msg}`)
      await super._open()
    }
  }
  class EchoClient extends RPCClient {
    ping(msg) {
      return this.rpc.ping(msg)
    }
  }
  const [s, c] = pair()
  const server = new EchoServer(s, freshSpec())
  const client = new EchoClient(c, freshSpec())
  await client.ready()

  const pending = client.ping('early') // frame reaches the server pre-ready
  await new Promise((r) => setTimeout(r, 50))
  await server.ready()

  t.is(await pending, 'pong:early', 'held until open — never dispatched into a blind peer')
  await client.close()
  await server.close()
})

test('subclass: server registers handler, client invokes method', async (t) => {
  class EchoServer extends RPCServer {
    async _open() {
      await super._open()
      this.rpc.onPing(async (msg) => `pong:${msg}`)
    }
  }
  class EchoClient extends RPCClient {
    ping(msg) {
      return this.rpc.ping(msg)
    }
  }
  const specServer = freshSpec()
  const specClient = freshSpec()
  const [s, c] = pair()
  const server = new EchoServer(s, specServer)
  const client = new EchoClient(c, specClient)
  await server.ready()
  await client.ready()
  const res = await client.ping('hi')
  t.is(res, 'pong:hi')
  await client.close()
  await server.close()
})
