import test from 'brittle'
import b4a from 'b4a'
import process from 'process'
import { rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { Identity } from '@cero-base/core/identity'

import { cero, put, set, get, watch, open as openRef } from '../../src/index.js'
import { build } from '../../src/build/index.js'
import { Bluetooth } from '../../src/lib/bluetooth.js'
import { spec } from '../fixtures/spec/index.js'
import { makeTestnet, waitUntil } from '../helpers/index.js'
import { makeMockBluetooth, makeStateBackend } from 'ble-swarm/mock.js'

test.configure({ timeout: 90000 })

const buildRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  '.build-bluetooth'
)
process.on('exit', () => rmSync(buildRoot, { recursive: true, force: true }))

const radioOf = async (me) => (await get(me.status)).data.nearby
const linked = async (me) => (await get(me.nearby)).data.length > 0

async function open(t, opts = {}) {
  const testnet = opts.testnet || (await makeTestnet(t))
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap, ...opts })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return me
}

test('no backend → the transport reports unsupported, start() is a safe no-op', async (t) => {
  const me = await open(t, { bluetooth: false })
  const bt = new Bluetooth(me.network, {
    identity: me.identity,
    keyPair: me.store.keyPair,
    backend: null
  })
  await bt.ready()
  t.is(bt.state, 'unsupported', 'absent backend reported, not crashed')
  await bt.start() // must not throw
  t.is(bt.state, 'unsupported')
  await bt.close()
})

test('bluetooth: true auto-starts and reaches "on" when the adapter is powered', async (t) => {
  const me = await open(t, { bluetooth: { backend: makeMockBluetooth() } })
  t.is(await radioOf(me), 'on', 'advertising + scanning')
  t.absent(await linked(me), 'no peers alone')
})

test('adapter powered off → state waiting, not on', async (t) => {
  const me = await open(t, { bluetooth: { backend: makeStateBackend('poweredOff') } })
  t.is(await radioOf(me), 'waiting', 'waits for the adapter')
})

test('adapter unauthorized → state surfaced, never silent', async (t) => {
  const me = await open(t, { bluetooth: { backend: makeStateBackend('unauthorized') } })
  t.is(await radioOf(me), 'unauthorized')
})

test('nearby: without the bluetooth option the radio is not there to turn on', async (t) => {
  const me = await open(t)
  t.is(await radioOf(me), null)
  await t.exception(cero.nearby(me, true), /bluetooth option/)
})

test('start/stop toggles the transport and emits update', async (t) => {
  const me = await open(t, { bluetooth: false })
  const bt = new Bluetooth(me.network, {
    identity: me.identity,
    keyPair: me.store.keyPair,
    backend: makeMockBluetooth()
  })
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

  await waitUntil(async () => ((await linked(a)) && (await linked(b))) || null)
  const ta = a._bluetooth.swarm.transport
  const tb = b._bluetooth.swarm.transport

  await cero.nearby(a, false)
  await cero.nearby(b, false)
  t.is(await radioOf(a), 'off', 'stopped')
  t.absent(await linked(a), 'links dropped on stop')
  t.is(a._bluetooth.swarm.transport, ta, 'transport reused, not recreated, across stop')

  await cero.nearby(a, true)
  await cero.nearby(b, true)
  t.is(a._bluetooth.swarm.transport, ta, 'same transport instance after re-start')
  t.is(b._bluetooth.swarm.transport, tb, 'same transport instance after re-start')
  t.is(await radioOf(a), 'on', 'resumed')

  // the kept GATT service means centrals re-subscribe and a link forms again
  await waitUntil(async () => ((await linked(a)) && (await linked(b))) || null)
  t.pass('re-linked after a full toggle cycle')
})

