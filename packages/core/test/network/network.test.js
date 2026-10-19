import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import b4a from 'b4a'
import { hash } from 'hypercore-crypto'
import process from 'process'
import { spawn } from 'child_process'

import { Duplex } from 'streamx'
import Protomux from 'protomux'
import c from 'compact-encoding'

import { Network, channelTopic } from '../../src/network/index.js'
import { Database } from '../../src/database/index.js'
import { spec } from '../fixtures/spec/index.js'
import { Identity } from '../../src/identity/index.js'
import {
  makeStore,
  makeNet,
  makePair,
  makeTestnet,
  connectPair,
  waitFor,
  waitForConnection,
  randomTopic,
  once
} from '../helpers/index.js'

test.configure({ timeout: 60000 })

const PEER = new URL('../fixtures/peer.js', import.meta.url).pathname

// ─── channel ──────────────────────────────────────────────────────────────

test('channelTopic: no channel = identity, channel = deterministic salt', (t) => {
  const topic = randomTopic()
  t.alike(channelTopic(topic, null), topic, 'no channel → unchanged')
  t.alike(
    channelTopic(topic, 'dev'),
    hash([topic, b4a.from('dev')]),
    'channel → hash([topic, channel])'
  )
  t.alike(channelTopic(topic, 'dev'), channelTopic(topic, 'dev'), 'same channel → stable')
  t.unlike(channelTopic(topic, 'dev'), channelTopic(topic, 'prod'), 'different channels → differ')
})

test('channel: same channel connects on a shared topic', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await makeNet(t, testnet, { channel: 'dev' })
  const b = await makeNet(t, testnet, { channel: 'dev' })
  await connectPair(t, a, b)
  t.ok(a.connections.size > 0, 'same-channel peers connected')
})

test('channel: different channels stay isolated on the same topic', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await makeNet(t, testnet, { channel: 'dev' })
  const b = await makeNet(t, testnet, { channel: 'prod' })
  const topic = randomTopic()
  const da = a.join(topic)
  const db = b.join(topic)
  await Promise.all([da.flush(), db.flush()])
  await da.activate()
  await db.activate()
  t.teardown(() => Promise.all([da.destroy(), db.destroy()]).catch(() => {}), { order: 2 })
  await t.exception(waitForConnection(a, 5000))
})

// ─── lifecycle ────────────────────────────────────────────────────────────

test('new Network: a store is required', (t) => {
  t.exception.all(() => new Network(), /store is required/)
  t.exception.all(() => new Network({ bootstrap: [] }), /store is required/)
})

test('new Network({ store }) + ready() + close() lifecycle', async (t) => {
  const testnet = await makeTestnet(t)
  const { store } = await makeStore(t)
  const net = new Network({ bootstrap: testnet.bootstrap, store })
  t.is(net.replicator, null, 'replicator not created until ready')
  t.ok(net.wakeup, 'wakeup created in constructor')

  await net.ready()
  t.ok(net.replicator, 'replicator created after ready')
  t.ok(net.wakeup, 'wakeup still present')

  await net.close()
  t.is(net.replicator, null, 'replicator cleared after close')
})

test('ready() is idempotent', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  await net.ready()
  await net.ready()
  t.pass('multiple ready() calls succeed')
})

test('close() is idempotent', async (t) => {
  const testnet = await makeTestnet(t)
  const { store } = await makeStore(t)
  const net = new Network({ bootstrap: testnet.bootstrap, store })
  await net.ready()
  await net.close()
  await net.close()
  t.pass('multiple close() calls succeed')
})

// ─── identity opt ─────────────────────────────────────────────────────────

test('identity opt: the replicator keyPair matches identity publicKey', async (t) => {
  const testnet = await makeTestnet(t)
  const id = await Identity.create()
  const { store } = await makeStore(t)
  const net = new Network({ identity: id, bootstrap: testnet.bootstrap, store })
  await net.ready()
  t.alike(b4a.toBuffer(net.replicator.keyPair.publicKey), b4a.toBuffer(id.publicKey))
  await net.close()
})

test('no identity opt: the replicator derives its own keypair', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  t.is(net.replicator.keyPair.publicKey.length, 32)
})

