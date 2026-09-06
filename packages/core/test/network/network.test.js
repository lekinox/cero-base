import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import b4a from 'b4a'
import Hypercore from 'hypercore'
import { hash } from 'hypercore-crypto'

import { Duplex } from 'streamx'

import { Network, channelTopic } from '../../src/network/index.js'
import { Database } from '../../src/database/index.js'
import { spec } from '../fixtures/spec/index.js'
import { Identity } from '../../src/identity/index.js'
import {
  makeStore,
  makeNet as makeNetBase,
  makePair as makePairBase,
  connectPair,
  waitFor,
  waitForConnection,
  randomTopic,
  once
} from '../helpers/index.js'

test.configure({ timeout: 60000 })

const testnet = await createTestnet(3)

const makeNet = (t, opts = {}) => makeNetBase(t, testnet, opts)
const makePair = (t) => makePairBase(t, testnet)

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
  const a = await makeNet(t, { channel: 'dev' })
  const b = await makeNet(t, { channel: 'dev' })
  await connectPair(t, a, b)
  t.ok(a.connections.size > 0, 'same-channel peers connected')
})

test('channel: different channels stay isolated on the same topic', async (t) => {
  const a = await makeNet(t, { channel: 'dev' })
  const b = await makeNet(t, { channel: 'prod' })
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

test('new Network({}) + ready() + close() lifecycle', async (t) => {
  const net = new Network({ bootstrap: testnet.bootstrap })
  t.is(net.swarm, null, 'swarm not created until ready')
  t.ok(net.wakeup, 'wakeup created in constructor')

  await net.ready()
  t.ok(net.swarm, 'swarm created after ready')
  t.ok(net.wakeup, 'wakeup still present')

  await net.close()
  t.is(net.swarm, null, 'swarm cleared after close')
})

test('ready() is idempotent', async (t) => {
  const net = await makeNet(t)
  await net.ready()
  await net.ready()
  t.pass('multiple ready() calls succeed')
})

test('close() is idempotent', async (t) => {
  const net = new Network({ bootstrap: testnet.bootstrap })
  await net.ready()
  await net.close()
  await net.close()
  t.pass('multiple close() calls succeed')
})

// ─── identity opt ─────────────────────────────────────────────────────────

test('identity opt: swarm keyPair matches identity publicKey', async (t) => {
  const id = await Identity.generate()
  const net = new Network({ identity: id, bootstrap: testnet.bootstrap })
  await net.ready()
  t.alike(b4a.toBuffer(net.swarm.keyPair.publicKey), b4a.toBuffer(id.publicKey))
  await net.close()
})

test('no identity opt: swarm generates its own keypair', async (t) => {
  const net = await makeNet(t)
  t.is(net.swarm.keyPair.publicKey.length, 32)
})

// ─── join: defaults to active ─────────────────────────────────────────────

test('join(topic) defaults to mode active', async (t) => {
  const net = await makeNet(t)
  const topic = randomTopic()
  const discovery = net.join(topic)
  t.is(discovery.mode, 'active')
  await discovery.destroy()
})

test('join(topic, { mode: passive }) honors mode', async (t) => {
  const net = await makeNet(t)
  const topic = randomTopic()
  const discovery = net.join(topic, { mode: 'passive' })
  t.is(discovery.mode, 'passive')
  await discovery.destroy()
})

test('join: invalid mode throws', async (t) => {
  const net = await makeNet(t)
  const topic = randomTopic()
  t.exception.all(() => net.join(topic, { mode: 'weird' }), /mode must be/)
  t.exception.all(() => net.join(topic, { mode: '' }), /mode must be/)
  t.exception.all(() => net.join(topic, { mode: null }), /mode must be/)
})

test('join: invalid topic throws', async (t) => {
  const net = await makeNet(t)
  t.exception.all(() => net.join(null), /topic/)
  t.exception.all(() => net.join('not a buffer'), /topic/)
  t.exception.all(() => net.join(b4a.alloc(16)), /topic/)
})

// ─── discovery: activate / deactivate / flush / destroy ───────────────────

test('discovery.activate() / deactivate() change mode', async (t) => {
  const net = await makeNet(t)
  const topic = randomTopic()
  const discovery = net.join(topic, { mode: 'passive' })
  t.is(discovery.mode, 'passive')

  await discovery.activate()
  t.is(discovery.mode, 'active')

  await discovery.deactivate()
  t.is(discovery.mode, 'passive')

  await discovery.destroy()
})

test('discovery.flush() resolves', async (t) => {
  const net = await makeNet(t)
  const topic = randomTopic()
  const discovery = net.join(topic)
  await discovery.flush()
  t.pass('flush resolved')
  await discovery.destroy()
})

test('discovery.destroy() is idempotent', async (t) => {
  const net = await makeNet(t)
  const topic = randomTopic()
  const discovery = net.join(topic)
  await discovery.destroy()
  t.ok(discovery.destroyed)
  await discovery.destroy()
  t.pass('second destroy() did not throw')
})

test('discovery.activate() after destroy throws', async (t) => {
  const net = await makeNet(t)
  const topic = randomTopic()
  const discovery = net.join(topic)
  await discovery.destroy()
  await t.exception.all(() => discovery.activate(), /destroyed/)
  await t.exception.all(() => discovery.deactivate(), /destroyed/)
})

// ─── peer discovery ───────────────────────────────────────────────────────

test('two active networks on the same topic discover each other', async (t) => {
  const { a, b } = await makePair(t)
  await connectPair(t, a, b)
  t.pass('peers connected')
})

test('passive peer is reachable by an active peer', async (t) => {
  const passive = await makeNet(t)
  const active = await makeNet(t)
  const topic = randomTopic()
  const passiveConn = once(passive, 'connection', 30000)

  const dp = passive.join(topic, { mode: 'passive' })
  await dp.flush()

  const da = active.join(topic)
  await da.flush()
  await da.activate()

  await passiveConn
  t.pass('passive peer was reached by active peer')

  await dp.destroy()
  await da.destroy()
})

// ─── events ───────────────────────────────────────────────────────────────

test('connection event fires on peer connect with stream + info', async (t) => {
  const { a, b } = await makePair(t)

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

// ─── attach / detach ──────────────────────────────────────────────────────

test('channel: leaving a topic removes its swarm discovery — no announce leak', async (t) => {
  const a = await makeNet(t, { channel: 'leak-check' })
  const disc = a.join(randomTopic())
  t.is(a.swarm._discovery.size, 1, 'joined')
  await disc.destroy()
  t.is(a.swarm._discovery.size, 0, 'left — the discovery entry is gone, topic unannounced')
})

test('blind(): refuses on a closed network', async (t) => {
  const a = await makeNet(t)
  await a.close()
  await t.exception(a.blind(), /closed/i, 'no BlindPairing is built on a dead swarm')
})

test('attach/detach: no errors and idempotent', async (t) => {
  const net = await makeNet(t)
  const fake = { replicate() {} }
  net.attach(fake)
  net.attach(fake) // duplicate add — set dedupe
  net.detach(fake)
  net.detach(fake) // already gone — no throw
  t.pass('attach/detach are safe to call repeatedly')
})

test('attach: invalid input throws', async (t) => {
  const net = await makeNet(t)
  t.exception.all(() => net.attach(null), /required/)
  t.exception.all(() => net.detach(null), /required/)
})

test('attach: calls replicate(stream) on each current peer', async (t) => {
  const { a, b } = await makePair(t)
  await connectPair(t, a, b)

  let called = 0
  const fake = {
    replicate(stream) {
      called++
      t.ok(stream, 'got a stream')
    }
  }
  a.attach(fake)
  t.ok(called >= 1, 'replicate called for the existing peer')
  t.is(called, a.connections.size, 'replicate called once per current peer connection')
})

test('attach: calls replicate(stream) on new peer connection', async (t) => {
  const { a, b } = await makePair(t)

  let called = 0
  const fake = {
    replicate() {
      called++
    }
  }
  a.attach(fake)
  t.is(called, 0, 'no peers yet')

  await connectPair(t, a, b)
  t.ok(called >= 1, 'replicate called for the new peer')
})

// ─── replicate(target) ────────────────────────────────────────────────────

test('replicate: fans replicate(stream) to all current peers', async (t) => {
  const { a, b } = await makePair(t)
  await connectPair(t, a, b)

  let called = 0
  const fake = {
    replicate() {
      called++
    }
  }
  a.replicate(fake)
  t.ok(called >= 1, 'fanned to at least one peer')
  t.is(called, a.connections.size, 'fanned once per current peer connection')
})

test('replicate: rejects targets without a replicate method', async (t) => {
  const net = await makeNet(t)
  t.exception.all(() => net.replicate(null), /replicate/)
  t.exception.all(() => net.replicate({}), /replicate/)
  t.exception.all(() => net.replicate({ replicate: 'not a fn' }), /replicate/)
})

// ─── hypercore end-to-end smoke ───────────────────────────────────────────

test('end-to-end: replicate a hypercore between two networks via attach', async (t) => {
  const { a, b } = await makePair(t)

  const dirA = await t.tmp()
  const dirB = await t.tmp()

  const coreA = new Hypercore(dirA)
  await coreA.ready()
  await coreA.append('hello')
  await coreA.append('world')

  const coreB = new Hypercore(dirB, coreA.key)
  await coreB.ready()
  t.teardown(() => Promise.all([coreA.close(), coreB.close()]).catch(() => {}), { order: 1 })

  a.attach(coreA)
  b.attach(coreB)

  await connectPair(t, a, b, coreA.discoveryKey)

  await coreB.update({ wait: true })
  t.is(coreB.length, 2, 'replicated 2 blocks')
  t.alike(await coreB.get(0), b4a.from('hello'))
  t.alike(await coreB.get(1), b4a.from('world'))
})

// ─── methods after close ──────────────────────────────────────────────────

test('join after close throws', async (t) => {
  const net = new Network({ bootstrap: testnet.bootstrap })
  await net.ready()
  await net.close()
  t.exception.all(() => net.join(randomTopic()), /closed|not ready/)
})

test('close while joined: destroys discoveries', async (t) => {
  const net = new Network({ bootstrap: testnet.bootstrap })
  await net.ready()
  const d = net.join(randomTopic())
  await net.close()
  t.ok(d.destroyed, 'discovery destroyed by close')
})

// ─── exposed escape hatches ───────────────────────────────────────────────

test('swarm and wakeup are exposed as public properties', async (t) => {
  const net = await makeNet(t)
  t.ok(net.swarm, 'swarm exposed')
  t.ok(net.wakeup, 'wakeup exposed')
  t.is(typeof net.swarm.join, 'function')
  t.is(typeof net.wakeup.addStream, 'function')
})

// ─── replication ──────────────────────────────────────────────────────────

test('replication: active + active discover each other', async (t) => {
  const { a, b } = await makePair(t)
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

test('replication: passive announces, active connects in', async (t) => {
  const passive = await makeNet(t)
  const active = await makeNet(t)
  const topic = randomTopic()

  const inbound = once(passive, 'connection', 30000)

  const dp = passive.join(topic, { mode: 'passive' })
  await dp.flush()

  const da = active.join(topic)
  await da.flush()
  await da.activate()

  const [stream] = await Promise.all([inbound])
  t.ok(stream, 'passive received an inbound stream')
  t.is(passive.connections.size, 1, 'passive has one connection')

  await dp.destroy()
  await da.destroy()
})

test('replication: two active networks replicate a hypercore', async (t) => {
  const { a, b } = await makePair(t)

  const dirA = await t.tmp()
  const dirB = await t.tmp()

  const coreA = new Hypercore(dirA)
  await coreA.ready()
  await coreA.append('alpha')
  await coreA.append('beta')
  await coreA.append('gamma')

  const coreB = new Hypercore(dirB, coreA.key)
  await coreB.ready()
  t.teardown(() => Promise.all([coreA.close(), coreB.close()]).catch(() => {}), { order: 1 })

  a.attach(coreA)
  b.attach(coreB)

  await connectPair(t, a, b, coreA.discoveryKey)
  await coreB.update({ wait: true })

  t.is(coreB.length, 3, 'all 3 blocks replicated')
  t.alike(await coreB.get(0), b4a.from('alpha'))
  t.alike(await coreB.get(2), b4a.from('gamma'))
})

test('replication: replicate(target) fans to every peer stream', async (t) => {
  const a = await makeNet(t)
  const b = await makeNet(t)
  const c = await makeNet(t)
  const topic = randomTopic()

  const da = a.join(topic)
  const db = b.join(topic)
  const dc = c.join(topic)
  await Promise.all([da.flush(), db.flush(), dc.flush()])
  await Promise.all([da.activate(), db.activate(), dc.activate()])

  await waitFor(() => a.connections.size >= 2, { timeout: 30000 })
  t.is(a.connections.size, 2, 'A is connected to B and C')

  const seenStreams = new Set()
  const fake = {
    replicate(stream) {
      seenStreams.add(stream)
    }
  }
  a.replicate(fake)

  t.is(seenStreams.size, 2, 'replicate fanned to both peer streams')
  for (const stream of a.connections) {
    t.ok(seenStreams.has(stream), 'received this peer stream')
  }

  await Promise.all([da.destroy(), db.destroy(), dc.destroy()])
})

test('replication: attach AFTER peers already connected', async (t) => {
  const { a, b } = await makePair(t)
  await connectPair(t, a, b)

  const dirA = await t.tmp()
  const dirB = await t.tmp()

  const coreA = new Hypercore(dirA)
  await coreA.ready()
  await coreA.append('late-attach')

  const coreB = new Hypercore(dirB, coreA.key)
  await coreB.ready()
  t.teardown(() => Promise.all([coreA.close(), coreB.close()]).catch(() => {}), { order: 1 })

  // attach happens AFTER the peer connection
  a.attach(coreA)
  b.attach(coreB)

  await coreB.update({ wait: true })
  t.is(coreB.length, 1, 'replicated after late attach')
  t.alike(await coreB.get(0), b4a.from('late-attach'))
})

test('replication: attach BEFORE peers connect', async (t) => {
  const a = await makeNet(t)
  const b = await makeNet(t)

  const dirA = await t.tmp()
  const dirB = await t.tmp()

  const coreA = new Hypercore(dirA)
  await coreA.ready()
  await coreA.append('early-attach')

  const coreB = new Hypercore(dirB, coreA.key)
  await coreB.ready()
  t.teardown(() => Promise.all([coreA.close(), coreB.close()]).catch(() => {}), { order: 1 })

  // attach BEFORE joining the swarm
  a.attach(coreA)
  b.attach(coreB)

  await connectPair(t, a, b, coreA.discoveryKey)
  await coreB.update({ wait: true })

  t.is(coreB.length, 1, 'replicated for new connection')
  t.alike(await coreB.get(0), b4a.from('early-attach'))
})

test('replication: detach stops further replication', async (t) => {
  const { a, b } = await makePair(t)

  const dirA = await t.tmp()
  const dirB = await t.tmp()

  const coreA = new Hypercore(dirA)
  await coreA.ready()
  await coreA.append('one')

  const coreB = new Hypercore(dirB, coreA.key)
  await coreB.ready()
  t.teardown(() => Promise.all([coreA.close(), coreB.close()]).catch(() => {}), { order: 1 })

  a.attach(coreA)
  b.attach(coreB)

  await connectPair(t, a, b, coreA.discoveryKey)
  await coreB.update({ wait: true })
  t.is(coreB.length, 1, 'initial block replicated')

  // detach on both ends — new writes should not propagate via new wiring
  a.detach(coreA)
  b.detach(coreB)

  // simulate a fresh peer connection where coreA is no longer attached
  const c = await makeNet(t)
  const dirC = await t.tmp()
  const coreC = new Hypercore(dirC, coreA.key)
  await coreC.ready()
  t.teardown(() => coreC.close().catch(() => {}), { order: 1 })

  await coreA.append('two')
  await connectPair(t, a, c, coreA.discoveryKey)

  // coreC must NOT replicate because A detached coreA — wait briefly then check
  try {
    await coreC.update({ wait: true, timeout: 1500 })
  } catch {}
  t.is(coreC.length, 0, 'detached core did not replicate to new peer')
})

test('replication: wakeup propagates appends to peers', async (t) => {
  const { a, b } = await makePair(t)

  const dirA = await t.tmp()
  const dirB = await t.tmp()

  const coreA = new Hypercore(dirA)
  await coreA.ready()
  await coreA.append('initial')

  const coreB = new Hypercore(dirB, coreA.key)
  await coreB.ready()
  t.teardown(() => Promise.all([coreA.close(), coreB.close()]).catch(() => {}), { order: 1 })

  a.attach(coreA)
  b.attach(coreB)

  await connectPair(t, a, b, coreA.discoveryKey)
  await coreB.update({ wait: true })
  t.is(coreB.length, 1, 'initial block replicated')

  // now append on A — wakeup should make B's length grow without an explicit update
  await coreA.append('woke-up')

  await waitFor(() => coreB.length >= 2, { timeout: 30000 })
  t.is(coreB.length, 2, 'append propagated via wakeup')
  t.alike(await coreB.get(1), b4a.from('woke-up'))
})

test('replication: passive discovery upgraded via activate() connects to peers', async (t) => {
  const a = await makeNet(t)
  const b = await makeNet(t)
  const topic = randomTopic()

  const da = a.join(topic, { mode: 'passive' })
  const db = b.join(topic)
  await Promise.all([da.flush(), db.flush()])
  await db.activate()

  // a is passive — it doesn't actively dial b. No guarantee of connection.
  t.is(da.mode, 'passive')

  // upgrade a to active
  await da.activate()
  t.is(da.mode, 'active')

  await Promise.all([waitForConnection(a), waitForConnection(b)])
  t.ok(a.connections.size >= 1, 'a connected after activate()')

  await da.destroy()
  await db.destroy()
})

test('replication: deactivated discovery keeps existing peers', async (t) => {
  const { a, b } = await makePair(t)
  const { da, db } = await connectPair(t, a, b)
  t.ok(a.connections.size >= 1, 'connected before deactivate')

  await da.deactivate()
  t.is(da.mode, 'passive')

  // existing connection must remain
  t.ok(a.connections.size >= 1, 'existing connection preserved')

  await db.destroy()
})

test('replication: multiple topics on one network do not cross-talk', async (t) => {
  // hub joins two topics; peer1 only knows topic1, peer2 only knows topic2
  const hub = await makeNet(t)
  const peer1 = await makeNet(t)
  const peer2 = await makeNet(t)

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

test('suspend()/resume(): flips swarm.suspended', async (t) => {
  const net = await makeNet(t)
  t.absent(net.suspended, 'starts not suspended')
  t.absent(net.swarm.suspended, 'swarm not suspended')

  await net.suspend()
  t.ok(net.suspended, 'Network reports suspended')
  t.ok(net.swarm.suspended, 'swarm.suspended is true')

  await net.resume()
  t.absent(net.suspended, 'Network reports not suspended')
  t.absent(net.swarm.suspended, 'swarm.suspended is false')
})

test('suspend(): idempotent — second call is a no-op', async (t) => {
  const net = await makeNet(t)
  await net.suspend()
  await net.suspend()
  t.ok(net.suspended, 'still suspended after second suspend()')
})

test('resume(): no-op when not suspended', async (t) => {
  const net = await makeNet(t)
  await net.resume()
  t.absent(net.suspended)
})

test('suspend(): no-op after close', async (t) => {
  const net = new Network({ bootstrap: testnet.bootstrap })
  await net.ready()
  await net.close()
  await net.suspend()
  await net.resume()
  t.pass('suspend/resume after close did not throw')
})

test('suspend() drops live connections; resume() reconnects', async (t) => {
  const { a, b } = await makePair(t)
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

// ─── info: self-declared peer info over connections ──────────────────────

test('info: peers exchange self-declared info over connections', async (t) => {
  const a = await makeNet(t, { channel: 'dev' })
  const b = await makeNet(t, { channel: 'dev' })
  a.setInfo({ name: 'Ada' })
  b.setInfo({ name: 'Bo' })
  await connectPair(t, a, b)
  const aHex = b4a.toString(a.swarm.keyPair.publicKey, 'hex')
  const bHex = b4a.toString(b.swarm.keyPair.publicKey, 'hex')
  await waitFor(() => a.getInfo(bHex) && b.getInfo(aHex))
  t.is(a.getInfo(bHex).name, 'Bo', "a sees b's declared name")
  t.is(b.getInfo(aHex).name, 'Ada', "b sees a's declared name")
})

test('info: setInfo after connect reaches live peers', async (t) => {
  const a = await makeNet(t, { channel: 'dev' })
  const b = await makeNet(t, { channel: 'dev' })
  await connectPair(t, a, b)
  a.setInfo({ name: 'Late' })
  const aHex = b4a.toString(a.swarm.keyPair.publicKey, 'hex')
  await waitFor(() => b.getInfo(aHex))
  t.is(b.getInfo(aHex).name, 'Late', 'late info still delivered')
})

// ─── teardown shared testnet ──────────────────────────────────────────────

test('teardown shared testnet', async (t) => {
  await testnet.destroy()
  t.pass('testnet destroyed')
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

test('inject: replication + writer admission over an injected duplex, no shared DHT', async (t) => {
  // two SEPARATE testnets — the DHTs can never meet; only the injected pipe connects them
  const netA = new Network({ bootstrap: (await createTestnet(2, t)).bootstrap })
  const netB = new Network({ bootstrap: (await createTestnet(2, t)).bootstrap })
  await netA.ready()
  await netB.ready()
  t.teardown(() => Promise.all([netA.close(), netB.close()]).catch(() => {}), { order: 9 })

  const idA = await Identity.generate()
  const idB = await Identity.generate()
  const { store: storeA } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const { store: storeB } = await makeStore(t, { columnFamilies: ['cero/local'] })

  const a = new Database({ store: storeA, identity: idA, network: netA, spec })
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
  const onB = await waitUntil(async () => (await b.get('messages', row.id)).data)
  t.is(onB.text, 'over-the-pipe', 'A row replicated to B over the injected stream')

  t.is(b.writable, false, 'B is not a writer yet — guards intact')

  await a.addWriter(b.keyPair.publicKey)
  await waitUntil(() => b.writable)
  t.ok(b.writable, 'admission replicated over the injected stream (wakeup working)')

  const { data: back } = await b.put('messages', { text: 'reply' })
  const onA = await waitUntil(async () => (await a.get('messages', back.id)).data)
  t.is(onA.text, 'reply', 'B writes converge back on A')
})

test('inject: a core attached AFTER the injected connection still replicates', async (t) => {
  const netA = new Network({ bootstrap: (await createTestnet(2, t)).bootstrap })
  const netB = new Network({ bootstrap: (await createTestnet(2, t)).bootstrap })
  await netA.ready()
  await netB.ready()
  t.teardown(() => Promise.all([netA.close(), netB.close()]).catch(() => {}), { order: 9 })

  const [s1, s2] = duplexPair()
  netA.inject(s1, { isInitiator: true })
  netB.inject(s2, { isInitiator: false })
  t.is(netA.connections.size, 1, 'injected link counted as a connection')

  const idA = await Identity.generate()
  const idB = await Identity.generate()
  const { store: storeA } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const { store: storeB } = await makeStore(t, { columnFamilies: ['cero/local'] })

  const a = new Database({ store: storeA, identity: idA, network: netA, spec })
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
  const onB = await waitUntil(async () => (await b.get('messages', row.id)).data)
  t.is(onB.text, 'late-attach', 'attach() reached the pre-existing injected link')
})

async function waitUntil(fn, { timeout = 15000, interval = 50 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('waitUntil: condition not met before timeout')
}