test('channel scopes the BLE mesh — no shared topic, no link', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth() // one shared airwave — discovery is per-tag now
  const a = await open(t, { testnet, channel: 'expo-1', bluetooth: { backend: radio } })
  const b = await open(t, { testnet, channel: 'expo-2', bluetooth: { backend: radio } })
  // discovery is topic-scoped: different channels advertise different uuids
  await new Promise((r) => setTimeout(r, 500))
  t.absent(await linked(a), 'different channel peers refuse each other')
  t.absent(await linked(b))
})

test('global nearby: channelless devices link on the tag-global topic', async (t) => {
  const radio = makeMockBluetooth() // one shared airwave, two strangers, no channel
  const a = await open(t, { bluetooth: { backend: radio } })
  const b = await open(t, { bluetooth: { backend: radio } })
  await waitUntil(async () => ((await linked(a)) && (await linked(b))) || null)
  t.pass('strangers link with no channel — replication still syncs zero bytes')
})

test('nearby: a peer carries the name it shows in a room you share', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const a = await open(t, { testnet, channel: 'names', bluetooth: { backend: radio } })
  const b = await open(t, { testnet, channel: 'names', bluetooth: { backend: radio } })
  await set(b.profile, { name: 'bee' })
  const room = await openRef(a.team, { name: 'shared' })
  await openRef(b.team, await cero.invite(room))

  const peer = await waitUntil(async () => {
    const { data } = await get(a.nearby)
    return data.find((p) => p.id === b.id && p.name) ?? null
  })
  t.is(peer.name, 'bee')
})

test('nearby: two devices of one person link over Bluetooth and sync', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const a = await open(t, { testnet, channel: 'own', bluetooth: { backend: radio } })
  const b = await open(t, {
    testnet,
    channel: 'own',
    seed: a.identity.seed,
    bluetooth: { backend: radio }
  })

  const peer = await waitUntil(async () => (await get(a.nearby)).data[0] ?? null)
  t.is(peer.id, a.id, 'the other device shows as this person')

  await a.network.suspend()
  await b.network.suspend()
  await put(a.messages, { text: 'over-bluetooth' })
  const seen = await waitUntil(async () => {
    const { data } = await get(b.messages)
    return data.find((m) => m.text === 'over-bluetooth') ?? null
  })
  t.ok(seen, 'synced with the internet off')
})

test('nearby: a stranger shows the name and device type it sends over the link', async (t) => {
  const radio = makeMockBluetooth()
  const a = await open(t, { channel: 'strangers', bluetooth: { backend: radio } })
  const b = await open(t, { channel: 'strangers', isMobile: true, bluetooth: { backend: radio } })
  await set(b.profile, { name: 'bee' })

  const peer = await waitUntil(async () => (await get(a.nearby)).data.find((p) => p.name) ?? null)
  t.alike(
    { ...peer, device: typeof peer.device },
    { id: b.id, device: 'string', name: 'bee', isMobile: true }
  )
})

test('nearby: a profile rename reaches the devices linked over Bluetooth', async (t) => {
  const radio = makeMockBluetooth()
  const a = await open(t, { channel: 'rename', bluetooth: { backend: radio } })
  const b = await open(t, { channel: 'rename', bluetooth: { backend: radio } })

  await set(b.profile, { name: 'bee' })
  for await (const { data } of watch(a.nearby)) {
    if (data[0]?.name === 'bee') await set(b.profile, { name: 'bea' })
    if (data[0]?.name === 'bea') break
  }
  t.pass('a watch of nearby saw the new name')
})

test("nearby: a room member's device shows the member, named by the room without a profile name", async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const a = await open(t, { testnet, channel: 'members', bluetooth: { backend: radio } })
  const b = await open(t, {
    testnet,
    channel: 'members',
    isMobile: true,
    bluetooth: { backend: radio }
  })
  const room = await openRef(a.team, { name: 'shared' })
  const roomB = await openRef(b.team, await cero.invite(room))
  await set(roomB.members, { id: b.id, name: 'member-bee' })

  const peer = await waitUntil(async () => {
    const { data } = await get(a.nearby)
    return data.find((p) => p.id === b.id && p.name) ?? null
  })
  t.alike(
    { ...peer, device: typeof peer.device },
    { id: b.id, device: 'string', name: 'member-bee', isMobile: true }
  )
})

