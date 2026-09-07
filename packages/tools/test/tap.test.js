import test from 'brittle'
import { Duplex } from 'streamx'

import { cero, put, get } from '@cero-base/cero'
import { devtools } from '../src/tap.js'
import { connect } from '../src/connect.js'
import { buildSpec, openCero } from './helpers/index.js'

test.configure({ timeout: 60000 })

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

function memoryTransport() {
  return {
    accept(fn) {
      this._on = fn
    },
    connect() {
      const [a, b] = pair()
      this._on(a)
      return b
    }
  }
}

const waitFor = (stream, pred) =>
  new Promise((resolve, reject) => {
    const onData = (frame) => {
      if (!pred(frame)) return
      stream.off('data', onData)
      stream.off('error', onError)
      resolve(frame)
    }
    const onError = (err) => {
      stream.off('data', onData)
      reject(err)
    }
    stream.on('data', onData)
    stream.once('error', onError)
  })

test('tap: a consumer sees live events + data + stats end-to-end', async (t) => {
  const tp = memoryTransport()
  const extensions = [devtools({ transport: tp, sampleInterval: 50, token: 't-e2e' })]
  const me = await openCero(t, (await buildSpec(t, 'tap-e2e')).spec, { extensions })
  const session = await connect(tp.connect(), { token: 't-e2e' })
  t.teardown(() => session.close())

  await put(me.messages, { text: 'live' })

  const ev = session.events()
  const e = await waitFor(ev, (f) => f.name === 'messages')
  t.ok(e.op, 'event carries op')
  t.is(e.name, 'messages', 'event carries ref name')
  t.is(e.row?.text, 'live', 'event carries row')

  t.ok(
    (await session.get('messages')).data.find((r) => r.text === 'live'),
    'data readable over the tap'
  )

  const s = session.stats()
  const frame = await waitFor(s, () => true)
  t.ok(frame.network, 'stats frame has network')
  t.ok(Array.isArray(frame.cores), 'stats frame has cores')
})

test('tap: non-disruption — the consumer is NOT a swarm connection', async (t) => {
  const tp = memoryTransport()
  const extensions = [devtools({ transport: tp, token: 't-e2e' })]
  const me = await openCero(t, (await buildSpec(t, 'tap-nondisrupt')).spec, { extensions })
  const session = await connect(tp.connect(), { token: 't-e2e' })
  t.teardown(() => session.close())

  await put(me.messages, { text: 'x' })
  await session.get('messages')

  t.is(me.network.connections.size, 0, 'out-of-band pipe never became a swarm peer')
})

test('tap: zero footprint when not registered', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'tap-zero')).spec)

  const { data } = await put(me.messages, { text: 'plain' })
  t.is(data.text, 'plain', 'put works')
  t.ok(
    (await get(me.messages)).data.find((r) => r.id === data.id),
    'get works'
  )
  t.is(me.store.listenerCount('apply'), 0, 'no apply listener registered')
})