// ─── join: pinned by default, or in the rotation ──────────────────────────

test('join(topic) pins the topic: it announces and looks up at once', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const topic = randomTopic()
  const discovery = net.join(topic)
  t.is(discovery.state, 'pinned')
  t.is(net.state(topic), 'pinned')
  await discovery.destroy()
  t.is(net.state(topic), null, 'left')
})

test('join(topic, { pin: false }) leaves the topic to the rotation, which has a free slot', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const topic = randomTopic()
  const discovery = net.join(topic, { pin: false })
  t.is(discovery.state, 'inactive', 'nothing until the rotation runs')
  await waitFor(() => discovery.state === 'autostarted')
  t.pass('took a free slot')
  await discovery.destroy()
})

test('join: a topic joined again while its last session leaves comes back', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const topic = randomTopic()
  const first = net.join(topic)
  await first.flush()
  first.destroy() // not awaited: the unannounce is in flight
  const again = net.join(topic)
  t.is(net.state(topic), 'inactive', 'waiting on the leave')
  await again.flush()
  t.is(again.state, 'pinned', 'joined once the old session left')
  await again.destroy()
  t.is(net.state(topic), null)
})

test('join: the same topic twice is one session, held until the last destroy', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const topic = randomTopic()
  const a = net.join(topic)
  const b = net.join(topic)
  t.is(net.replicator.sessions.size, 1, 'one session')
  await a.destroy()
  t.is(net.state(topic), 'pinned', 'b still holds it')
  t.absent(b.destroyed)
  await b.destroy()
  t.is(net.state(topic), null)
  t.is(net.replicator.sessions.size, 0)
})

test('join: invalid topic throws', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  t.exception.all(() => net.join(null), /topic/)
  t.exception.all(() => net.join('not a buffer'), /topic/)
  t.exception.all(() => net.join(b4a.alloc(16)), /topic/)
})

test('join: two peers joining a topic in the same tick meet within seconds', async (t) => {
  const testnet = await makeTestnet(t)
  for (let round = 0; round < 5; round++) {
    const a = await makeNet(t, testnet)
    const b = await makeNet(t, testnet)
    const start = Date.now()
    const topic = randomTopic()
    a.join(topic)
    b.join(topic)
    const met = await waitFor(() => a.connections.size > 0 && b.connections.size > 0, {
      timeout: 8000
    }).catch(() => false)
    t.ok(met, `round ${round}: met in ${Date.now() - start} ms`)
    await Promise.all([a.close(), b.close()])
  }
})

// ─── discovery: activate / deactivate / flush / destroy ───────────────────

test('discovery.activate() pins, deactivate() releases to the rotation', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const topic = randomTopic()
  const discovery = net.join(topic, { pin: false })

  await discovery.activate()
  t.is(discovery.state, 'pinned')

  await discovery.deactivate()
  t.is(discovery.state, 'autostarted', 'released, and the rotation had a slot')

  await discovery.destroy()
})

test('discovery.flush() resolves', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const topic = randomTopic()
  const discovery = net.join(topic)
  await discovery.flush()
  t.pass('flush resolved')
  await discovery.destroy()
})

test('discovery.destroy() is idempotent', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const topic = randomTopic()
  const discovery = net.join(topic)
  await discovery.destroy()
  t.ok(discovery.destroyed)
  await discovery.destroy()
  t.pass('second destroy() did not throw')
})

test('discovery.activate() after destroy throws', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const topic = randomTopic()
  const discovery = net.join(topic)
  await discovery.destroy()
  await t.exception.all(() => discovery.activate(), /destroyed/)
  await t.exception.all(() => discovery.deactivate(), /destroyed/)
})

// ─── peer discovery ───────────────────────────────────────────────────────

test('two active networks on the same topic discover each other', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)
  await connectPair(t, a, b)
  t.pass('peers connected')
})

test('a topic in the rotation announces: a pinned peer reaches it', async (t) => {
  const testnet = await makeTestnet(t)
  const rotated = await makeNet(t, testnet)
  const pinned = await makeNet(t, testnet)
  const topic = randomTopic()
  const inbound = once(rotated, 'connection', 30000)

  const dr = rotated.join(topic, { pin: false })
  await waitFor(() => dr.state === 'autostarted')
  await dr.flush()

  const dp = pinned.join(topic)
  await dp.flush()

  await inbound
  t.pass('reached')

  await dr.destroy()
  await dp.destroy()
})