test('nearby: a Wi-Fi connection carries none of it', async (t) => {
  const testnet = await makeTestnet(t)
  // two airwaves: the devices meet over the DHT only
  const a = await open(t, { testnet, channel: 'wifi', bluetooth: { backend: makeMockBluetooth() } })
  const b = await open(t, { testnet, channel: 'wifi', bluetooth: { backend: makeMockBluetooth() } })
  await set(a.profile, { name: 'ada' })
  await set(b.profile, { name: 'bo' })
  const room = await openRef(a.team, { name: 'wifi' })
  const roomB = await openRef(b.team, await cero.invite(room))

  await put(room.messages, { text: 'after-open' })
  await waitUntil(async () => {
    const { data } = await get(roomB.messages)
    return data.find((m) => m.text === 'after-open') ?? null
  })
  const heard = [...b.network.swarm.connections].map((c) => b.network.getInfo(c.remotePublicKey))
  t.ok(heard.length > 0, 'connected over the DHT')
  t.alike(
    heard,
    heard.map(() => null),
    'no name crossed a Wi-Fi connection'
  )
})

test('nearby: a device claiming someone else is not shown as them', async (t) => {
  const radio = makeMockBluetooth()
  const a = await open(t, { channel: 'forged', bluetooth: { backend: radio } })
  const b = await open(t, { channel: 'forged', bluetooth: { backend: radio } })
  const victim = await Identity.create()
  await waitUntil(() => linked(a))

  b.network.setInfo({ ...b.network.info, id: victim.id, name: 'mallory' })
  const hex = b4a.toHex(b.store.keyPair.publicKey)
  await waitUntil(() => a.network.getInfo(hex)?.name === 'mallory')
  t.alike((await get(a.nearby)).data, [], 'a signature from another person names no one')
})

test('nearby: a person with two devices in range shows each device', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const a = await open(t, { testnet, channel: 'twice', bluetooth: { backend: radio } })
  const b = await open(t, { testnet, channel: 'twice', bluetooth: { backend: radio } })
  await open(t, { testnet, channel: 'twice', seed: b.identity.seed, bluetooth: { backend: radio } })

  await waitUntil(() => {
    const keys = [...a._bluetooth.peers.keys()]
    return keys.length === 2 && keys.every((hex) => a.network.getInfo(hex))
  })
  const { data } = await get(a.nearby)
  t.alike(
    data.map((p) => p.id),
    [b.id, b.id],
    'one row per device, as each link'
  )
  t.is(new Set(data.map((p) => p.device)).size, 2, 'told apart by device')
})

test('nearby: an app without a profile still tells whose device it is', async (t) => {
  const dir = join(buildRoot, 'no-profile')
  await build(dir, cero.schema({ notes: cero.t.collection({ text: cero.t.string }) }), {
    extensions: []
  })
  const { spec: plain } = await import(pathToFileURL(join(dir, 'index.js')).href)
  const radio = makeMockBluetooth()
  const mk = async () => {
    const testnet = await makeTestnet(t)
    const opts = { bootstrap: testnet.bootstrap, extensions: [], bluetooth: { backend: radio } }
    const me = await cero(await t.tmp(), plain, opts)
    t.teardown(() => me.close().catch(() => {}), { order: 5 })
    return me
  }
  const a = await mk()
  const b = await mk()

  const peer = await waitUntil(async () => (await get(a.nearby)).data[0] ?? null)
  t.alike(
    { ...peer, device: typeof peer.device },
    { id: b.id, device: 'string', name: null, isMobile: false }
  )
})

// ─── offline join: the design's field scenario, no radio required ────────────

