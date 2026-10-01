import test from 'brittle'
import b4a from 'b4a'
import { Duplex } from 'streamx'
import process from 'process'
import { rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { Identity } from '@cero-base/core/identity'

import { cero, put, set, get, watch, open as openRef } from '../../src/index.js'
import { build } from '../../src/build/index.js'
import { Bluetooth } from '../../src/lib/bluetooth.js'
import { spec } from '../fixtures/spec/index.js'
import { makeTestnet, waitUntil, nextRequest } from '../helpers/index.js'
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
  const me = await open(t)
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

test('bluetooth: { on: true } starts the radio at open, "on" when the adapter is powered', async (t) => {
  const me = await open(t, { bluetooth: { on: true, backend: makeMockBluetooth() } })
  t.is(await radioOf(me), 'on', 'advertising + scanning')
  t.absent(await linked(me), 'no peers alone')
})

test('adapter powered off → state waiting, not on', async (t) => {
  const me = await open(t, { bluetooth: { on: true, backend: makeStateBackend('poweredOff') } })
  t.is(await radioOf(me), 'waiting', 'waits for the adapter')
})

test('adapter unauthorized → state surfaced, never silent', async (t) => {
  const me = await open(t, { bluetooth: { on: true, backend: makeStateBackend('unauthorized') } })
  t.is(await radioOf(me), 'unauthorized')
})

test('nearby: every cero() has the radio, off until the app turns it on', async (t) => {
  const me = await open(t, { bluetooth: { backend: makeMockBluetooth() } })
  t.is(await radioOf(me), 'off', 'off at open')
  await cero.nearby(me, true)
  t.is(await radioOf(me), 'on', 'the app turned it on')
  await cero.nearby(me, false)
  t.is(await radioOf(me), 'off', 'and off again')
})

test('bluetooth: the option is an object, on and topic typed', async (t) => {
  const testnet = await makeTestnet(t)
  for (const bluetooth of [
    true,
    false,
    { on: 'yes' },
    { topic: 5 },
    { topic: '' },
    { topic: null }
  ]) {
    const res = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap, bluetooth }).catch(
      (err) => err
    )
    if (!(res instanceof Error)) await res.close()
    t.is(res.code, 'INVALID', JSON.stringify(bluetooth))
  }
})

test('nearby: true or false, then an optional { topic }, anything else is INVALID', async (t) => {
  const me = await open(t, { bluetooth: { backend: makeMockBluetooth() } })
  const room = await openRef(me.team, { name: 'r' })
  const modes = [await cero.invite(room), 'on', 1, null, undefined, { on: true }]
  for (const mode of modes) {
    await t.exception(
      cero.nearby(me, mode),
      /INVALID/,
      JSON.stringify(mode)?.slice(0, 12) ?? 'undefined'
    )
  }
  for (const opts of [
    { topic: 5 },
    { topic: '' },
    { topic: null },
    { other: true },
    'hall-1',
    null
  ]) {
    await t.exception(cero.nearby(me, true, opts), /INVALID/, JSON.stringify(opts))
  }
  t.is(await radioOf(me), 'off', 'none of them turned the radio on')
})

test('start/stop toggles the transport and emits update', async (t) => {
  const me = await open(t)
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
  const a = await open(t, { channel: 'toggle', bluetooth: { on: true, backend: radio } })
  const b = await open(t, { channel: 'toggle', bluetooth: { on: true, backend: radio } })

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

test('nearby: a topic keeps devices apart, and the same topic links them', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const a = await open(t, { testnet, channel: 'expo', bluetooth: { on: true, backend: radio } })
  const b = await open(t, { testnet, channel: 'expo', bluetooth: { on: true, backend: radio } })
  await waitUntil(async () => ((await linked(a)) && (await linked(b))) || null)
  t.pass('linked on the default topic')

  await cero.nearby(a, true, { topic: 'hall-1' })
  await cero.nearby(b, true, { topic: 'hall-2' })
  await waitUntil(async () => !(await linked(a)) || null)
  await new Promise((r) => setTimeout(r, 500))
  t.absent(await linked(a), 'different topics do not link')
  t.is(await radioOf(a), 'on', 'a topic leaves the radio on')

  await cero.nearby(b, true, { topic: 'hall-1' })
  await waitUntil(async () => ((await linked(a)) && (await linked(b))) || null)
  t.pass('the same topic links them')

  await cero.nearby(a, true)
  await cero.nearby(b, true)
  await waitUntil(async () => ((await linked(a)) && (await linked(b))) || null)
  t.pass('no topic is the default topic again')
})

test('nearby: the channel stays a boundary on a shared topic', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const bluetooth = { on: true, topic: 'hall-1', backend: radio }
  const a = await open(t, { testnet, channel: 'preview', bluetooth })
  const b = await open(t, { testnet, channel: 'production', bluetooth })
  await new Promise((r) => setTimeout(r, 500))
  t.absent(await linked(a), 'preview never meets production')
  t.absent(await linked(b))
})