// ─── events ───────────────────────────────────────────────────────────────

test('connection event fires on peer connect with stream + info', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)

  let aConnArgs = null
  const seen = new Promise((resolve) => {
    a.on('connection', (stream, info) => {
      aConnArgs = { stream, info }
      resolve()
    })
  })

  const topic = randomTopic()
  const da = a.join(topic)
  const db = b.join(topic)
  await Promise.all([da.flush(), db.flush()])
  await da.activate()
  await db.activate()
  await seen

  t.ok(aConnArgs, 'connection event fired')
  t.ok(aConnArgs.stream, 'event includes stream')
  t.ok(aConnArgs.info, 'event includes info')

  await da.destroy()
  await db.destroy()
})

// ─── attach / mirrors ─────────────────────────────────────────────────────

test('channel: leaving a topic removes its swarm discovery — no announce leak', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await makeNet(t, testnet, { channel: 'leak-check' })
  const disc = a.join(randomTopic())
  t.is(a.replicator.sessions.size, 1, 'joined')
  await disc.destroy()
  t.is(a.replicator.sessions.size, 0, 'left — the session is gone, topic unannounced')
})

test('peering(): built once, refused on a closed network', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await makeNet(t, testnet)
  t.is(a.peering(), a.peering(), 'one client per network')
  await a.close()
  t.exception(() => a.peering(), /closed/i, 'no client on a dead swarm')
})

test('attach: a core is required', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  t.exception.all(() => net.attach(null), /required/)
})

test('replicates: the store and its sessions, no other store', async (t) => {
  const { store } = await makeStore(t)
  const { store: other } = await makeStore(t)
  const net = new Network({ store: store.namespace('net') })
  t.ok(net.replicates(store), 'the root')
  t.ok(net.replicates(store.namespace('a').namespace('b')), 'a nested namespace')
  t.absent(net.replicates(other), 'another store')
})

// ─── methods after close ──────────────────────────────────────────────────

test('join after close throws', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  await net.close()
  t.exception.all(() => net.join(randomTopic()), /closed|not ready/)
})

test('close while joined: destroys discoveries', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const d = net.join(randomTopic())
  await net.close()
  t.ok(d.destroyed, 'discovery destroyed by close')
})

// ─── exposed escape hatches ───────────────────────────────────────────────

test('replicator, dht and wakeup are exposed as public properties', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  t.ok(net.replicator, 'replicator exposed')
  t.ok(net.dht, 'dht exposed')
  t.ok(net.wakeup, 'wakeup exposed')
  t.is(typeof net.replicator.join, 'function')
  t.is(typeof net.wakeup.addStream, 'function')
})

// ─── replication ──────────────────────────────────────────────────────────

test('replication: active + active discover each other', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)
  const topic = randomTopic()
  const da = a.join(topic)
  const db = b.join(topic)
  await Promise.all([da.flush(), db.flush()])
  await da.activate()
  await db.activate()
  await Promise.all([waitForConnection(a), waitForConnection(b)])
  t.ok(a.connections.size >= 1, 'a has a peer')
  t.ok(b.connections.size >= 1, 'b has a peer')
  await Promise.all([da.destroy(), db.destroy()])
})

// a core in a's store, and its copy in b's
async function cores(t, a, b, blocks) {
  const writer = a.store.get({ name: 'core' })
  await writer.ready()
  for (const block of blocks) await writer.append(block)
  const reader = b.store.get({ key: writer.key })
  await reader.ready()
  t.teardown(() => Promise.all([writer.close(), reader.close()]).catch(() => {}), { order: 1 })
  return { writer, reader }
}

test('replication: a core in the store replicates between two networks', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)
  const { writer, reader } = await cores(t, a, b, ['alpha', 'beta', 'gamma'])

  await connectPair(t, a, b, writer.discoveryKey)
  await reader.update({ wait: true })

  t.is(reader.length, 3, 'all 3 blocks replicated')
  t.alike(await reader.get(0), b4a.from('alpha'))
  t.alike(await reader.get(2), b4a.from('gamma'))
})