test('offline join: invite QR + BLE rendezvous, zero shared DHT', async (t) => {
  const radio = makeMockBluetooth() // one shared airwave for both devices

  // organizer and late volunteer on SEPARATE testnets — no DHT path exists
  const organizer = await open(t, { bluetooth: { backend: radio } })
  const volunteer = await open(t, { bluetooth: { backend: radio } })

  const room = await openRef(organizer.team, { name: 'field-expo' })
  await put(room.messages, { text: 'registered-before-join' })
  const invite = await cero.invite(room, { role: 'member' })

  // organizer shows the QR → advertises the invite-derived UUID
  await cero.nearby(organizer, invite)

  // volunteer scans the QR → open() auto-rendezvouses over BLE
  const roomB = await openRef(volunteer.team, invite)
  t.ok(roomB.id, 'volunteer joined with zero internet')
  await cero.nearby(organizer, true) // QR closed: back to the mesh, the established link stays

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

test('offline join: a host with every Bluetooth slot taken still pairs a joiner', async (t) => {
  const radio = makeMockBluetooth()
  const host = await open(t, {
    channel: 'crowd',
    bluetooth: { backend: radio, maxOutbound: 1, maxInbound: 1 }
  })
  await open(t, { channel: 'crowd', bluetooth: { backend: radio } })
  await waitUntil(() => linked(host))

  // only the smaller key dials, and a host at its cap dials no one: the worst joiner is larger
  let joiner = null
  while (!joiner || b4a.compare(joiner.store.keyPair.publicKey, host.store.keyPair.publicKey) < 0) {
    await joiner?.close()
    joiner = await open(t, { channel: 'crowd', bluetooth: { backend: radio } })
  }

  const room = await openRef(host.team, { name: 'crowded' })
  const invite = await cero.invite(room)
  await cero.nearby(host, invite)
  const joined = await openRef(joiner.team, invite)
  t.ok(joined.id, 'paired past a full mesh')
})

test('recovery: a phrase restores this person over Bluetooth with no internet', async (t) => {
  const radio = makeMockBluetooth()
  const a = await open(t, { channel: 'recover', bluetooth: { backend: radio } })
  await put(a.messages, { text: 'before-recovery' })

  const b = await open(t, {
    channel: 'recover',
    seed: a.identity.seed,
    recoveryTimeout: 15000,
    bluetooth: { backend: radio }
  })
  t.is(b.id, a.id, 'the identity of the phrase')
  const seen = await waitUntil(async () => {
    const { data } = await get(b.messages)
    return data.find((m) => m.text === 'before-recovery') ?? null
  })
  t.ok(seen, 'the log came over Bluetooth')
})

test('announce: no backend → noop stop, no throw', async (t) => {
  const me = await open(t, { bluetooth: false })
  const bt = new Bluetooth(me.network, {
    identity: me.identity,
    keyPair: me.store.keyPair,
    backend: null
  })
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
  const invite = await cero.invite(room, { role: 'member' })

  let stop = me._bluetooth.announce(invite)
  t.is(me._bluetooth._announce, null, 'radio never started → announce touches nothing')
  stop()

  await me._bluetooth.start()
  stop = me._bluetooth.announce(invite)
  t.ok(me._bluetooth._announce, 'nearby sync on → announce retunes to the invite topic')
  stop()

  await me._bluetooth.stop()
  stop = me._bluetooth.announce(invite)
  t.is(me._bluetooth._announce, null, 'radio stopped → announce touches nothing again')
  stop()
})

test('close: the BLE swarm is down before the network closes', async (t) => {
  const me = await open(t, { bluetooth: { backend: makeMockBluetooth() } })
  const close = me.network.close.bind(me.network)
  let btClosed = null
  me.network.close = () => {
    btClosed = me._bluetooth.closed
    return close()
  }
  await me.close()
  t.is(btClosed, true, 'no late BLE connection can reach a closed network')
})