test('nearby: false with a topic stays off; true with it links on it', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const a = await open(t, { testnet, channel: 'late', bluetooth: { backend: radio } })
  const b = await open(t, {
    testnet,
    channel: 'late',
    bluetooth: { on: true, topic: 'hall-1', backend: radio }
  })
  await cero.nearby(a, false, { topic: 'hall-1' })
  t.is(await radioOf(a), 'off', 'still off')
  await cero.nearby(a, true, { topic: 'hall-1' })
  await waitUntil(async () => ((await linked(a)) && (await linked(b))) || null)
  t.pass('came on straight onto the topic')
})

test('nearby: the topic given at start is the default one', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const bluetooth = { topic: 'expo-cr', backend: radio }
  const a = await open(t, { testnet, channel: 'start', bluetooth })
  const b = await open(t, { testnet, channel: 'start', bluetooth: { ...bluetooth, on: true } })
  await cero.nearby(a, true, { topic: 'hall-1' })
  await cero.nearby(a, true)
  await waitUntil(async () => ((await linked(a)) && (await linked(b))) || null)
  t.pass('on without a topic went back to the start topic, where b is')
})

test('channel scopes the BLE mesh — no shared topic, no link', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth() // one shared airwave — discovery is per-tag now
  const a = await open(t, { testnet, channel: 'expo-1', bluetooth: { on: true, backend: radio } })
  const b = await open(t, { testnet, channel: 'expo-2', bluetooth: { on: true, backend: radio } })
  // discovery is topic-scoped: different channels advertise different uuids
  await new Promise((r) => setTimeout(r, 500))
  t.absent(await linked(a), 'different channel peers refuse each other')
  t.absent(await linked(b))
})

test('global nearby: channelless devices link on the tag-global topic', async (t) => {
  const radio = makeMockBluetooth() // one shared airwave, two strangers, no channel
  const a = await open(t, { bluetooth: { on: true, backend: radio } })
  const b = await open(t, { bluetooth: { on: true, backend: radio } })
  await waitUntil(async () => ((await linked(a)) && (await linked(b))) || null)
  t.pass('strangers link with no channel — replication still syncs zero bytes')
})