test('replication: a core opened after the connection replicates too', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)
  await connectPair(t, a, b)
  const { reader } = await cores(t, a, b, ['late'])

  await reader.update({ wait: true })
  t.is(reader.length, 1, 'replicated on the open connection')
  t.alike(await reader.get(0), b4a.from('late'))
})

test('replication: each connection replicates the store once', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)
  await connectPair(t, a, b)
  t.is(a.store.streamTracker.records.length, a.connections.size, 'one stream per connection on a')
  t.is(b.store.streamTracker.records.length, b.connections.size, 'and on b')
})

test('replication: wakeup propagates appends to peers', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)
  const { writer, reader } = await cores(t, a, b, ['initial'])

  await connectPair(t, a, b, writer.discoveryKey)
  await reader.update({ wait: true })
  t.is(reader.length, 1, 'initial block replicated')

  // B's length grows without an explicit update
  await writer.append('woke-up')

  await waitFor(() => reader.length >= 2, { timeout: 30000 })
  t.is(reader.length, 2, 'append propagated via wakeup')
  t.alike(await reader.get(1), b4a.from('woke-up'))
})

test('replication: deactivated discovery keeps existing peers', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)
  const { da, db } = await connectPair(t, a, b)
  t.ok(a.connections.size >= 1, 'connected before deactivate')

  await da.deactivate()
  t.not(da.state, 'pinned')

  // existing connection must remain
  t.ok(a.connections.size >= 1, 'existing connection preserved')

  await db.destroy()
})

test('replication: multiple topics on one network do not cross-talk', async (t) => {
  const testnet = await makeTestnet(t)
  // hub joins two topics; peer1 only knows topic1, peer2 only knows topic2
  const hub = await makeNet(t, testnet)
  const peer1 = await makeNet(t, testnet)
  const peer2 = await makeNet(t, testnet)

  const topic1 = randomTopic()
  const topic2 = randomTopic()

  const dhub1 = hub.join(topic1)
  const dhub2 = hub.join(topic2)
  const d1 = peer1.join(topic1)
  const d2 = peer2.join(topic2)

  await Promise.all([dhub1.flush(), dhub2.flush(), d1.flush(), d2.flush()])
  await Promise.all([dhub1.activate(), dhub2.activate(), d1.activate(), d2.activate()])

  await Promise.all([waitForConnection(peer1), waitForConnection(peer2)])

  // peer1 must only have one connection (to hub), not to peer2
  t.is(peer1.connections.size, 1, 'peer1 connected only to hub')
  t.is(peer2.connections.size, 1, 'peer2 connected only to hub')
  t.ok(hub.connections.size >= 2, 'hub connected to both peers')

  await Promise.all([dhub1.destroy(), dhub2.destroy(), d1.destroy(), d2.destroy()])
})

// ─── suspend / resume ─────────────────────────────────────────────────────

test('suspend()/resume(): flips replicator.suspended', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  t.absent(net.suspended, 'starts not suspended')
  t.absent(net.replicator.suspended, 'replicator not suspended')

  await net.suspend()
  t.ok(net.suspended, 'Network reports suspended')
  t.ok(net.replicator.suspended, 'replicator.suspended is true')

  await net.resume()
  t.absent(net.suspended, 'Network reports not suspended')
  t.absent(net.replicator.suspended, 'replicator.suspended is false')
})

test('suspend(): idempotent — second call is a no-op', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  await net.suspend()
  await net.suspend()
  t.ok(net.suspended, 'still suspended after second suspend()')
})

test('resume(): no-op when not suspended', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  await net.resume()
  t.absent(net.suspended)
})

test('suspend(): no-op after close', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  await net.close()
  await net.suspend()
  await net.resume()
  t.pass('suspend/resume after close did not throw')
})

