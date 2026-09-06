import test from 'brittle'

import { cero, put, get, open as openRef } from '../../src/index.js'
import { Bluetooth } from '../../src/lib/bluetooth.js'
import { spec } from '../fixtures/spec/index.js'
import { makeTestnet, waitUntil } from '../helpers/index.js'
import { makeMockBluetooth, makeStateBackend } from 'ble-swarm/mock.js'

test.configure({ timeout: 90000 })

async function open(t, opts = {}) {
  const testnet = opts.testnet || (await makeTestnet(t))
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap, ...opts })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return me
}

test('no backend → me.bluetooth.state is unsupported, start() is a safe no-op', async (t) => {
  const me = await open(t, { bluetooth: false })
  const bt = new Bluetooth(me, { backend: null })
  await bt.ready()
  t.is(bt.state, 'unsupported', 'absent backend reported, not crashed')
  await bt.start() // must not throw
  t.is(bt.state, 'unsupported')
  await bt.close()
})

test('bluetooth: true auto-starts and reaches "on" when the adapter is powered', async (t) => {
  const me = await open(t, { bluetooth: { backend: makeMockBluetooth() } })
  t.ok(me.bluetooth, 'facade attached')
  t.is(me.bluetooth.state, 'on', 'advertising + scanning')
  t.is(me.bluetooth.peers.size, 0, 'no peers alone')
})

test('adapter powered off → state waiting, not on', async (t) => {
  const me = await open(t, { bluetooth: { backend: makeStateBackend('poweredOff') } })
  t.is(me.bluetooth.state, 'waiting', 'waits for the adapter')
})

test('adapter unauthorized → state surfaced, never silent', async (t) => {
  const me = await open(t, { bluetooth: { backend: makeStateBackend('unauthorized') } })
  t.is(me.bluetooth.state, 'unauthorized')
})

test('start/stop toggles the transport and emits update', async (t) => {
  const me = await open(t, { bluetooth: false })
  const bt = new Bluetooth(me, { backend: makeMockBluetooth() })
  await bt.ready()
  t.is(bt.state, 'off', 'not started until start()')

  let updates = 0
  bt.on('update', () => updates++)

  await bt.start()
  t.is(bt.state, 'on', 'started')
  await bt.start() // idempotent
  t.is(bt.state, 'on')

  await bt.stop()
  t.is(bt.state, 'off', 'stopped')
  t.ok(updates >= 2, 'update fired on start and stop')
  await bt.close()
})

test('toggle cycle: stop() suspends and start() resumes the SAME transport, re-linking', async (t) => {
  const radio = makeMockBluetooth() // one shared airwave for both devices
  const a = await open(t, { channel: 'toggle', bluetooth: { backend: radio } })
  const b = await open(t, { channel: 'toggle', bluetooth: { backend: radio } })

  await waitUntil(() => a.bluetooth.peers.size > 0 && b.bluetooth.peers.size > 0)
  const ta = a.bluetooth.swarm.transport
  const tb = b.bluetooth.swarm.transport

  await a.bluetooth.stop()
  await b.bluetooth.stop()
  t.is(a.bluetooth.state, 'off', 'stopped')
  t.is(a.bluetooth.peers.size, 0, 'links dropped on stop')
  t.is(a.bluetooth.swarm.transport, ta, 'transport reused, not recreated, across stop')

  await a.bluetooth.start()
  await b.bluetooth.start()
  t.is(a.bluetooth.swarm.transport, ta, 'same transport instance after re-start')
  t.is(b.bluetooth.swarm.transport, tb, 'same transport instance after re-start')
  t.is(a.bluetooth.state, 'on', 'resumed')

  // the kept GATT service means centrals re-subscribe and a link forms again
  await waitUntil(() => a.bluetooth.peers.size > 0 && b.bluetooth.peers.size > 0)
  t.pass('re-linked after a full toggle cycle')
})

test('channel scopes the BLE mesh — no shared topic, no link', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth() // one shared airwave — discovery is per-tag now
  const a = await open(t, { testnet, channel: 'expo-1', bluetooth: { backend: radio } })
  const b = await open(t, { testnet, channel: 'expo-2', bluetooth: { backend: radio } })
  // discovery is topic-scoped: different channels advertise different uuids
  await new Promise((r) => setTimeout(r, 500))
  t.is(a.bluetooth.peers.size, 0, 'different channel peers refuse each other')
  t.is(b.bluetooth.peers.size, 0)
})

test('global nearby: channelless devices link on the tag-global topic', async (t) => {
  const radio = makeMockBluetooth() // one shared airwave, two strangers, no channel
  const a = await open(t, { bluetooth: { backend: radio } })
  const b = await open(t, { bluetooth: { backend: radio } })
  await waitUntil(() => a.bluetooth.peers.size > 0 && b.bluetooth.peers.size > 0)
  t.pass('strangers link with no channel — replication still syncs zero bytes')
})

// ─── offline join: the design's field scenario, no radio required ────────────

test('offline join: invite QR + BLE rendezvous, zero shared DHT', async (t) => {
  const radio = makeMockBluetooth() // one shared airwave for both devices

  // organizer and late volunteer on SEPARATE testnets — no DHT path exists
  const organizer = await open(t, { bluetooth: { backend: radio } })
  const volunteer = await open(t, { bluetooth: { backend: radio } })

  const room = await openRef(organizer.team, { name: 'field-expo' })
  await put(room.messages, { text: 'registered-before-join' })
  const invite = await room.invite({ role: 'member' })

  // organizer shows the QR → advertises the invite-derived UUID
  const stopQR = organizer.bluetooth.announce(invite)

  // volunteer scans the QR → open() auto-rendezvouses over BLE
  const roomB = await openRef(volunteer.team, invite)
  t.ok(roomB.id, 'volunteer joined with zero internet')
  stopQR() // QR closed — rendezvous stops, the established link stays

  const seen = await waitUntil(async () => {
    const { data } = await get(roomB.messages)
    return data.find((m) => m.text === 'registered-before-join') ?? null
  })
  t.ok(seen, 'pre-join data replicated over the BLE link')

  await waitUntil(() => roomB.store.writable)
  await put(roomB.messages, { text: 'from-late-volunteer' })
  const back = await waitUntil(async () => {
    const { data } = await get(room.messages)
    return data.find((m) => m.text === 'from-late-volunteer') ?? null
  })
  t.ok(back, 'writer grant carried over BLE — new member writes converge back')
})

test('announce: no backend → noop stop, no throw', async (t) => {
  const me = await open(t, { bluetooth: false })
  const bt = new Bluetooth(me, { backend: null })
  await bt.ready()
  const stop = bt.announce('not-even-a-valid-invite')
  stop()
  t.pass('unsupported announce is safe')
  await bt.close()
})

test('announce: no-op until start(), no-op again after stop()', async (t) => {
  const radio = makeMockBluetooth()
  const me = await open(t, { bluetooth: { backend: radio, autoStart: false } })

  const room = await openRef(me.team, { name: 'gated' })
  const invite = await room.invite({ role: 'member' })

  let stop = me.bluetooth.announce(invite)
  t.is(me.bluetooth._announce, null, 'radio never started → announce touches nothing')
  stop()

  await me.bluetooth.start()
  stop = me.bluetooth.announce(invite)
  t.ok(me.bluetooth._announce, 'nearby sync on → announce retunes to the invite topic')
  stop()

  await me.bluetooth.stop()
  stop = me.bluetooth.announce(invite)
  t.is(me.bluetooth._announce, null, 'radio stopped → announce touches nothing again')
  stop()
})