test('nearby: a peer carries the name it shows in a room you share', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const a = await open(t, { testnet, channel: 'names', bluetooth: { on: true, backend: radio } })
  const b = await open(t, { testnet, channel: 'names', bluetooth: { on: true, backend: radio } })
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
  const a = await open(t, { testnet, channel: 'own', bluetooth: { on: true, backend: radio } })
  const b = await open(t, {
    testnet,
    channel: 'own',
    phrase: a.identity.toPhrase(),
    bluetooth: { on: true, backend: radio }
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
  const a = await open(t, { channel: 'strangers', bluetooth: { on: true, backend: radio } })
  const b = await open(t, {
    channel: 'strangers',
    isMobile: true,
    bluetooth: { on: true, backend: radio }
  })
  await set(b.profile, { name: 'bee' })

  const peer = await waitUntil(async () => (await get(a.nearby)).data.find((p) => p.name) ?? null)
  t.alike(
    { ...peer, device: typeof peer.device },
    { id: b.id, device: 'string', name: 'bee', isMobile: true }
  )
})

test('nearby: a profile rename reaches the devices linked over Bluetooth', async (t) => {
  const radio = makeMockBluetooth()
  const a = await open(t, { channel: 'rename', bluetooth: { on: true, backend: radio } })
  const b = await open(t, { channel: 'rename', bluetooth: { on: true, backend: radio } })

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
  const a = await open(t, { testnet, channel: 'members', bluetooth: { on: true, backend: radio } })
  const b = await open(t, {
    testnet,
    channel: 'members',
    isMobile: true,
    bluetooth: { on: true, backend: radio }
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

test('nearby: what a peer told is forgotten once its link closes', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const a = await open(t, { testnet, channel: 'forget', bluetooth: { on: true, backend: radio } })
  const b = await open(t, { testnet, channel: 'forget', bluetooth: { on: true, backend: radio } })
  const hex = await waitUntil(() => [...a._bluetooth.peers.keys()][0] ?? null)
  await waitUntil(() => a._bluetooth.told(hex))
  await cero.nearby(b, false)
  await waitUntil(() => !a._bluetooth.peers.has(hex) || null)
  t.is(a._bluetooth.told(hex), null, 'dropped with the link')
})

// two links between a and b by hand, as ble-swarm hands them over: b's key on a's end, a's on b's
function link(a, b) {
  const ends = [new Duplex({ write: (data, cb) => cb(null, ends[1].push(data)) })]
  ends.push(new Duplex({ write: (data, cb) => cb(null, ends[0].push(data)) }))
  ends[0].remotePublicKey = b.store.keyPair.publicKey
  ends[1].remotePublicKey = a.store.keyPair.publicKey
  a._bluetooth._attach(ends[0])
  b._bluetooth._attach(ends[1])
  return ends
}

test('nearby: a link replaced by a newer one keeps what the peer told', async (t) => {
  const a = await open(t, { bluetooth: { backend: makeMockBluetooth() } })
  const b = await open(t, { bluetooth: { backend: makeMockBluetooth() } })
  const hex = b4a.toHex(b.store.keyPair.publicKey)
  const [old] = link(a, b)
  await waitUntil(() => a._bluetooth.told(hex))
  const fresh = link(a, b)
  t.teardown(() => fresh.forEach((end) => end.destroy()))
  await waitUntil(() => a._bluetooth._heard.get(hex) && a._bluetooth._links?.get(hex) !== old)
  old.destroy()
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.ok(a._bluetooth.told(hex), 'the old link closing does not forget the peer on the new one')
})

test('nearby: a Wi-Fi connection carries none of it', async (t) => {
  const testnet = await makeTestnet(t)
  // two airwaves: the devices meet over the DHT only
  const a = await open(t, {
    testnet,
    channel: 'wifi',
    bluetooth: { on: true, backend: makeMockBluetooth() }
  })
  const b = await open(t, {
    testnet,
    channel: 'wifi',
    bluetooth: { on: true, backend: makeMockBluetooth() }
  })
  await set(a.profile, { name: 'ada' })
  await set(b.profile, { name: 'bo' })
  const room = await openRef(a.team, { name: 'wifi' })
  const roomB = await openRef(b.team, await cero.invite(room))

  await put(room.messages, { text: 'after-open' })
  await waitUntil(async () => {
    const { data } = await get(roomB.messages)
    return data.find((m) => m.text === 'after-open') ?? null
  })
  const heard = [...b.network.swarm.connections].map(
    (c) => b._bluetooth._heard.get(b4a.toHex(c.remotePublicKey)) ?? null
  )
  t.ok(heard.length > 0, 'connected over the DHT')
  t.alike(
    heard,
    heard.map(() => null),
    'no name crossed a Wi-Fi connection'
  )
})

test('nearby: a device claiming someone else is not shown as them', async (t) => {
  const radio = makeMockBluetooth()
  const a = await open(t, { channel: 'forged', bluetooth: { on: true, backend: radio } })
  const b = await open(t, { channel: 'forged', bluetooth: { on: true, backend: radio } })
  const victim = await Identity.create()
  await waitUntil(() => linked(a))

  b._bluetooth._say({ ...b._bluetooth._info, id: victim.id, name: 'mallory' })
  const hex = b4a.toHex(b.store.keyPair.publicKey)
  await waitUntil(() => a._bluetooth._heard.get(hex)?.name === 'mallory')
  t.alike((await get(a.nearby)).data, [], 'a signature from another person names no one')
})

test('nearby: a person with two devices in range shows each device', async (t) => {
  const testnet = await makeTestnet(t)
  const radio = makeMockBluetooth()
  const a = await open(t, { testnet, channel: 'twice', bluetooth: { on: true, backend: radio } })
  const b = await open(t, { testnet, channel: 'twice', bluetooth: { on: true, backend: radio } })
  await open(t, {
    testnet,
    channel: 'twice',
    phrase: b.identity.toPhrase(),
    bluetooth: { on: true, backend: radio }
  })

  await waitUntil(() => {
    const keys = [...a._bluetooth.peers.keys()]
    return keys.length === 2 && keys.every((hex) => a._bluetooth._heard.get(hex))
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
    const opts = {
      bootstrap: testnet.bootstrap,
      extensions: [],
      bluetooth: { on: true, backend: radio }
    }
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

test('offline join: an invite works over Bluetooth alone, zero shared DHT', async (t) => {
  const radio = makeMockBluetooth() // one shared airwave for both devices

  // organizer and late volunteer on SEPARATE testnets — no DHT path exists
  const organizer = await open(t, { bluetooth: { on: true, backend: radio } })
  const volunteer = await open(t, { bluetooth: { on: true, backend: radio } })

  const room = await openRef(organizer.team, { name: 'field-expo' })
  await put(room.messages, { text: 'registered-before-join' })
  const invite = await cero.invite(room, { role: 'member' })

  // the same open as online: the join rides the mesh link, nothing else is switched
  const roomB = await openRef(volunteer.team, invite)
  t.ok(roomB.id, 'volunteer joined with zero internet')

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

test('offline join: a confirm invite is asked and accepted over Bluetooth alone', async (t) => {
  const radio = makeMockBluetooth()
  // each on its own testnet: Bluetooth is the only way between them
  const host = await open(t, { bluetooth: { on: true, backend: radio } })
  const joiner = await open(t, { bluetooth: { on: true, backend: radio } })

  const room = await openRef(host.team, { name: 'field-group' })
  const invite = await cero.invite(room, { confirm: true })
  const joining = openRef(joiner.team, invite)
  const request = await nextRequest(room)
  t.alike(request.identity, joiner.identity.publicKey, 'the request came over Bluetooth')
  await cero.accept(room, request)
  const joined = await joining
  t.ok(joined.id, 'admitted with zero internet')

  await waitUntil(() => joined.store.writable)
  await put(joined.messages, { text: 'hi from the field' })
  const seen = await waitUntil(async () => {
    const { data } = await get(room.messages)
    return data.find((m) => m.text === 'hi from the field') ?? null
  })
  t.ok(seen, 'their write reached the host over Bluetooth')
})

test('recovery: a phrase restores this person over Bluetooth with no internet', async (t) => {
  const radio = makeMockBluetooth()
  const a = await open(t, { channel: 'recover', bluetooth: { on: true, backend: radio } })
  await put(a.messages, { text: 'before-recovery' })

  const b = await open(t, {
    channel: 'recover',
    phrase: a.identity.toPhrase(),
    recoveryTimeout: 15000,
    bluetooth: { on: true, backend: radio }
  })
  t.is(b.id, a.id, 'the identity of the phrase')
  const seen = await waitUntil(async () => {
    const { data } = await get(b.messages)
    return data.find((m) => m.text === 'before-recovery') ?? null
  })
  t.ok(seen, 'the log came over Bluetooth')
})

test('close: the BLE swarm is down before the network closes', async (t) => {
  const me = await open(t, { bluetooth: { on: true, backend: makeMockBluetooth() } })
  const close = me.network.close.bind(me.network)
  let btClosed = null
  me.network.close = () => {
    btClosed = me._bluetooth.closed
    return close()
  }
  await me.close()
  t.is(btClosed, true, 'no late BLE connection can reach a closed network')
})