test('suspend() drops live connections; resume() reconnects', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)
  const topic = randomTopic()

  const da = a.join(topic)
  const db = b.join(topic)
  await Promise.all([da.flush(), db.flush()])
  await da.activate()
  await db.activate()
  await Promise.all([waitForConnection(a), waitForConnection(b)])
  t.ok(a.connections.size >= 1, 'a has a live connection before suspend')

  await a.suspend()
  // connections tear down asynchronously after suspend()
  await waitFor(() => a.connections.size === 0, { timeout: 10000 })
  t.is(a.connections.size, 0, 'a has no live connections while suspended')

  await a.resume()
  await waitForConnection(a, 30000)
  t.ok(a.connections.size >= 1, 'a reconnected after resume')

  await da.destroy()
  await db.destroy()
})

// ─── rotation ─────────────────────────────────────────────────────────────

test('rotation: the budget caps what announces, a touch ranks in, a pin never leaves', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet, { presence: { active: 2, idle: 0 } })
  const rep = net.replicator
  const pinned = net.join(randomTopic())
  const rotated = [1, 2, 3, 4].map(() => net.join(randomTopic(), { pin: false }))
  await waitFor(() => rep.activeSessions.length === 3)
  t.alike(
    rotated.map((d) => d.state),
    ['inactive', 'inactive', 'autostarted', 'autostarted'],
    'two slots, the last joined rank first'
  )
  t.is(pinned.state, 'pinned', 'outside the budget')

  rotated[0].touch()
  await waitFor(() => rotated[0].state === 'autostarted')
  t.is(rep.activeSessions.length, 3, 'still two slots and the pin')
  t.is(pinned.state, 'pinned')

  await net.flush({ timeout: 10000 })
  t.ok(rep.announcedSessions.length <= 3, `${rep.announcedSessions.length} announced`)
})

test('rotation: release() ranks a topic last, the next one takes its slot', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet, { presence: { active: 1, idle: 0 } })
  const a = net.join(randomTopic(), { pin: false })
  const b = net.join(randomTopic(), { pin: false })
  await waitFor(() => b.state === 'autostarted')
  t.is(a.state, 'inactive', 'the last joined holds the slot')

  b.release()
  await waitFor(() => a.state === 'autostarted')
  t.is(b.state, 'inactive', 'released')

  b.touch()
  await waitFor(() => b.state === 'autostarted')
  t.is(a.state, 'inactive', 'ranked back in')
})

// ─── offline: a DHT that went away ────────────────────────────────────────

test('close() settles when the DHT is gone', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  await net.join(randomTopic()).flush()
  await testnet.destroy()
  const start = Date.now()
  await net.close()
  t.ok(Date.now() - start < 3000, `closed in ${Date.now() - start} ms`)
})

test('resume() and flush() settle when the DHT is gone', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  await net.join(randomTopic()).flush()
  await net.suspend()
  await testnet.destroy()
  const start = Date.now()
  await net.resume()
  await net.flush({ timeout: 10000 })
  t.absent(net.suspended, `resumed in ${Date.now() - start} ms`)
})

test('a topic leaving while offline does not break the resume re-lookup', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const keep = net.join(randomTopic())
  const leaving = net.join(randomTopic())
  await Promise.all([keep.flush(), leaving.flush()])
  leaving.destroy() // not awaited: its session is gone from the entry while the unannounce runs
  t.execution(() => net._lookup(), 'the re-lookup skips a topic that is leaving')
})

test('resume() with a leave in flight resumes the network', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const keep = net.join(randomTopic())
  const leaving = net.join(randomTopic())
  await Promise.all([keep.flush(), leaving.flush()])
  // offline, so the suspend-time unannounce fails and the leave has one to run at resume
  await Promise.all(testnet.nodes.map((node) => node.suspend()))
  await net.suspend()
  leaving.destroy()
  await net.resume()
  await Promise.all(testnet.nodes.map((node) => node.resume()))
  t.absent(net.suspended, 'resumed')
  t.ok(net.replicator._refreshInterval, 'the rotation runs again')
  await net.flush({ timeout: 5000 })
  t.is(keep.state, 'pinned', 'the kept topic is back')
})

test('ten quick suspend/resume rounds end connected, nobody banned', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)
  await connectPair(t, a, b)
  const start = Date.now()
  for (let i = 0; i < 10; i++) {
    await a.suspend()
    await a.resume()
    await Promise.all([waitForConnection(a), waitForConnection(b)])
  }
  t.is(a.replicator.stats.bannedPeers, 0, `a banned nobody, ${Date.now() - start} ms`)
  t.is(b.replicator.stats.bannedPeers, 0, 'b banned nobody')
})

