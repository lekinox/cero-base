import test from 'brittle'

import { put } from '@cero-base/cero'
import { serve } from '../src/server.js'
import { connect } from '../src/connect.js'
import { loopback, dial } from '../src/transport.js'
import { buildSpec, openCero } from './helpers/index.js'

test('transport: round-trips a get over a real loopback socket', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'tx')).spec)

  const tp = loopback()
  tp.accept((socket) => serve(socket, me))
  const { port } = await tp.ready()
  t.teardown(() => tp.close())

  await put(me.messages, { text: 'over-tcp' })

  const session = await connect(dial({ port }))
  t.teardown(() => session.close())

  const got = await session.get('messages')
  t.ok(
    got.data.find((r) => r.text === 'over-tcp'),
    'round-trips over a real socket'
  )
})

test('transport: a taken port bumps to the next one (no crash)', async (t) => {
  const a = loopback({ port: 0 })
  a.accept(() => {})
  const { port } = await a.ready()
  t.teardown(() => a.close())

  const b = loopback({ port }) // same port — already in use
  b.accept(() => {})
  const got = await b.ready()
  t.teardown(() => b.close())

  t.not(got.port, port, 'did not reuse the taken port')
  t.ok(got.port > 0, 'bound a different free port instead of crashing')
})
