import test from 'brittle'
import b4a from 'b4a'
import { Duplex } from 'streamx'

import { put } from '@cero-base/cero'
import { serve } from '../src/server.js'
import { connect } from '../src/connect.js'
import { Framed } from '../src/protocol.js'
import { buildSpec, openCero } from './helpers/index.js'

function pair() {
  let a, b
  a = new Duplex({
    write(data, cb) {
      b.push(data)
      cb(null)
    }
  })
  b = new Duplex({
    write(data, cb) {
      a.push(data)
      cb(null)
    }
  })
  return [a, b]
}

const once = (stream, event) =>
  new Promise((resolve, reject) => {
    stream.once(event, resolve)
    stream.once('error', reject)
  })

// ─── robustness: malformed input / transport faults must not crash the host ──

test('tap server: a malformed (null/scalar) frame is ignored, not crashed on', async (t) => {
  const [a] = pair()
  const server = serve(a, { id: 'root', children: [] }, {})
  t.teardown(() => server.close())
  await server.onRequest(null)
  await server.onRequest(42)
  await server.onRequest('not-an-object')
  t.pass('malformed frames handled without throwing')
})

test('tap server: an inbound stream error tears down instead of crashing the host', (t) => {
  const [a] = pair()
  const server = serve(a, { id: 'root', children: [] }, {})
  t.teardown(() => server.close())
  a.emit('error', new Error('ECONNRESET')) // would be uncaught without the error listener
  t.pass('stream error did not crash the process')
})

test('tap session: pending requests reject when the transport drops (no hang)', async (t) => {
  const [, b] = pair()
  const session = await connect(b) // no server on the other end — request stays pending
  const p = session.handles()
  b.destroy()
  await t.exception(p, /connection closed/)
})

test('tap protocol: an oversized length prefix drops the connection', async (t) => {
  const [a] = pair()
  new Framed(a, () => t.fail('an oversized frame must not be delivered'))
  const head = b4a.alloc(4)
  new DataView(head.buffer, head.byteOffset, 4).setUint32(0, 1024 * 1024 * 1024, true)
  a.push(head)
  await once(a, 'close')
  t.pass('connection dropped on an oversized frame prefix')
})

test('tap server: get/count/handles round-trip', async (t) => {
  const { spec } = await buildSpec(t, 'rt')
  const me = await openCero(t, spec)
  await put(me.messages, { text: 'hello' })

  const [a, b] = pair()
  const server = serve(a, me, {})
  const session = await connect(b)
  t.teardown(() => {
    server.close()
    session.close()
  })

  const got = await session.get('messages')
  t.ok(
    got.data.find((r) => r.text === 'hello'),
    'get returns app rows'
  )
  t.is(await session.count('messages'), got.total, 'count matches total')

  const handles = await session.handles()
  t.ok(
    handles.find((h) => h.id === me.id),
    'handles lists the root'
  )
})

test('tap server: secret/local refs are refused', async (t) => {
  const { spec } = await buildSpec(t, 'secret')
  const me = await openCero(t, spec)

  const [a, b] = pair()
  const server = serve(a, me, {})
  const session = await connect(b)
  t.teardown(() => {
    server.close()
    session.close()
  })

  await t.exception(session.get('master'), /unknown ref/)
  await t.exception(session.get('keypair'), /unknown ref/)
})

test('tap server: events stream delivers buffered + live', async (t) => {
  const { spec } = await buildSpec(t, 'events')
  const me = await openCero(t, spec)

  const ring = {
    items: [],
    snapshot() {
      return this.items
    },
    subs: new Set(),
    subscribe(fn) {
      this.subs.add(fn)
      return () => this.subs.delete(fn)
    },
    push(e) {
      this.items.push(e)
      for (const f of this.subs) f(e)
    }
  }
  ring.push({ op: 'add', name: 'profile' })

  const [a, b] = pair()
  const server = serve(a, me, { events: ring })
  const session = await connect(b)
  t.teardown(() => {
    server.close()
    session.close()
  })

  const ev = session.events()
  const buffered = await once(ev, 'data')
  t.is(buffered.name, 'profile', 'buffered event delivered first')

  ring.push({ op: 'add', name: 'messages' })
  const live = await once(ev, 'data')
  t.is(live.name, 'messages', 'live event delivered')
})

// ─── token gate ───────────────────────────────────────────────────────────

test('tap server: wrong or missing token drops the connection', async (t) => {
  const [a, b] = pair()
  const server = serve(a, { id: 'root', children: [] }, { token: 'sekrit' })
  t.teardown(() => server.close())

  const closed = once(a, 'close')
  const session = await connect(b, { token: 'wrong' })
  session.handles().catch(() => {}) // never answered — the transport dies instead
  await closed
  t.pass('connection destroyed on bad token')
})

test('tap server: correct token authenticates the session', async (t) => {
  const [a, b] = pair()
  const server = serve(a, { id: 'root', children: [] }, { token: 'sekrit' })
  t.teardown(() => server.close())

  const session = await connect(b, { token: 'sekrit' })
  const handles = await session.handles()
  t.is(handles[0].id, 'root', 'authed request served')
  session.close()
})