// ─── dead connections, silent nodes, lost peers ───────────────────────────

test('a connection the remote never answers on is dropped within seconds', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const args = [PEER, await t.tmp(), JSON.stringify(testnet.bootstrap), b4a.toString(topic, 'hex')]
  const peer = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] })
  t.teardown(() => process.kill(peer.pid, 'SIGKILL'))
  await new Promise((resolve) => {
    peer.stdout.on('data', (data) => b4a.toString(data).includes('ready') && resolve())
  })

  const net = await makeNet(t, testnet)
  // frozen the moment we connect: our header goes out, nothing ever comes back
  const opened = new Promise((resolve) => {
    net.once('connection', (conn) => {
      process.kill(peer.pid, 'SIGSTOP')
      resolve(conn)
    })
  })
  net.join(topic)
  const conn = await opened
  const start = Date.now()
  const dropped = await waitFor(() => conn.destroyed, { timeout: 9000 }).catch(() => false)
  t.ok(dropped, `dropped in ${Date.now() - start} ms`)
})

test('a DHT node that stops answering costs a lookup about a second', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  await net.join(randomTopic()).flush()
  await testnet.nodes[1].destroy()
  const start = Date.now()
  await net.join(randomTopic()).flush()
  t.ok(Date.now() - start < 2000, `looked up in ${Date.now() - start} ms`)
})

// one dial by key: the stream once it opens, false while the peer is not announced yet
function dial(dht, key) {
  const conn = dht.connect(key)
  conn.on('error', () => {})
  return new Promise((resolve) => {
    conn.once('open', () => resolve(conn))
    conn.once('close', () => resolve(false))
  })
}

test(
  'back online after an outage, a device is reachable by its key within seconds',
  { timeout: 150000 },
  async (t) => {
    const outage = await createTestnet(3, t)
    const port = outage.bootstrap[0].port
    const a = await makeNet(t, outage)
    await a.join(randomTopic()).flush()
    await outage.destroy()
    // the dht calls itself offline only from timeouts it counts: keep using the network while it is down
    const joins = setInterval(() => a.join(randomTopic()), 1000)
    t.teardown(() => clearInterval(joins))
    // setup, not what is tested: under load the dht takes longer to count itself offline
    const offline = await waitFor(() => !a.dht.online, { timeout: 90000 }).catch(() => false)
    t.ok(offline, 'offline')

    // the router is back: fresh nodes at the same bootstrap address, holding nothing about a
    const back = await createTestnet(3, { port, teardown: (fn, opts) => t.teardown(fn, opts) })
    const online = await waitFor(() => a.dht.online, { timeout: 30000 }).catch(() => false)
    t.ok(online, 'online again')
    clearInterval(joins)

    const b = await makeNet(t, back)
    const start = Date.now()
    const conn = await waitFor(() => dial(b.dht, a.replicator.keyPair.publicKey), {
      timeout: 15000
    }).catch(() => null)
    t.ok(conn, `reached in ${Date.now() - start} ms`)
    conn?.destroy()
  }
)

test('a dropped connection is redialed within seconds', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b } = await makePair(t, testnet)
  await connectPair(t, a, b)
  const [conn] = a.connections
  conn.destroy()
  const start = Date.now()
  const back = await waitFor(() => a.connections.size > 0 && !a.connections.has(conn), {
    timeout: 10000
  }).catch(() => false)
  t.ok(back, `back in ${Date.now() - start} ms`)
})

test('a lookup that failed at resume is retried within seconds', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await makeNet(t, testnet)
  const b = await makeNet(t, testnet)
  const topic = randomTopic()
  const da = a.join(topic)
  const db = b.join(topic)
  await Promise.all([da.flush(), db.flush()])
  await Promise.all([waitForConnection(a), waitForConnection(b)])
  await a.suspend()
  // the device resumes before the network is back: its first lookup and announce fail
  await Promise.all(testnet.nodes.map((node) => node.suspend()))
  await a.resume()
  await a.flush({ timeout: 10000 })
  await Promise.all(testnet.nodes.map((node) => node.resume()))
  const start = Date.now()
  const found = await waitFor(() => a.connections.size > 0 && b.connections.size > 0, {
    timeout: 15000
  }).catch(() => false)
  t.ok(found, `found again in ${Date.now() - start} ms`)
})

