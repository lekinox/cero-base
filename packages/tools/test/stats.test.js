import test from 'brittle'
import { stats } from '../src/stats.js'
import { buildSpec, openCero } from './helpers/index.js'

test('stats(handle): read-only snapshot of a live cero instance', async (t) => {
  const me = await openCero(t, (await buildSpec(t, 'stats-live')).spec)
  const s = stats(me, 123)
  t.is(s.handleId, me.id, 'tags the handle')
  t.is(typeof s.network.connections, 'number', 'reads network.connections.size')
  t.is(typeof s.network.peers, 'number', 'reads network.peers.size')
  t.is(typeof s.bee.local, 'number', 'reads bee.local.length')
  t.ok(Array.isArray(s.cores), 'cores is an array of per-core counters')
  t.is(s.at, 123, 'carries the sample timestamp')
})

test('stats(handle): tolerates a bare handle without throwing', async (t) => {
  const s = stats({ id: 'x' })
  t.is(s.handleId, 'x')
  t.is(s.network.connections, 0)
  t.is(s.network.peers, 0)
  t.is(s.bee.local, 0)
  t.alike(s.cores, [])
})