// ─── inject: externally-established connections (design: bluetooth P1) ──────

function duplexPair() {
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

// two networks on testnets that never meet: only an injected pipe connects them
async function isolated(t) {
  const { store: storeA } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const { store: storeB } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const netA = new Network({ bootstrap: (await createTestnet(2, t)).bootstrap, store: storeA })
  const netB = new Network({ bootstrap: (await createTestnet(2, t)).bootstrap, store: storeB })
  await netA.ready()
  await netB.ready()
  t.teardown(() => Promise.all([netA.close(), netB.close()]).catch(() => {}), { order: 9 })
  return { netA, netB, storeA, storeB }
}

test('inject: the injected stream replicates the store, once', async (t) => {
  const { netA, netB } = await isolated(t)
  const { reader } = await cores(t, netA, netB, ['over', 'the', 'link'])

  const [s1, s2] = duplexPair()
  netA.inject(s1, { isInitiator: true })
  netB.inject(s2, { isInitiator: false })

  await reader.update({ wait: true })
  t.is(reader.length, 3, 'a core of the store crossed the injected link')
  t.alike(await reader.get(2), b4a.from('link'))
  t.is(netA.store.streamTracker.records.length, 1, 'one replication stream for the one link')
})

test('inject: replication + writer admission over an injected duplex, no shared DHT', async (t) => {
  const { netA, netB, storeA, storeB } = await isolated(t)
  const idA = await Identity.create()
  const idB = await Identity.create()

  const a = new Database({
    store: storeA,
    identity: idA,
    network: netA,
    spec,
    encryptionKey: Identity.randomBytes(32)
  })
  await a.ready()
  await a.bootstrap({ name: 'a' })
  const b = new Database({
    store: storeB,
    identity: idB,
    network: netB,
    spec,
    key: a.key,
    encryptionKey: a.encryptionKey
  })
  await b.ready()
  t.teardown(() => Promise.all([a.close(), b.close()]).catch(() => {}), { order: 5 })

  const [s1, s2] = duplexPair()
  netA.inject(s1, { isInitiator: true })
  netB.inject(s2, { isInitiator: false })

  const { data: row } = await a.put('messages', { text: 'over-the-pipe' })
  const onB = await waitFor(async () => (await b.get('messages', row.id)).data)
  t.is(onB.text, 'over-the-pipe', 'A row replicated to B over the injected stream')

  t.is(b.writable, false, 'B is not a writer yet — guards intact')

  await a.addWriter(b.keyPair.publicKey)
  await waitFor(() => b.writable)
  t.ok(b.writable, 'admission replicated over the injected stream (wakeup working)')

  const { data: back } = await b.put('messages', { text: 'reply' })
  const onA = await waitFor(async () => (await a.get('messages', back.id)).data)
  t.is(onA.text, 'reply', 'B writes converge back on A')
})

test('inject: a database opened after the injected connection still replicates', async (t) => {
  const { netA, netB, storeA, storeB } = await isolated(t)
  const [s1, s2] = duplexPair()
  netA.inject(s1, { isInitiator: true })
  netB.inject(s2, { isInitiator: false })
  t.is(netA.connections.size, 1, 'injected link counted as a connection')

  const idA = await Identity.create()
  const idB = await Identity.create()

  const a = new Database({
    store: storeA,
    identity: idA,
    network: netA,
    spec,
    encryptionKey: Identity.randomBytes(32)
  })
  await a.ready()
  await a.bootstrap({ name: 'a' })
  const b = new Database({
    store: storeB,
    identity: idB,
    network: netB,
    spec,
    key: a.key,
    encryptionKey: a.encryptionKey
  })
  await b.ready()
  t.teardown(() => Promise.all([a.close(), b.close()]).catch(() => {}), { order: 5 })

  const { data: row } = await a.put('messages', { text: 'late-attach' })
  const onB = await waitFor(async () => (await b.get('messages', row.id)).data)
  t.is(onB.text, 'late-attach', 'the store reached the pre-existing injected link')
})
