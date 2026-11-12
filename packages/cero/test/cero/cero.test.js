import test from 'brittle'
import process from 'process'
import AbortController from 'bare-abort-controller'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import c from 'compact-encoding'
import { discoveryKey } from 'hypercore-crypto'
import hid from 'hypercore-id-encoding'
import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'

import { Identity } from '@cero-base/core/identity'
import { CeroError } from '@cero-base/core/errors'
import { decodeId } from '@cero-base/core/blobs/codec'
import { Invite } from '@cero-base/core/invite'
import { Pairing } from '@cero-base/core/pairing'
import { Mailbox } from '@cero-base/core/mailbox'
import { epochEntries } from '@cero-base/core/database/encryption'
import { makeMockBluetooth } from 'ble-swarm/mock.js'

import {
  cero,
  put,
  set,
  get,
  del,
  open,
  call,
  accept,
  deny,
  rotate,
  peek,
  restore,
  Local
} from '../../src/index.js'
import { spec } from '../fixtures/spec/index.js'
import { spec as next } from '../fixtures/spec/next/index.js'
import {
  makeTestnet,
  makeMirror,
  holds,
  waitForConnection,
  waitUntil,
  nextRequest,
  joinsOf,
  refusedAtClaim,
  ceroOpen
} from '../helpers/index.js'

test.configure({ timeout: 90000 })

// ─── channel ──────────────────────────────────────────────────────────────

test('channel: opt threads to the network', async (t) => {
  const { me } = await ceroOpen(t, { channel: 'dev' })
  t.is(me.network.channel, 'dev', 'channel reached Network')
})

test('relayThrough and firewall: opts thread to the network', async (t) => {
  const firewall = () => false
  const { me } = await ceroOpen(t, { relayThrough: [b4a.toHex(b4a.alloc(32, 7))], firewall })
  t.alike(me.network.relayThrough, [b4a.alloc(32, 7)], 'relay key decoded from hex')
  t.is(me.network.firewall, firewall, 'firewall reached Network')
  t.is(typeof me.network.swarm.relayThrough, 'function', 'the swarm relays only when needed')
})

test('mirrors: opt threads to the network and survives restore', async (t) => {
  const key = b4a.toHex(b4a.alloc(32, 1))
  const { me } = await ceroOpen(t, { mirrors: [key] })
  t.ok(me.network._blindPeering, 'blind peering constructed when mirrors are passed')
  t.alike(me.network.mirrors[0], b4a.alloc(32, 1), 'mirror key decoded from hex')
  t.alike(me._opts.mirrors, [key], 'mirrors retained on opts for restore')
})

test('mirrors: a joiner joins while every member is offline or suspended, the mirror holds it', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const mirrors = [b4a.toHex(mirror.publicKey)]
  const { me: owner } = await ceroOpen(t, { testnet, mirrors })
  const room = await open(owner.team, { name: 'clinic' })
  const invite = await cero.invite(room)
  await cero.suspend(owner)

  // the same app, so the same mirrors
  const { me: joiner } = await ceroOpen(t, { testnet, mirrors })
  const held = holds(mirror, Invite.parse(invite).key)
  const joining = open(joiner.team, invite)
  await held
  t.is((await get(room.members)).data.length, 1, 'a suspended owner admits nobody')

  await cero.resume(owner)
  const joined = await joining
  t.is(joined.id, room.id, 'admitted once the owner came back')
})

// a device coming back: cero() again on the same directory
async function reopen(t, dir, testnet, opts = {}) {
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, ...opts })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return me
}

const joined = (me, id) =>
  waitUntil(() => [...me.children].find((child) => child.id === id) || null)

test('mirrors: owner and joiner are never online together, across restarts', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const mirrors = [b4a.toHex(mirror.publicKey)]
  const owner = await ceroOpen(t, { testnet, mirrors })
  const room = await open(owner.me.team, { name: 'clinic' })
  const { id } = room
  const invite = await cero.invite(room)
  await owner.me.close()

  // the joiner joins alone and leaves: its join waits on the app's mirror
  const joiner = await ceroOpen(t, { testnet, mirrors })
  const held = holds(mirror, Invite.parse(invite).key)
  joiner.me._join(invite, 'team', { timeout: 500 }).catch(() => {})
  await held
  const [{ secretKey }] = (await joiner.me.local.store.get('handle-keypairs')).data
  await joiner.me.close()

  // all of a device's writer core for the room is on the mirror
  const mirrored = async ({ store }) => {
    const core = mirror.store.get({ key: store.writerKey })
    await core.ready()
    await waitUntil(() => core.contiguousLength >= store.bee.local.length || null)
    await core.close()
  }

  // the owner comes back alone, lets it in, and leaves once the reply is on the mirror: a
  // promise, no member yet
  const replied = holds(mirror, Mailbox.getAddress(secretKey))
  const back = await reopen(t, owner.dir, testnet, { mirrors })
  const reopened = await open(back.team, { id })
  await waitUntil(async () => ((await get(reopened.requests)).data.length === 1 ? true : null))
  await replied
  t.is((await get(reopened.members)).data.length, 1, 'let in, not a member before her device comes')
  await mirrored(reopened)
  await back.close()

  // the joiner comes back alone, takes her seat, and leaves once her claim is on the mirror
  const again = await reopen(t, joiner.dir, testnet, { mirrors })
  const seated = await joined(again, id)
  t.ok(seated, 'joined with nobody else online')
  t.ok((await get(seated.members, again.identity.id)).data, 'a member on her own device')
  await mirrored(seated)
  await again.close()

  // the owner, alone again, has her as a member from what the mirror holds
  const last = await reopen(t, owner.dir, testnet, { mirrors })
  const room2 = await open(last.team, { id })
  await waitUntil(async () => ((await get(room2.members)).data.length === 2 ? true : null))
  t.pass('her claim reached the owner through the mirror')
  await waitUntil(async () => ((await get(room2.requests)).data.length === 0 ? true : null))
  t.pass('and the owner settled her promise')
})

test('hooks: an action on a type runs in every room of it, created, joined or reopened', async (t) => {
  const testnet = await makeTestnet(t)
  const promoted = []
  const promote = ({ row }) => void promoted.push(row.memberId)
  const extensions = [{ setup: (me) => cero.after(me.team.promote, promote) }]
  const owner = await ceroOpen(t, { testnet, extensions })
  const room = await open(owner.me.team, { name: 'clinic' })
  const { id } = room
  await call(room.promote, { memberId: 'created', role: 'member' })

  const joiner = await ceroOpen(t, { testnet, extensions })
  const joined = await open(joiner.me.team, await cero.invite(room))
  await call(joined.promote, { memberId: 'joined', role: 'member' })

  await owner.me.close()
  const back = await reopen(t, owner.dir, testnet, { extensions })
  const reopened = await open(back.team, { id })
  await call(reopened.promote, { memberId: 'reopened', role: 'member' })
  t.ok(['created', 'joined', 'reopened'].every((m) => promoted.includes(m)))
})

test('invites: a join survives the joiner restarting, and lands once a member is back', async (t) => {
  const testnet = await makeTestnet(t)
  const { me: owner } = await ceroOpen(t, { testnet })
  const room = await open(owner.team, { name: 'clinic' })
  const invite = await cero.invite(room)
  await cero.suspend(owner)

  const joiner = await ceroOpen(t, { testnet })
  const err = await joiner.me._join(invite, 'team', { timeout: 1000 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT', 'the caller stops waiting')
  await joiner.me.close()

  await cero.resume(owner)
  const again = await reopen(t, joiner.dir, testnet)
  t.ok(await joined(again, room.id), 'the join went on after the restart')
})

test('invites: a join that lands as its caller times out gives back the open it made', async (t) => {
  const testnet = await makeTestnet(t)
  const { me: owner } = await ceroOpen(t, { testnet })
  const room = await open(owner.team, { name: 'clinic' })
  const invite = await cero.invite(room)
  const { me: joiner } = await ceroOpen(t, { testnet, keepOpen: 0 })

  // the room opens in time, and the caller's open of it lands from inside the timeout's own callback
  let land
  const landing = new Promise((resolve) => (land = resolve))
  let entered = null
  const enter = joiner._enter.bind(joiner)
  joiner._enter = async (...args) => (entered = await enter(...args))
  const landed = joiner._landed.bind(joiner)
  joiner._landed = async (...args) => {
    await landed(...args)
    await landing
  }
  const timeout = CeroError.TIMEOUT
  CeroError.TIMEOUT = (...args) => (land(), timeout(...args))
  t.teardown(() => {
    CeroError.TIMEOUT = timeout
  })
  const err = await joiner._join(invite, 'team', { timeout: 5000 }).catch((e) => e)
  CeroError.TIMEOUT = timeout
  t.is(err.code, 'TIMEOUT', 'the caller stops waiting')
  t.ok(entered, 'the room had opened')
  await waitUntil(() => entered.closed || null)
  t.pass('nobody took it, so it closed')
})

test('invites: a join the root closes on rejects with CLOSED, stays saved and lands later', async (t) => {
  const testnet = await makeTestnet(t)
  const { me: owner } = await ceroOpen(t, { testnet })
  const room = await open(owner.team, { name: 'clinic' })
  const invite = await cero.invite(room)
  await cero.suspend(owner)

  const joiner = await ceroOpen(t, { testnet })
  const joining = open(joiner.me.team, invite).catch((err) => err)
  await waitUntil(async () => ((await joinsOf(joiner.me)).length ? true : null))
  await joiner.me.close()
  t.is((await joining).code, 'CLOSED', 'the waiting open hears CLOSED')

  const again = await reopen(t, joiner.dir, testnet)
  t.alike(await joinsOf(again), [invite], 'the join is still saved')
  await cero.resume(owner)
  t.ok(await joined(again, room.id), 'it lands once a member answers')
})

test('invites: a join opening its room when the root closes rejects with CLOSED, stays saved and lands later', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const invite = await cero.invite(room)
  const topic = discoveryKey(room.store.key)

  // the reply landed, the joiner stopped before its admission reached it
  const joiner = await ceroOpen(t, { testnet })
  const { identity, mailbox } = joiner.me
  const opts = { identity, spec: spec.handles.team }
  const { key, encryptionKey, epochs, writer } = await Pairing.join(mailbox, invite, opts)
  await replied(joiner.me, invite, { key, encryptionKey, epochs, writer })
  await joiner.me.close()
  await cero.suspend(owner.me)

  // back with no member online: the resumed join opens the room and waits on its admission
  const again = await reopen(t, joiner.dir, testnet)
  const joining = open(again.team, invite).catch((err) => err)
  await waitUntil(() => again.network.presence.mode(topic) !== null)
  await again.close()
  t.is((await joining).code, 'CLOSED', 'the waiting open hears CLOSED')

  const back = await reopen(t, joiner.dir, testnet)
  t.alike(await joinsOf(back), [invite], 'the join is still saved')
  await cero.resume(owner.me)
  t.ok(await joined(back, room.id), 'it lands once a member is back')
})

test('invites: a reply survives the member restarting', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const { id } = room
  const invite = await cero.invite(room, { confirm: true })

  // the joiner joins, then leaves before a member accepts
  const joiner = await ceroOpen(t, { testnet })
  const waiting = joiner.me._join(invite, 'team', { timeout: 1000 }).catch((e) => e)
  const request = await nextRequest(room)
  await waiting
  await joiner.me.close()

  // admitted while the joiner is away, and the invite consumed: only the kept reply can get
  // the joiner in, the outbox has to carry it across the restart
  await accept(room, request)
  await waitUntil(async () => ((await get(room.invites)).data.length === 0 ? true : null))
  await owner.me.close()
  const back = await reopen(t, owner.dir, testnet)
  await open(back.team, { id })

  const again = await reopen(t, joiner.dir, testnet)
  t.ok(await joined(again, id), 'the kept reply reached the joiner')
})

test('invites: a joiner restarting after the reply landed opens the room from the kept keys', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const invite = await cero.invite(room)

  // the reply landed and the writer was admitted, then the joiner stopped: nothing left to join
  const joiner = await ceroOpen(t, { testnet })
  const { identity, mailbox } = joiner.me
  const opts = { identity, spec: spec.handles.team }
  const { key, encryptionKey, epochs, writer } = await Pairing.join(mailbox, invite, opts)
  await cero.revoke(room, invite)
  await replied(joiner.me, invite, { key, encryptionKey, epochs, writer })
  await joiner.me.close()

  const again = await reopen(t, joiner.dir, testnet)
  t.ok(await joined(again, room.id), 'opened from the kept keys')
})

test('invites: a join request waiting for approval survives the member restarting', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const { id } = room
  const invite = await cero.invite(room, { confirm: true })

  // the joiner joins and leaves; its request waits in the room
  const joiner = await ceroOpen(t, { testnet })
  const waiting = joiner.me._join(invite, 'team', { timeout: 1000 }).catch((e) => e)
  await nextRequest(room)
  await waiting
  await joiner.me.close()

  // the member restarts before approving, and still sees the request
  await owner.me.close()
  const back = await reopen(t, owner.dir, testnet)
  const again = await open(back.team, { id })
  await accept(again, await nextRequest(again))

  const returned = await reopen(t, joiner.dir, testnet)
  t.ok(await joined(returned, id), 'approved while the joiner was away')
})

// an invite nobody serves: the join stays pending
function nowhere(opts) {
  const random = () => Identity.randomBytes(32)
  const link = { key: random(), length: 1 }
  return Invite.create({ key: random(), address: random(), link, ...opts }).toString()
}

test('invites: an invite nothing can be sealed to is refused before a join is written', async (t) => {
  const { me } = await ceroOpen(t)
  const fields = Invite.parse(nowhere())
  const bad = new Invite({ ...fields, _str: null, address: b4a.alloc(32) }).toString()
  const err = await open(me.team, bad).catch((e) => e)
  t.is(err?.code, 'INVALID_INVITE')
  t.alike(await joinsOf(me), [], 'no join waits on it')
})

test('invites: an owner back online answers its invites without opening the room', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const { id } = room
  const invite = await cero.invite(room)
  await owner.me.close()

  const joiner = await ceroOpen(t, { testnet })
  joiner.me._join(invite, 'team', { timeout: 0 }).catch(() => {})

  // the app only boots; nobody opens the room
  await reopen(t, owner.dir, testnet)
  t.ok(await joined(joiner.me, id), 'admitted by the room reopened at boot')
})

test('invites: a confirm invite reopened at boot still waits for the app', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const { id } = room
  const invite = await cero.invite(room, { confirm: true })
  await owner.me.close()

  const joiner = await ceroOpen(t, { testnet })
  joiner.me._join(invite, 'team', { timeout: 0 }).catch(() => {})

  const back = await reopen(t, owner.dir, testnet)
  const served = await waitUntil(() => [...back.children].find((c) => c.id === id) || null)
  const request = await nextRequest(served)
  t.is((await get(served.members)).data.length, 1, 'waiting for the app, not admitted')
  await accept(served, request)
  t.ok(await joined(joiner.me, id))
})

test('invites: cero.invite resolves once the row that reopens the handle at boot is written', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  // a loaded runner: the local store answers its reads late, so a close right after the invite
  // would slice between the row's read and its write
  const store = owner.me.local.store
  const read = store._read.bind(store)
  store._read = async (ref, id) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return read(ref, id)
  }
  await cero.invite(room)
  await owner.me.close()

  const back = await reopen(t, owner.dir, testnet)
  await waitUntil(() => [...back.children].find((c) => c.id === room.id) || null)
  t.pass('the room with a live invite reopened at boot')
})

test('invites: a room with no invite left is not reopened at boot', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const serving = async (me) => (await me.local.store.get('serving')).data.length
  const invite = await cero.invite(room)
  await waitUntil(async () => ((await serving(owner.me)) === 1 ? true : null))

  const joiner = await ceroOpen(t, { testnet })
  await open(joiner.me.team, invite)
  await waitUntil(async () => ((await serving(owner.me)) === 0 ? true : null))
  t.pass('the used invite takes the room off the list')
})

test('invites: a room reopened at boot to serve its invite closes once it serves none', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const invite = await cero.invite(room)
  await owner.me.close()

  const back = await reopen(t, owner.dir, testnet, { keepOpen: 0 })
  const served = await joined(back, room.id)
  const joiner = await ceroOpen(t, { testnet })
  await open(joiner.me.team, invite)
  await waitUntil(() => served.closed || null)
  t.pass('the used invite let the room close')
})

test('invites: a room left with invites is dropped from the list at boot', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  await cero.invite(room)
  await waitUntil(async () =>
    (await owner.me.local.store.get('serving')).data.length ? true : null
  )
  await owner.me.store.call('del-handle', { id: room.id })
  await owner.me.close()

  const back = await reopen(t, owner.dir, testnet)
  await waitUntil(async () => ((await back.local.store.get('serving')).data.length ? null : true))
  t.is(back.children.size, 0, 'nothing reopened')
})

test('invites: a reader invite joins through cero() and reads', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  await put(room.messages, { text: 'hello' })
  const invite = await cero.invite(room, { role: 'reader' })

  const joiner = await ceroOpen(t, { testnet })
  const joined = await open(joiner.me.team, invite)
  t.is(joined.id, room.id)
  t.absent(joined.store.writable, 'a reader has no writer')
  const row = await waitUntil(async () => (await get(joined.messages)).data[0] || null)
  t.is(row.text, 'hello')
})

test('roles: a reader promoted to member can write', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const joiner = await ceroOpen(t, { testnet })
  const joined = await open(joiner.me.team, await cero.invite(room, { role: 'reader' }))
  t.absent(joined.store.writable)

  // her device seated itself: the owner has the member once that claim reached it
  await waitUntil(async () => (await get(room.members, joiner.me.identity.id)).data)
  await set(room.members, { id: joiner.me.identity.id, role: 'member' })
  await waitUntil(() => joined.store.writable || null)
  await put(joined.messages, { text: 'promoted' })
  const row = await waitUntil(
    async () => (await get(room.messages)).data.find((m) => m.text === 'promoted') || null
  )
  t.ok(row, 'its write reaches the owner')
})

test('invites: an admin invite joins through cero() with admin rights', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const joiner = await ceroOpen(t, { testnet })
  const joined = await open(joiner.me.team, await cero.invite(room, { role: 'admin' }))

  const { data: member } = await get(joined.members, joiner.me.identity.id)
  t.is(member.role, 'admin')
  t.ok(joined.store.writable)
  t.ok(await cero.invite(joined, { role: 'member' }), 'an admin mints invites')
})

test('invites: a pending join is listed, survives a restart, and a cancel ends it for good', async (t) => {
  const joiner = await ceroOpen(t)
  const invite = nowhere()
  const err = await joiner.me._join(invite, 'team', { timeout: 500 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT')
  t.alike(await joinsOf(joiner.me), [invite])
  await joiner.me.close()

  const again = await reopen(t, joiner.dir, joiner.testnet)
  t.alike(await joinsOf(again), [invite], 'still pending after the restart')
  t.ok(await cero.cancel(again, invite))
  t.alike(await joinsOf(again), [])
  t.absent(await cero.cancel(again, invite), 'nothing left to cancel')
  await again.close()

  const last = await reopen(t, joiner.dir, joiner.testnet)
  t.alike(await joinsOf(last), [], 'not resumed')
  t.is(last._joining.size, 0)
})

test('invites: a join that took its seat is not resumed at boot', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const invite = await cero.invite(room)
  const joiner = await ceroOpen(t, { testnet })
  await open(joiner.me.team, invite)
  await joiner.me.close()

  const again = await reopen(t, joiner.dir, testnet)
  t.alike(await joinsOf(again), [])
  t.is(again._joining.size, 0, 'nothing resumed')
})

// the root's row of the room an invite leads to
const standing = async (me, invite) =>
  (await get(me.team, hid.encode(Invite.parse(invite).key))).data

test('invites: a caller waiting on a cancelled join hears CANCELLED, and its row reads cancelled', async (t) => {
  const { me } = await ceroOpen(t)
  const invite = nowhere()
  const waiting = me._join(invite, 'team', { timeout: 0 }).catch((e) => e)
  await waitUntil(async () => (await standing(me, invite))?.state === 'asking' || null)
  const row = await standing(me, invite)
  t.is(row.invite, invite, 'the row names the invite it asks with')
  t.absent(row.encryptionKey, 'and holds no key yet')
  t.is((await open(me.team, { id: row.id }).catch((e) => e)).code, 'UNKNOWN', 'so it opens no room')
  t.alike((await get(me.topics)).data, [], 'and hears no push')
  await cero.cancel(me, invite)
  t.is((await waiting).code, 'CANCELLED')
  t.is((await standing(me, invite)).state, 'cancelled')
  t.is(
    (await open(me.team, invite).catch((e) => e)).code,
    'CANCELLED',
    'the same invite ends the same way'
  )
})

test('invites: a join reads asking until it is answered, joining once the keys arrive, and in once this device is seated', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const invite = await cero.invite(room, { confirm: true })
  const joiner = await ceroOpen(t, { testnet })

  // the row as it reads when the keys have arrived and the room is about to be entered
  const enter = joiner.me._enter
  let entering = null
  joiner.me._enter = async function (...args) {
    entering = await standing(joiner.me, invite)
    return enter.apply(this, args)
  }
  const joining = open(joiner.me.team, invite)
  const request = await nextRequest(room)
  t.is((await standing(joiner.me, invite)).state, 'asking', 'asking while nobody answered')
  await accept(room, request)
  const child = await joining
  t.is(entering.state, 'joining')
  t.ok(entering.encryptionKey, 'joining holds the keys')
  const row = await standing(joiner.me, invite)
  t.is(row.state, 'in')
  t.is(row.id, child.id)
  t.ok(child.store.writable)
})

test('invites: a pending join ends when its invite expires, and says so', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  const invite = nowhere({ ttl: 1500 })
  const err = await me._join(invite, 'team', { timeout: 200 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT', 'the caller stops waiting first')
  await waitUntil(() => errors.length || null)
  t.is(errors[0].code, 'EXPIRED', 'nobody waits, so onerror hears it')
  t.alike(await joinsOf(me), [])
  t.is((await standing(me, invite)).state, 'expired', 'and its row reads expired')
})

test('invites: a denial reaches the caller, or onerror once nobody waits', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const invite = () => cero.invite(room, { confirm: true })

  const errors = []
  const onerror = (err) => errors.push(err)
  const waited = await ceroOpen(t, { testnet, onerror })
  const asked = await invite()
  const joining = waited.me._join(asked, 'team', { timeout: 0 }).catch((e) => e)
  const first = await nextRequest(room)
  await deny(room, first, 'not now')
  t.is((await joining).code, 'DENIED', 'the caller hears it')
  t.is(errors.length, 0, 'and onerror does not')
  const row = await standing(waited.me, asked)
  t.alike([row.state, row.reason], ['denied', 'not now'], 'its row reads denied, with the reason')

  // the joiner joins and leaves; the denial waits in the member's outbox for its return
  const away = await ceroOpen(t, { testnet })
  await away.me._join(await invite(), 'team', { timeout: 1000 }).catch((e) => e)
  const second = await nextRequest(room, first)
  await away.me.close()
  await deny(room, second, 'not now')

  const back = await reopen(t, away.dir, testnet, { onerror })
  await waitUntil(() => errors.length || null)
  t.is(errors[0].code, 'DENIED', 'a resumed join reports to onerror')
  t.alike(await joinsOf(back), [])
})

test('invites: a promise withdrawn while the joiner waits for its seat ends its open DENIED, with the reason', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const joiner = await ceroOpen(t, { testnet })
  const promised = () =>
    waitUntil(async () => (await get(room.requests)).data.find((r) => r.promised) || null)
  const withdraw = async () => deny(room, await promised(), 'not you')

  const invite = await cero.invite(room)
  const err = await refusedAtClaim(t, joiner.me, joiner.me.team, invite, withdraw)
  t.is(err.code, 'DENIED', 'the caller hears it')
  t.is(err.reason, 'not you')
  t.alike(await joinsOf(joiner.me), [], 'and the join is over')
  t.is((await get(joiner.me.team, { state: 'in' })).data.length, 0, 'in no room')
  const row = await standing(joiner.me, invite)
  t.alike([row.state, row.reason], ['denied', 'not you'], 'its row reads denied, with the reason')
  t.absent((await get(room.members, joiner.me.id)).data, 'and no member of it')
})

// a join whose caller stopped waiting, landing once the owner is back
async function unclaimed(t, opts) {
  const testnet = await makeTestnet(t)
  const { me: owner } = await ceroOpen(t, { testnet })
  const room = await open(owner.team, { name: 'clinic' })
  const invite = await cero.invite(room)
  await cero.suspend(owner)

  const { me: joiner } = await ceroOpen(t, { testnet, ...opts })
  const err = await joiner._join(invite, 'team', { timeout: 300 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT', 'the caller stops waiting')
  const landed = new Promise((resolve) => joiner.once('handle', resolve))
  await cero.resume(owner)
  return { joiner, room: await landed }
}

test('invites: a join that lands with nobody waiting is let go', async (t) => {
  const { room } = await unclaimed(t, { keepOpen: 0 })
  await waitUntil(() => room.closed, 10000)
  t.pass('nobody opened it, so it closed')
})

test("invites: a join that lands with nobody waiting is the app's once it opens it", async (t) => {
  const { joiner, room } = await unclaimed(t)
  t.ok(joiner._idle.has(room), 'idle until somebody opens it')
  const mine = await open(joiner.team, { id: room.id })
  t.is(mine, room, 'opened while idle, the same handle')
  t.absent(joiner._idle.has(mine), 'and held')
  await mine.close()
  t.ok(joiner._idle.has(mine), 'its close lets it go')
  t.absent(mine.closing, 'still open for the next one')
})

// the reply landed and the joiner stopped before taking its seat: its row has the keys
async function replied(me, invite, { key, encryptionKey, epochs, writer }) {
  const id = hid.encode(key)
  const ts = Date.now()
  await me._saveKeyPair(id, writer, invite)
  const asking = { id, type: 'team', key, name: null, createdAt: ts, updatedAt: ts, invite }
  await me.store.call('add-handle', { ...asking, state: 'asking' })
  await me.store.set('handles', {
    id,
    state: 'joining',
    encryptionKey,
    epochs: c.encode(epochEntries, epochs)
  })
}

// the joiner's store hangs on one write, as a device that stops mid-write does
function stall(store, method, when) {
  const call = store[method].bind(store)
  let stopping
  const stopped = new Promise((resolve) => (stopping = resolve))
  store[method] = (...args) => {
    if (!when(...args)) return call(...args)
    stopping()
    return new Promise(() => {})
  }
  return stopped
}

test('invites: a reply the joiner stopped before keeping is handed over again after a restart', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const invite = await cero.invite(room)

  const joiner = await ceroOpen(t, { testnet })
  const stopped = stall(joiner.me.store, 'set', (name, row) => row.state === 'joining')
  joiner.me._join(invite, 'team', { timeout: 0 }).catch(() => {})
  await stopped
  await joiner.me.close()

  // a read settles nothing: she was let in, and stays so until her device has taken its seat
  t.is((await get(room.requests)).data.length, 1, 'let in, the reply read and not kept')
  const again = await reopen(t, joiner.dir, testnet)
  t.ok(await joined(again, room.id), 'the reply opens the room')
  await waitUntil(async () => ((await get(room.requests)).data.length === 0 ? true : null))
  t.pass('and a member settles it once she is seated')
})

test('invites: a joiner closing as its reply goes out joins once it opens again', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const invite = await cero.invite(room)

  const joiner = await ceroOpen(t, { testnet })
  // the joiner closes the moment the member puts its reply on the wire
  const { store } = owner.me.network
  const get = store.get.bind(store)
  let closing = null
  store.get = (opts) => {
    const core = get(opts)
    if (opts?.name) core.on('upload', () => (closing ??= joiner.me.close()))
    return core
  }
  joiner.me._join(invite, 'team', { timeout: 0 }).catch(() => {})
  await waitUntil(() => !!closing)
  await closing

  const again = await reopen(t, joiner.dir, testnet)
  t.ok(await joined(again, room.id).catch(() => null), 'the room opens after the reopen')
})

test('invites: a denial the joiner stopped before forgetting is handed over again after a restart', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const invite = await cero.invite(room, { confirm: true })

  const joiner = await ceroOpen(t, { testnet })
  const stopped = stall(joiner.me.store, 'set', (name, row) => row.state === 'denied')
  joiner.me._join(invite, 'team', { timeout: 0 }).catch(() => {})
  await deny(room, await nextRequest(room), 'not now')
  await stopped
  await joiner.me.close()

  const errors = []
  const again = await reopen(t, joiner.dir, testnet, { onerror: (err) => errors.push(err) })
  await waitUntil(() => errors.length || null)
  t.is(errors[0].code, 'DENIED', 'the kept denial ends the resumed join')
  t.alike(await joinsOf(again), [])
})

test('mirrors: absent opt leaves blind peering off', async (t) => {
  const { me } = await ceroOpen(t)
  t.is(me.network._blindPeering, null, 'no mirrors → no blind peering')
})

test('channel stamp: reopening under a different channel throws', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const a = await cero(dir, spec, { bootstrap: testnet.bootstrap, channel: 'dev' })
  await a.close()
  await t.exception(
    cero(dir, spec, { bootstrap: testnet.bootstrap, channel: 'prod' }),
    /CHANNEL_MISMATCH/
  )
  const c = await cero(dir, spec, { bootstrap: testnet.bootstrap, channel: 'dev' })
  t.teardown(() => c.close().catch(() => {}), { order: 5 })
  t.ok(c.id, 'same channel reopens fine')
})

test('channel stamp: reopening WITHOUT a channel throws instead of joining the global network', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const a = await cero(dir, spec, { bootstrap: testnet.bootstrap, channel: 'dev' })
  await a.close()
  await t.exception(cero(dir, spec, { bootstrap: testnet.bootstrap }), /CHANNEL_MISMATCH/)
})

test('channel stamp: an un-stamped storage adopts any channel', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const a = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  await a.close()
  const b = await cero(dir, spec, { bootstrap: testnet.bootstrap, channel: 'dev' })
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  t.ok(b.id, 'no prior stamp → adopts the channel')
})

// ─── construction ─────────────────────────────────────────────────────────

test('cero: a failed open releases the storage lock so a retry succeeds', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  await t.exception(
    cero(dir, spec, {
      bootstrap: testnet.bootstrap,
      phrase: 'not a phrase'
    }),
    /INVALID/,
    'invalid phrase rejected'
  )
  // a retry on the same dir must not hit a corestore lock leaked by the failure
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.ok(me.id, 'retry opened cleanly — storage was not left locked')
})

test('cero: a recovery that times out releases the storage lock', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const phrase = (await Identity.create()).toPhrase()
  const opts = { bootstrap: testnet.bootstrap, phrase, recoveryTimeout: 500 }
  await t.exception(cero(dir, spec, opts), /TIMEOUT/)
  await t.exception(cero(dir, spec, opts), /TIMEOUT/, 'the retry recovers again, no lock held')
})

test('cero: a first launch that dies setting up finishes as the same identity on the next', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  let first = null
  // the launch dies as the root starts to open, before anything of it landed
  const dies = {
    setup(me) {
      if (first) return
      first = { id: me.identity.id, writer: me.store.keyPair.publicKey }
      me.store.close()
    }
  }
  const opts = { bootstrap: testnet.bootstrap, extensions: [dies], recoveryTimeout: 2000 }
  await t.exception(cero(dir, spec, opts), /CLOSED/)

  const me = await cero(dir, spec, opts)
  t.is(me.id, first.id, 'the same identity, created, not recovered')
  t.alike(me.store.keyPair.publicKey, first.writer, 'with the device key it began with')
  t.ok(me.store.writable, 'set up')

  const row = (await get(me.devices, me.device.id)).data
  await me.close()
  const again = await cero(dir, spec, opts)
  t.teardown(() => again.close().catch(() => {}), { order: 5 })
  const { data } = await get(again.devices, again.device.id)
  t.alike(data, row, 'a finished setup is not run again')
})

test('cero: a first launch that dies setting up, reopened with a phrase, recovers it', async (t) => {
  const testnet = await makeTestnet(t)
  const { me: a } = await ceroOpen(t, { testnet })
  const dir = await t.tmp()
  const dies = { setup: (me) => me.store.close() }
  await t.exception(cero(dir, spec, { bootstrap: testnet.bootstrap, extensions: [dies] }), /CLOSED/)

  const b = await cero(dir, spec, { bootstrap: testnet.bootstrap, phrase: a.identity.toPhrase() })
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  t.is(b.id, a.id, 'the identity of the phrase')
  t.alike(b.store.key, a.store.key, 'recovered into its database, never created')
})

test('cero: a set-up dir keeps its identity, another phrase is INVALID', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const opts = { bootstrap: testnet.bootstrap }
  const a = await cero(dir, spec, opts)
  const { id } = a.identity
  const phrase = a.identity.toPhrase()
  await a.close()

  const other = await Identity.create()
  await t.exception(cero(dir, spec, { ...opts, phrase: other.toPhrase() }), /INVALID/)
  const same = await cero(dir, spec, { ...opts, phrase })
  t.is(same.id, id, 'its own phrase opens it')
  await same.close()

  const me = await cero(dir, spec, opts)
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.is(me.id, id, 'the stored identity is untouched')
})

test('cero: a recovery that dies once seated resumes with its device key, no dead seat', async (t) => {
  const testnet = await makeTestnet(t)
  const { me: a } = await ceroOpen(t, { testnet })
  let seat = null
  // the launch dies once the other device seated it, before its device row lands
  const dies = {
    setup(me) {
      cero.before(me.devices, async (ctx) => {
        if (seat || ctx.op !== 'set' || ctx.id !== me.device?.id) return true
        seat = ctx.id
        await waitUntil(async () => (await get(a.devices, seat)).data)
        return false
      })
    }
  }
  const dir = await t.tmp()
  const opts = { bootstrap: testnet.bootstrap, phrase: a.identity.toPhrase(), extensions: [dies] }
  await t.exception(cero(dir, spec, opts), /REFUSED/)

  const b = await cero(dir, spec, opts)
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  t.is(b.device.id, seat, 'resumed with the device key it began with')
  await waitUntil(async () => (await get(a.devices, b.device.id)).data)
  t.is((await get(a.devices)).data.length, 2, 'one seat per machine, no dead one')
})

test('cero(): rejects bad dir', async (t) => {
  await t.exception.all(() => cero(null, spec), /dir/)
  await t.exception.all(() => cero('', spec), /dir/)
})

test('cero(): rejects missing spec', async (t) => {
  const dir = await t.tmp()
  await t.exception.all(() => cero(dir, null), /spec is required/)
})

// ─── peek ─────────────────────────────────────────────────────────────────

test('peek(): null on fresh dir', async (t) => {
  const dir = await t.tmp()
  t.is(await peek(dir, spec), null)
})

test('peek(): ready after cero() seeds master', async (t) => {
  const { me, dir } = await ceroOpen(t)
  await me.close()
  t.is(await peek(dir, spec), 'ready')
})

test('peek(): a recovery or a link still waiting for a device of its identity reads as one', async (t) => {
  const testnet = await makeTestnet(t)
  const { me: owner } = await ceroOpen(t, { testnet })
  const opts = { bootstrap: testnet.bootstrap, recoveryTimeout: 500 }

  const recovering = await t.tmp()
  const phrase = (await Identity.create()).toPhrase()
  await t.exception(cero(recovering, spec, { ...opts, phrase }), /TIMEOUT/)
  t.is(await peek(recovering, spec), 'recovering')

  const linking = await t.tmp()
  const invite = await cero.invite(owner)
  await t.exception(cero(linking, spec, { ...opts, invite }), /TIMEOUT/)
  t.is(await peek(linking, spec), 'linking')
})

test('cero(): a phrase that is no BIP-39 mnemonic is refused before anything is stored', async (t) => {
  const dir = await t.tmp()
  await t.exception(cero(dir, spec, { phrase: 'eleven words are not a phrase' }), /BIP-39/)
  t.absent(fs.existsSync(`${dir}/main`), 'no store')
  t.is(await peek(dir, spec), null)
})

test('cero(): a recovery stopped while it waits goes on at the next open, with no phrase, once a device of it is online', async (t) => {
  const testnet = await makeTestnet(t)
  const opts = { bootstrap: testnet.bootstrap }
  const ownerDir = await t.tmp()
  const owner = await cero(ownerDir, spec, opts)
  const { id } = owner
  const phrase = owner.identity.toPhrase()
  await owner.close()

  const dir = await t.tmp()
  await t.exception(cero(dir, spec, { ...opts, phrase, recoveryTimeout: 500 }), /TIMEOUT/)
  const resumed = cero(dir, spec, { ...opts, recoveryTimeout: 0 })
  const again = await cero(ownerDir, spec, opts)
  t.teardown(() => again.close().catch(() => {}), { order: 6 })
  const me = await resumed
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.is(me.id, id, 'the identity of the phrase')
  t.alike(me.store.key, again.store.key, 'recovered into its database')
})

test('peek(): ready after reopening with the stored phrase', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const first = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  const phrase = await cero.phrase(first)
  await first.close()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, phrase })
  await me.close()
  t.is(await peek(dir, spec), 'ready')
})

test('cero(): a storage from before device keys is refused, to be recreated', async (t) => {
  const { me, dir, testnet } = await ceroOpen(t)
  // the seed stored with no device key beside it: what an older cero left
  await me.local.store.del('device')
  await me.close()
  t.is(await peek(dir, spec), null, 'no device, no identity to open')
  await t.exception(cero(dir, spec, { bootstrap: testnet.bootstrap }), /predates device keys/)
})

// the rows a first launch had written when it was killed between its seed and its device row
async function killedAfterSeed(dir, setup, seed) {
  const storage = new HypercoreStorage(`${dir}/main`)
  const store = new Corestore(storage, { manifestVersion: 2 })
  const local = new Local(null, spec, { store })
  await local.ready()
  const keyPair = Identity.randomKeyPair()
  await local.store.set('keypair', { ...keyPair, setup })
  await local.store.set('master', { seed })
  await local.close()
  await store.close()
  await storage.close()
  return keyPair
}

test('cero(): a first launch killed between its seed and its device row resumes', async (t) => {
  const testnet = await makeTestnet(t)
  const opts = { bootstrap: testnet.bootstrap }

  const dir = await t.tmp()
  const seed = Identity.randomBytes(16)
  const writer = await killedAfterSeed(dir, 'create', seed)
  const me = await cero(dir, spec, opts)
  t.is(me.id, (await Identity.create({ seed })).id, 'the identity of the stored seed')
  t.alike(me.store.keyPair.publicKey, writer.publicKey, 'with the device key it began with')
  t.ok(me.store.writable, 'created')
  await me.close()
  const again = await cero(dir, spec, opts)
  t.is(again.id, me.id, 'and the launch after keeps it')
  await again.close()

  const { me: owner } = await ceroOpen(t, { testnet })
  const phrase = owner.identity.toPhrase()
  const fresh = await t.tmp()
  await killedAfterSeed(fresh, 'recover', Identity.toSeed(phrase))
  const b = await cero(fresh, spec, { ...opts, phrase })
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  t.is(b.id, owner.id, 'a phrase recovery resumes as the identity of the phrase')
  t.alike(b.store.key, owner.store.key, 'into its database')
})

test('cero(): a phrase recovery killed before its device row resumes with no phrase, never creates', async (t) => {
  const testnet = await makeTestnet(t)
  const { me: owner } = await ceroOpen(t, { testnet })
  const dir = await t.tmp()
  await killedAfterSeed(dir, 'recover', Identity.toSeed(owner.identity.toPhrase()))
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.is(me.id, owner.id, 'the identity of the stored seed')
  t.alike(me.store.key, owner.store.key, 'recovered into its database')
})

test('cero(): a relaunch with no reachable bootstrap opens as fast as one with', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const first = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  await put(first.messages, { text: 'x' })
  await first.close()

  async function relaunch(bootstrap) {
    const start = Date.now()
    const me = await cero(dir, spec, { bootstrap })
    const took = Date.now() - start
    await me.close()
    return took
  }
  // the best of three each: one slow launch under load is no wait
  const best = async (bootstrap) =>
    Math.min(await relaunch(bootstrap), await relaunch(bootstrap), await relaunch(bootstrap))
  const online = await best(testnet.bootstrap)
  const offline = await best([{ host: '127.0.0.1', port: 9 }])
  t.comment(`online ${online} ms, offline ${offline} ms`)
  t.ok(offline < online + 300, 'no wait on a network that is not there')
})

test("cero(): the identity's secret key is not on disk", async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const opts = { bootstrap: testnet.bootstrap, storageKey: b4a.alloc(32, 5) }
  const me = await cero(dir, spec, opts)
  const { secretKey } = await Identity.keyPair(me.identity.seed)
  const phrase = me.identity.toPhrase()
  await me.close()
  // a sodium secret key is its seed then its public key: the first half is the secret
  t.absent(await diskContains(dir, secretKey.subarray(0, 32)), 'not under the dir')

  const again = await cero(dir, spec, opts)
  t.ok(again.store.writable, 'the creating device relaunches')
  const b = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap, phrase })
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  await again.close()
  t.alike(b.store.key, me.store.key, 'and a recovery reads the pointer it wrote')
})

test('peek: reads a store opened with a storageKey', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const storageKey = b4a.alloc(32, 7)
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, storageKey })
  await me.close()
  t.is(await peek(dir, spec, { storageKey }), 'ready', 'an identity, read with its key')
  t.is(await peek(await t.tmp(), spec, { storageKey }), null, 'a fresh dir holds none')
})

test('peek(): rejects bad dir', async (t) => {
  await t.exception.all(() => peek(null, spec), /dir/)
  await t.exception.all(() => peek('', spec), /dir/)
})

test('peek(): rejects missing spec', async (t) => {
  const dir = await t.tmp()
  await t.exception.all(() => peek(dir, null), /spec is required/)
})

// ─── restore ──────────────────────────────────────────────────────────────

async function withPeer(t) {
  const testnet = await makeTestnet(t)
  const a = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => a.close().catch(() => {}), { order: 5 })
  return { testnet, a, phrase: await cero.phrase(a) }
}

test('restore(): rejects bad input', async (t) => {
  const { testnet } = await withPeer(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })

  await t.exception.all(() => restore(null, 'x'), /me/)
  await t.exception.all(() => restore(me, null), /REQUIRED/)
  await t.exception.all(() => restore(me, 'words'), /BIP-39/)
  await t.exception.all(() => restore(me, me.identity.seed), /BIP-39/, 'a seed is not a phrase')
})

test('restore(): swaps identity to the given phrase', async (t) => {
  const { testnet, a, phrase } = await withPeer(t)

  let b = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  const oldId = b.id
  b = await restore(b, phrase)
  t.teardown(() => b.close().catch(() => {}), { order: 5 })

  t.not(b.id, oldId, 'identity changed')
  t.is(b.id, a.id, 'matches the peer with the same phrase')
  t.is(await cero.phrase(b), phrase, 'phrase round-trips')
})

test('restore(): wipes prior local store data', async (t) => {
  const { testnet, phrase } = await withPeer(t)

  const dir = await t.tmp()
  let me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  await put(me.messages, { text: 'before-restore' })
  t.is((await get(me.messages)).data.length, 1, 'wrote data before restore')

  me = await restore(me, phrase)
  t.teardown(() => me.close().catch(() => {}), { order: 5 })

  t.is((await get(me.messages)).data.length, 0, 'old data is wiped')
})

// restore() must carry `channel`: without it the recovered instance announces
// on the global topic while its peers are on the channeled one
test('restore(): carries the channel so channeled peers still meet', async (t) => {
  const testnet = await makeTestnet(t)
  const channel = 'test-channel'

  const a = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap, channel })
  const phrase = await cero.phrase(a)
  t.teardown(() => a.close().catch(() => {}), { order: 5 })
  await put(a.messages, { text: 'from-old-device' })

  const bDir = await t.tmp()
  const storageKey = b4a.alloc(32, 9)
  let b = await cero(bDir, spec, { bootstrap: testnet.bootstrap, channel, storageKey })
  b = await restore(b, phrase)
  t.teardown(() => b.close().catch(() => {}), { order: 5 })

  t.is(b.id, a.id, 'restore succeeded on a channeled network')
  const row = await waitUntil(async () => {
    const { data } = await get(b.messages)
    return data.find((m) => m.text === 'from-old-device') ?? null
  })
  t.ok(row, 'old-device data replicated to the recovered instance')
  t.absent(
    await diskContains(`${bDir}/main`, Identity.toSeed(phrase)),
    'restore carried storageKey — recovered seed stays encrypted'
  )
})

test('storageKey: master seed encrypted at rest, same key reopens', async (t) => {
  const testnet = await makeTestnet(t)
  const key = b4a.alloc(32, 3)

  const plainDir = await t.tmp()
  const p = await cero(plainDir, spec, { bootstrap: testnet.bootstrap })
  const plainSeed = (await p.local.store.get('master')).data.seed
  await p.close()
  t.ok(
    await diskContains(`${plainDir}/main`, plainSeed),
    'control: seed on disk without storageKey'
  )

  const dir = await t.tmp()
  const a = await cero(dir, spec, { bootstrap: testnet.bootstrap, storageKey: key })
  const id = a.id
  const seed = (await a.local.store.get('master')).data.seed
  const device = a.identity.device.secretKey.subarray(0, 32)
  await a.close()
  t.absent(await diskContains(`${dir}/main`, seed), 'seed unreadable on disk with storageKey')
  t.absent(await diskContains(`${dir}/main`, device), "and this device's key")

  const b = await cero(dir, spec, { bootstrap: testnet.bootstrap, storageKey: key })
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  t.is(b.id, id, 'same identity reopens with the key')
})

// a closed child's blob core keys must leave the root registry, or the file
// server keeps serving them for the root's whole life
test('closing a child prunes its blob core keys from the root', async (t) => {
  const { me } = await ceroOpen(t, { keepOpen: 0 })
  const room = await open(me.team, { name: 'blobby' })

  const { data: file } = await put(room.files, { data: b4a.from('x'), type: 'text/plain' })
  await get(room.files, file.id)
  const hex = b4a.toHex(decodeId(file.id).coreKey)
  t.ok(me._coreKeys.has(hex), 'blob core registered while open')

  await room.close()
  t.absent(me._coreKeys.has(hex), 'pruned on close')
})

test('storage dir perms tightened to 0700', async (t) => {
  if (process.platform === 'win32') return t.pass('perms not enforced on windows')
  const { dir } = await ceroOpen(t)
  const mode = (await fs.promises.stat(`${dir}/main`)).mode & 0o777
  t.is(mode, 0o700)
})

async function diskContains(dir, needle) {
  const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true })
  for (const e of entries) {
    if (!e.isFile()) continue
    const buf = await fs.promises.readFile(path.join(e.parentPath, e.name))
    if (buf.includes(needle)) return true
  }
  return false
}

// The flip side of carrying the channel: isolation still holds. A restored
// instance keeps ITS channel, so a peer announcing on a different channel must
// never be found — recovery fails within the (also carried) recoveryTimeout.
test('restore(): keeps channel isolation from peers on another channel', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await cero(await t.tmp(), spec, {
    bootstrap: testnet.bootstrap,
    channel: 'channel-one'
  })
  const phrase = await cero.phrase(a)
  t.teardown(() => a.close().catch(() => {}), { order: 5 })

  const b = await cero(await t.tmp(), spec, {
    bootstrap: testnet.bootstrap,
    channel: 'channel-two',
    recoveryTimeout: 2000
  })
  t.teardown(() => b.close().catch(() => {}), { order: 5 })

  await t.exception(
    () => restore(b, phrase),
    /TIMEOUT/,
    'cross-channel recovery finds no peer and times out'
  )
})

test('restore(): no-op when the phrase is the current identity', async (t) => {
  const { a, phrase } = await withPeer(t)
  await put(a.messages, { text: 'keep-me' })

  const same = await restore(a, phrase)

  t.is(same, a, 'returns the same running instance')
  t.is(same.id, a.id, 'identity unchanged')
  t.is((await get(a.messages)).data.length, 1, 'data is not wiped')
})

test('restore(): identity persists across reopen', async (t) => {
  const { testnet, phrase } = await withPeer(t)
  const dir = await t.tmp()

  let me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  me = await restore(me, phrase)
  const restoredId = me.id
  await me.close()

  me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.is(me.id, restoredId, 'same identity on reopen')
  t.is(await cero.phrase(me), phrase, 'phrase preserved')
})

test('restore(): peek reflects the new identity', async (t) => {
  const { testnet, phrase } = await withPeer(t)
  const dir = await t.tmp()

  let me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  me = await restore(me, phrase)
  await me.close()

  t.is(await peek(dir, spec), 'ready', 'peek sees new identity')
})

test('restore(): syncs data from the peer holding the phrase', async (t) => {
  const { testnet, a, phrase } = await withPeer(t)
  await set(a.profile, { name: 'jb' })

  let b = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  b = await restore(b, phrase)
  t.teardown(() => b.close().catch(() => {}), { order: 5 })

  await waitUntil(async () => (await get(b.profile)).data?.name === 'jb')
  t.is((await get(b.profile)).data.name, 'jb', 'profile replicated from peer')
})

// ─── lifecycle ────────────────────────────────────────────────────────────

test('cero(): opens, exposes identity, closes cleanly', async (t) => {
  const { me } = await ceroOpen(t)
  t.ok(me.id, 'id exposed')
  t.ok(me.identity, 'identity exposed')
  t.ok(me.network, 'network exposed')
  t.ok(me.store, 'store exposed')
  t.ok(me, 'root exposed')
  t.ok(me.local, 'local exposed')
  t.ok(me.team && me.team.kind === 'handle', 'team ref exposed')
  t.ok(typeof me._join === 'function', '_join() internal method exposed')
  await me.close()
})

// ─── identity sources ─────────────────────────────────────────────────────

test('cero(): from phrase', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const first = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  const phrase = await cero.phrase(first)
  await first.close()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, phrase })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.is(await cero.phrase(me), phrase)
})

// ─── refs lifted onto facade ──────────────────────────────────────────────

test('cero(): lifts private refs onto facade', async (t) => {
  const { me } = await ceroOpen(t)
  t.ok(me.profile, 'profile lifted')
  t.ok(me.messages, 'messages lifted')
})

// ─── private scope ────────────────────────────────────────────────────────

test('cero(): put/get on private refs', async (t) => {
  const { me } = await ceroOpen(t)
  const { data: row } = await put(me.messages, { text: 'hi' })
  t.ok(row.id)
  await set(me.profile, { name: 'jb' })
  const { data } = await get(me.profile)
  t.is(data.name, 'jb')
})

// ─── local scope ──────────────────────────────────────────────────────────

test('cero(): put/get on local refs', async (t) => {
  const { me } = await ceroOpen(t)
  await put(me.local.drafts, { text: 'draft' })
  const { data: list } = await get(me.local.drafts)
  t.is(list.length, 1)
  t.is(list[0].text, 'draft')
})

// ─── public namespace ─────────────────────────────────────────────────────

test('cero(): create a public scope', async (t) => {
  const { me } = await ceroOpen(t)
  const team = await open(me.team, { name: 'my-team' })
  t.ok(team.store.writable, 'team is writable for host')
  await put(team.messages, { text: 'hi team' })
  const { data: list } = await get(team.messages)
  t.is(list.length, 1)
})

test('cero(): create rejects unknown handle type', async (t) => {
  const { me } = await ceroOpen(t)
  await t.exception.all(() => me._create('nope'), /unknown handle type/)
})

test('cero(): two public scopes coexist and are independent', async (t) => {
  const { me } = await ceroOpen(t)
  const teamA = await open(me.team, { name: 'A' })
  const teamB = await open(me.team, { name: 'B' })

  t.not(teamA.store.key, teamB.store.key, 'distinct bee keys')

  await put(teamA.messages, { text: 'in-a' })
  await put(teamB.messages, { text: 'in-b' })

  const { data: a } = await get(teamA.messages)
  const { data: b } = await get(teamB.messages)
  t.is(a.length, 1)
  t.is(b.length, 1)
  t.is(a[0].text, 'in-a')
  t.is(b[0].text, 'in-b')
})

test('cero(): close cleans up all open public scopes', async (t) => {
  const { me, testnet } = await ceroOpen(t)
  const team = await open(me.team)
  t.is(team.opened, true)
  await me.close()
  t.is(team.closed, true, 'public scope closed via composer')
  // teardown noop since me is already closed
  await new Promise((r) => setTimeout(r, 0))
  void testnet
})

// ─── persistence ──────────────────────────────────────────────────────────

test('cero(): data persists across reopen with same dir + phrase', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()

  const me1 = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  const phrase = me1.identity.toPhrase()
  await put(me1.messages, { text: 'persist me' })
  await set(me1.profile, { name: 'jb' })
  await put(me1.local.drafts, { text: 'draft-1' })
  await me1.close()

  const me2 = await cero(dir, spec, { bootstrap: testnet.bootstrap, phrase })
  t.teardown(() => me2.close().catch(() => {}), { order: 5 })

  const { data: msgs } = await get(me2.messages)
  t.is(msgs.length, 1)
  t.is(msgs[0].text, 'persist me')

  const { data: profile } = await get(me2.profile)
  t.is(profile.name, 'jb')

  const { data: drafts } = await get(me2.local.drafts)
  t.is(drafts.length, 1)
  t.is(drafts[0].text, 'draft-1')
})

// ─── auto-recovery ────────────────────────────────────────────────────────

test.skip('cero(): device B can _load a sub-handle created by device A and write to it', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet, name: 'laptop-A' })
  const phrase = a.me.identity.toPhrase()
  const room = await a.me._create('team', { name: 'general' })
  await put(room.messages, { text: 'from-a' })

  const b = await ceroOpen(t, { testnet, phrase, name: 'laptop-B' })
  // B sees the handle metadata via root replication, then loads + writes.
  const bRoom = await b.me._load('team', room.id)
  await put(bRoom.messages, { text: 'from-b' })

  const { data: msgs } = await get(bRoom.messages)
  const texts = msgs.map((m) => m.text).sort()
  t.alike(texts, ['from-a', 'from-b'])
})

test('cero(): joiner sees the joined room in its handles collection', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await ceroOpen(t, { testnet })
  const room = await host.me._create('team', { name: 'general' })
  const invite = await cero.invite(room)
  const guest = await ceroOpen(t, { testnet })
  await guest.me._join(invite, 'team')
  const { data: rows } = await get(guest.me.team)
  t.is(rows.length, 1, 'guest sees the joined room in its handles list')
  t.is(rows[0].id, room.id, 'same room id')
})

test('cero(): _load returns the existing handle by id', async (t) => {
  const { me } = await ceroOpen(t)
  const a = await me._create('team', { name: 'eng' })
  await put(a.messages, { text: 'hello' })
  const b = await me._load('team', a.id)
  t.is(b.id, a.id, 'same id')
  const { data: msgs } = await get(b.messages)
  t.is(msgs.length, 1)
  t.is(msgs[0].text, 'hello')
})

test('cero(): phrase-only recovery — device B syncs from device A without out-of-band key', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet, name: 'laptop-A' })
  const phrase = a.me.identity.toPhrase()
  await set(a.me.profile, { name: 'alice' })

  // Device B has only the phrase (no key handed over). Recovery should
  // discover device A via the identity topic and replicate its data.
  const b = await ceroOpen(t, { testnet, phrase, name: 'laptop-B' })

  t.is(b.me.id, a.me.id, 'same identity')
  const profile = await waitUntil(async () => {
    const { data } = await get(b.me.profile)
    return data && data.name === 'alice' ? data : null
  })
  t.ok(profile, 'profile replicated to device B')
  t.is(profile?.name, 'alice', 'profile data matches')

  // No ghost entries: exactly one member (the identity), exactly two devices.
  const { data: members } = await get(b.me.members)
  t.is(members.length, 1, 'one member entry')
  const { data: devices } = await get(b.me.devices)
  t.is(devices.length, 2, 'two device entries — one per physical device')
})

// ─── devices: the phrase, removal, re-adding ─────────────────────────────

const devices = (me, n) =>
  waitUntil(async () => ((await get(me.devices)).data.length === n ? true : null))

test('devices: the phrase shows on the creating device and on one recovered with it', async (t) => {
  const a = await ceroOpen(t)
  const phrase = await cero.phrase(a.me)
  const b = await ceroOpen(t, { testnet: a.testnet, phrase })
  t.is(await cero.phrase(b.me), phrase, 'a device recovered by the phrase holds it too')
})

test('devices: a removed device is re-added by the phrase, as a new device', async (t) => {
  const a = await ceroOpen(t)
  const phrase = await cero.phrase(a.me)
  const b = await ceroOpen(t, { testnet: a.testnet, phrase })
  await devices(a.me, 2)

  const removed = b.me.device.id
  await del(a.me.devices, removed)
  await devices(b.me, 1)
  await waitUntil(() => (b.me.store.writable ? null : true))
  t.pass('the removed device sees its removal and lost its writer')
  await b.me.close()

  // wiped and recovered: a new device key the phrase attests, seated again
  const c = await ceroOpen(t, { testnet: a.testnet, phrase })
  t.is(c.me.id, a.me.id, 'the same identity')
  t.not(c.me.device.id, removed, 'as a device of its own')
  await devices(a.me, 2)
  t.ok(c.me.store.writable, 'back in')
})

test('devices: a removed device reads nothing the root writes after its removal', async (t) => {
  const a = await ceroOpen(t)
  const b = await ceroOpen(t, { testnet: a.testnet, phrase: await cero.phrase(a.me) })
  await devices(a.me, 2)
  await set(a.me.profile, { name: 'seen' })
  await waitUntil(async () => ((await get(b.me.profile)).data?.name === 'seen' ? true : null))

  await del(a.me.devices, b.me.device.id)
  t.is(a.me.store.keyring.seq, 1, 'the root rotated its key with the removal')
  await set(a.me.profile, { name: 'unseen' })

  await devices(b.me, 1)
  const key = a.me.store.keyring.current
  t.absent(b.me.store.keyring.entropy(key), 'the removed device holds no key for it')
  t.is((await get(b.me.profile)).data?.name, 'seen', 'and reads nothing written after')
})

// ─── link: a device joins by invite, no phrase ────────────────────────────

const asked = (me) =>
  waitUntil(async () => (await get(me.requests)).data.find((r) => !r.admitted) || null)

// a new device linked from `from`, accepted there
async function linkTo(t, from) {
  const invite = await cero.invite(from.me)
  const linking = ceroOpen(t, { testnet: from.testnet, invite })
  await cero.accept(from.me, await asked(from.me))
  return linking
}

test('link: a device joins by an invite, accepted on another device, with no phrase', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  await put(room.messages, { text: 'before' })
  const invite = await cero.invite(a.me)
  let code = null
  const linking = ceroOpen(t, { testnet: a.testnet, invite, onrequest: (id) => (code = id) })
  const request = await asked(a.me)
  t.is(request.id, code, 'both screens show the request id')
  t.is(request.key?.byteLength, 32, 'the request carries the device key to attest')
  await cero.accept(a.me, request)
  const b = await linking
  t.is(b.me.id, a.me.id, 'the same identity')
  t.not(b.me.device.id, a.me.device.id, 'a device of its own')
  await t.exception(cero.phrase(b.me), /no phrase on this device/, 'and no phrase')
  t.absent((await b.me.local.store.get('master')).data, 'no seed on disk')
  await devices(a.me, 2)
  t.ok(b.me.store.writable, 'writes to the root')

  const mine = await open(b.me.team, { id: room.id })
  await waitUntil(async () => ((await get(mine.messages)).data.length === 1 ? true : null))
  await put(mine.messages, { text: 'from b' })
  await waitUntil(async () => ((await get(room.messages)).data.length === 2 ? true : null))
  t.pass('opens the handles by its proof and writes')
})

test('link: a linked device links another; a denied one hears it', async (t) => {
  const a = await ceroOpen(t)
  const b = await linkTo(t, a)
  const c = await linkTo(t, b)
  t.is(c.me.id, a.me.id, 'linked by a linked device')
  await devices(a.me, 3)

  const invite = await cero.invite(a.me)
  const refused = ceroOpen(t, { testnet: a.testnet, invite })
  await cero.deny(a.me, await asked(a.me), 'not mine')
  await t.exception(refused, /DENIED/)
})

test('link: a launch that stops waiting resumes on the next, with no new invite', async (t) => {
  const a = await ceroOpen(t)
  const invite = await cero.invite(a.me)
  const dir = await t.tmp()
  const opts = { bootstrap: a.testnet.bootstrap }
  await t.exception(cero(dir, spec, { ...opts, invite, recoveryTimeout: 1500 }), /TIMEOUT/)
  await t.exception(
    cero(dir, spec, { ...opts, phrase: undefined, invite: undefined, recoveryTimeout: 1500 }),
    /TIMEOUT/,
    'resumed'
  )
  await cero.accept(a.me, await asked(a.me))
  const b = await cero(dir, spec, opts)
  t.is(b.id, a.me.id, 'let in on the launch after the accept')
  await b.close()
  await t.exception(
    cero(dir, spec, { ...opts, invite }),
    /holds an identity/,
    'a set-up dir takes no invite'
  )
})

test('link: a launch stopped as its reply goes out links on the next', async (t) => {
  const a = await ceroOpen(t)
  const invite = await cero.invite(a.me)
  const dir = await t.tmp()
  const opts = { bootstrap: a.testnet.bootstrap }
  // the launch stops the moment the accepting device puts its reply on the wire
  const stop = new AbortController()
  const { store } = a.me.network
  const get = store.get.bind(store)
  store.get = (o) => {
    const core = get(o)
    if (o?.name) core.on('upload', () => stop.abort())
    return core
  }
  const first = cero(dir, spec, { ...opts, invite, signal: stop.signal }).catch((err) => err)
  await cero.accept(a.me, await asked(a.me))
  const stopped = await first
  if (stopped.id) await stopped.close()

  const b = await cero(dir, spec, { ...opts, recoveryTimeout: 20000 }).catch((err) => err)
  if (b.id) t.teardown(() => b.close().catch(() => {}), { order: 4 })
  t.is(b.id, a.me.id, 'linked on the next launch')
})

// a link launch accepted on `a` that stops on one write of its setup's end, then closes
async function killedLinking(t, a, method, when) {
  const invite = await cero.invite(a.me)
  const dir = await t.tmp()
  let launch = null
  let stopping
  const stopped = new Promise((resolve) => (stopping = resolve))
  const dies = {
    setup(me) {
      if (launch) return
      launch = { me, writer: me.store.keyPair.publicKey }
      stall(me.local.store, method, when).then(stopping)
    }
  }
  cero(dir, spec, { bootstrap: a.testnet.bootstrap, invite, extensions: [dies] }).catch(() => {})
  await cero.accept(a.me, await asked(a.me))
  await stopped
  await launch.me.close()
  return { dir, writer: launch.writer }
}

test('link: a launch killed at the end of its setup opens as the linked device, on the same writer', async (t) => {
  const a = await ceroOpen(t)
  const opts = { bootstrap: a.testnet.bootstrap }
  const steps = [
    ['set', (name, row) => name === 'keypair' && row.setup === null],
    ['del', (name) => name === 'joins']
  ]
  for (const [method, when] of steps) {
    const { dir, writer } = await killedLinking(t, a, method, when)
    const b = await cero(dir, spec, opts)
    t.teardown(() => b.close().catch(() => {}), { order: 1 })
    t.is(b.id, a.me.id, `stopped on ${method}: the linked identity`)
    t.alike(b.store.keyPair.publicKey, writer, 'on the writer it was linked with')
    t.alike((await b.local.store.get('joins')).data, [], 'with no join left behind')
    await b.close()
  }
  await devices(a.me, 3)
  t.pass('one seat per linked device')
})

test('link: a removed device loses its seats in every handle, and the root rotates its key', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const b = await linkTo(t, a)
  const mine = await open(b.me.team, { id: room.id })
  await waitUntil(() => (mine.store.writable ? true : null))
  const key = b.me.identity.device.publicKey
  const seated = async () =>
    (await get(room.devices)).data.some((r) => r.key && b4a.equals(r.key, key))
  await waitUntil(async () => ((await seated()) ? true : null))

  await del(a.me.devices, b.me.device.id)
  await waitUntil(async () => ((await seated()) ? null : true))
  t.pass('its seat in the room went with it')
  await waitUntil(async () => ((await get(a.me.status)).data.epoch >= 1 ? true : null))
  t.pass('and the root rotated its key')
  await waitUntil(() => (b.me.store.writable ? null : true))
  t.pass('the device writes nowhere')
})

// a new device accepted on `a` that stops waiting before its keys: promised a seat it never takes
async function accepted(t, a) {
  const invite = await cero.invite(a.me, { ttl: '6s' })
  const dir = await t.tmp()
  const opts = { bootstrap: a.testnet.bootstrap, invite, recoveryTimeout: 1500 }
  await t.exception(cero(dir, spec, opts), /TIMEOUT/)
  await cero.accept(a.me, await asked(a.me))
  const { id } = await waitUntil(
    async () => (await get(a.me.requests)).data.find((r) => r.admitted) || null
  )
  return { dir, id }
}

// left unread past the invite, when its promise is withdrawn
async function unread(t, a) {
  const { dir } = await accepted(t, a)
  await waitUntil(async () => ((await get(a.me.requests)).data.length === 0 ? true : null))
  return dir
}

test("link: an accepted device that never reads its keys has no seat, its promise is denied at the invite's expiry, and the root stays writable", async (t) => {
  const a = await ceroOpen(t)
  await set(a.me.profile, { name: 'ana' })
  const denies = []
  const call = a.me.store.call.bind(a.me.store)
  a.me.store.call = (verb, row) => {
    if (verb === 'deny') denies.push(row)
    return call(verb, row)
  }
  const { id } = await accepted(t, a)
  t.is((await get(a.me.devices)).data.length, 1, 'accepted, the unread device has no seat')
  await waitUntil(async () => ((await get(a.me.requests)).data.length === 0 ? true : null))
  t.alike(denies, [{ id, reason: 'expired' }], "its promise is denied at the invite's expiry")
  t.is((await get(a.me.devices)).data.length, 1, 'and it never had one')
  t.ok(a.me.store.writable, 'the accepting device still writes to its root')
  await set(a.me.profile, { name: 'still ana' })
  t.is((await get(a.me.profile)).data?.name, 'still ana')
})

test('link: that device links later with a new invite', async (t) => {
  const a = await ceroOpen(t)
  const dir = await unread(t, a)
  const invite = await cero.invite(a.me)
  const linking = cero(dir, spec, { bootstrap: a.testnet.bootstrap, invite })
  linking.catch(() => {})
  await cero.accept(a.me, await asked(a.me))
  const b = await linking
  t.teardown(() => b.close().catch(() => {}), { order: 1 })
  t.is(b.id, a.me.id, 'let in as a device of the same identity')
  await waitUntil(() => (b.store.writable ? true : null))
  t.pass('and writes to the root')
})

test('link: a device whose root lags prunes no sibling', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const b1 = await ceroOpen(t, { testnet: a.testnet })
  const id = b1.me.identity.id
  await open(b1.me.team, await cero.invite(room))
  const phrase = await cero.phrase(b1.me)
  const listed = (me) =>
    waitUntil(async () => ((await get(me.team)).data.length === 1 ? true : null))
  const seats = async (handle) =>
    (await get(handle.devices)).data.filter((d) => d.memberId === id && d.key).map((d) => d.id)

  // b2 last runs before b3 is added: its root never hears of b3
  const b2 = await ceroOpen(t, { testnet: a.testnet, phrase })
  await listed(b2.me)
  await b2.me.close()
  const b3 = await ceroOpen(t, { testnet: a.testnet, phrase })
  await listed(b3.me)
  await open(b3.me.team, { id: room.id })
  await waitUntil(async () => ((await seats(room)).length === 2 ? true : null))
  const before = await seats(room)
  await b1.me.close()
  await b3.me.close()

  // b2 comes back while its siblings are away, and opens the room
  const back = await cero(b2.dir, spec, { bootstrap: a.testnet.bootstrap })
  t.teardown(() => back.close().catch(() => {}), { order: 1 })
  const mine = await open(back.team, { id: room.id })
  const kept = async () => {
    const now = await seats(mine)
    return before.every((d) => now.includes(d))
  }
  await waitUntil(kept)
  await back._pruneAll()
  t.ok(await kept(), 'b1 and b3 keep their seats')
})

test('cero(): a second device auto-claims', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet })
  const phrase = a.me.identity.toPhrase()
  await put(a.me.messages, { text: 'from-a' })

  const b = await ceroOpen(t, { testnet, phrase })

  t.ok(b.me.store.writable, 'b is writable after recovery resolves')

  await put(b.me.messages, { text: 'from-b' })
  const list = await waitUntil(async () => {
    const { data } = await get(b.me.messages)
    return data.length === 2 ? data : null
  })
  t.is(list.length, 2)
})

// ─── replication: same identity, two devices (private scope) ──────────────

test('cero(): private scope syncs across the same identity on two devices', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet })
  const phrase = a.me.identity.toPhrase()

  // Publish a member entry so device B can claim against it.
  await put(a.me.messages, { text: 'from-a' })

  // Device B opens with the same phrase: its own device core, admitted by the
  // identity's signature over the history it pulled from A.
  const b = await ceroOpen(t, { testnet, phrase })

  t.ok(b.me.store.writable, 'b writable after recovery')

  await put(b.me.messages, { text: 'from-b' })
  await waitUntil(async () => {
    const { data: list } = await get(a.me.messages)
    return list.find((r) => r.text === 'from-b') ? true : null
  })
  const { data: onA } = await get(a.me.messages)
  t.alike(onA.map((r) => r.text).sort(), ['from-a', 'from-b'])
})

// ─── replication: two identities joining a public scope ───────────────────

test('cero(): two identities sync on a public scope via invite', async (t) => {
  const testnet = await makeTestnet(t)

  const host = await ceroOpen(t, { testnet })
  const team = await open(host.me.team)
  await put(team.messages, { text: 'from-host' })

  const inviteStr = await cero.invite(team, { role: 'member', ttl: 60_000 })

  const joiner = await ceroOpen(t, { testnet })
  const teamB = await open(joiner.me.team, inviteStr)

  await waitForConnection(host.me.network)
  await waitForConnection(joiner.me.network)
  await waitUntil(() => teamB.store.writable)

  await put(teamB.messages, { text: 'from-joiner' })
  await waitUntil(async () => {
    const { data: list } = await get(team.messages)
    return list.find((r) => r.text === 'from-joiner') ? true : null
  })
  const { data: onHost } = await get(team.messages)
  t.alike(onHost.map((r) => r.text).sort(), ['from-host', 'from-joiner'])
})

// ─── suspend / resume ─────────────────────────────────────────────────────

test('cero(): a phrase alone recovers a second device — no flag, no new history', async (t) => {
  const testnet = await makeTestnet(t)
  const { me: a } = await ceroOpen(t, { testnet, name: 'laptop-A' })
  await put(a.messages, { text: 'from-a' })
  const phrase = await cero.phrase(a)

  // a new device with nothing but the phrase: its own writer core, the
  // history pulled from A, admitted by the identity's signature
  const b = await cero(await t.tmp(), spec, {
    bootstrap: testnet.bootstrap,
    phrase,
    name: 'laptop-B'
  })
  t.teardown(() => b.close().catch(() => {}), { order: 5 })

  t.is(b.id, a.id, 'same identity')
  t.is(b4a.toHex(b.store.key), b4a.toHex(a.store.key), 'same root database')
  t.not(b4a.toHex(b.store.writerKey), b4a.toHex(a.store.writerKey), 'its own writer core')
  t.ok(b.store.writable, 'admitted as a writer')

  const row = await waitUntil(async () => {
    const { data } = await get(b.messages)
    return data.find((m) => m.text === 'from-a') ?? null
  })
  t.ok(row, 'sees the history from A')

  const { data: devices } = await get(b.devices)
  t.is(devices.length, 2, 'two devices, one per machine')
  const { data: members } = await get(b.members)
  t.is(members.length, 1, 'one member')
})

test('cero(): suspend()/resume() flips swarm + corestore state', async (t) => {
  const { me } = await ceroOpen(t)
  t.absent((await get(me.status)).data.suspended, 'starts not suspended')
  t.absent(me.network.swarm.suspended)
  t.absent(me.store.opened === false && me.store.suspended)

  await cero.suspend(me)
  t.ok((await get(me.status)).data.suspended, 'composer reports suspended')
  t.ok(me.network.swarm.suspended, 'swarm suspended')

  await cero.resume(me)
  t.absent((await get(me.status)).data.suspended)
  t.absent(me.network.swarm.suspended)
})

test('status: a room reports its role, writability, epoch and suspension, live', async (t) => {
  // the radio's state is the platform's: a mock makes it the same everywhere
  const { me } = await ceroOpen(t, { bluetooth: { backend: makeMockBluetooth() } })
  const room = await open(me.team, { name: 'clinic' })
  const status = async () => (await get(room.status)).data
  const expected = {
    role: 'owner',
    writable: true,
    epoch: 0,
    suspended: false,
    behind: 0,
    owed: false,
    version: spec.meta.target,
    nearby: 'off',
    topic: b4a.toHex(room.store.discoveryKey)
  }
  t.alike(await status(), expected)

  const seen = []
  cero.watch(room.status).on('data', ({ data }) => seen.push(data.suspended))
  const now = (suspended) => waitUntil(() => seen.at(-1) === suspended || null)
  await now(false)
  await cero.suspend(me)
  t.ok((await status()).suspended, 'a suspended app suspends its rooms')
  await now(true)
  await cero.resume(me)
  await now(false)
  t.pass('the watch follows each change')

  await cero.deactivate(room)
  t.absent((await status()).suspended, 'a room off the swarm is not a suspended app')
  await t.exception(cero.suspend(room), /the app's, on me/)
})

test('suspend: a failing step is reported to onerror, the rest still suspends', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  me.network.suspend = async () => {
    throw new Error('radio')
  }
  await cero.suspend(me)
  t.is(errors[0]?.message, 'radio', 'the failure is reported')
  t.ok((await get(me.status)).data.suspended, 'suspend still completes')
  await cero.resume(me)
  t.absent((await get(me.status)).data.suspended)
})

test('onerror: a core fault reaches onerror', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  const core = me.store.store.get({ name: 'probe' })
  await core.ready()
  for (const s of [...core.core.monitors]) s.emit('verification-error', new Error('bad proof'))
  t.is(errors[0]?.message, 'bad proof')
  await core.close()
})

test('close: a failing step still tears down the rest, then the error surfaces', async (t) => {
  const { me, dir, testnet } = await ceroOpen(t)
  const child = await open(me.team, { name: 'stuck' })
  child._close = async () => {
    throw new Error('stuck')
  }
  await t.exception(me.close(), /stuck/)
  t.ok(me.network.closed, 'network closed past the failing child')
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.pass('storage lock released, same dir reopens')
  await again.close()
})

test('onerror: without a handler background errors are printed', async (t) => {
  const { me } = await ceroOpen(t)
  const printed = []
  const error = console.error
  console.error = (err) => printed.push(err)
  t.teardown(() => (console.error = error))
  me.network.suspend = async () => {
    throw new Error('radio')
  }
  await cero.suspend(me)
  t.is(printed[0]?.message, 'radio')
  await cero.resume(me)
})

test('cero(): a suspend() racing an in-flight resume() serializes — last call wins', async (t) => {
  const { me } = await ceroOpen(t)
  const calls = []
  const net = me.network
  const origSuspend = net.suspend.bind(net)
  const origResume = net.resume.bind(net)
  net.suspend = async () => {
    await origSuspend()
    calls.push('suspend')
  }
  net.resume = async () => {
    await new Promise((r) => setTimeout(r, 100))
    await origResume()
    calls.push('resume')
  }

  await cero.suspend(me)
  const resuming = cero.resume(me)
  const suspending = cero.suspend(me) // fired while resume is still in flight
  await Promise.all([resuming, suspending])

  t.ok((await get(me.status)).data.suspended, 'handle reports suspended')
  t.is(calls[calls.length - 1], 'suspend', 'network ops ran in call order')
  t.ok(me.network.swarm.suspended, 'swarm actually ended suspended')
})

test('cero(): a blob core resolving after close does not re-register its key', async (t) => {
  const { Blobs } = await import('@cero-base/core/blobs')
  const { me } = await ceroOpen(t, { keepOpen: 0 })
  const team = await open(me.team)

  let release
  const gate = new Promise((r) => (release = r))
  const origOpen = Blobs.prototype._open
  Blobs.prototype._open = async function (...args) {
    await gate
    return origOpen.apply(this, args)
  }
  t.teardown(() => {
    Blobs.prototype._open = origOpen
  })

  const blobs = team.blobs // lazily created — its open now parks on the gate
  const closing = team.close() // prunes _coreKeys, then waits on the blob store
  release()
  await closing
  await new Promise((r) => setTimeout(r, 0)) // let the ready() continuation run

  t.ok(blobs.key, 'the blob core did open')
  t.absent(
    me._coreKeys.has(b4a.toHex(blobs.key)),
    "a late blob open must not resurrect the closed handle's key on the root"
  )
})

test('cero(): suspend()/resume() is idempotent', async (t) => {
  const { me } = await ceroOpen(t)
  await cero.suspend(me)
  await cero.suspend(me) // no-op
  t.ok((await get(me.status)).data.suspended)
  await cero.resume(me)
  await cero.resume(me) // no-op
  t.absent((await get(me.status)).data.suspended)
})

test('cero(): writes work after suspend()+resume() cycle', async (t) => {
  const { me } = await ceroOpen(t)
  const team = await open(me.team)
  await put(team.messages, { text: 'before' })

  await cero.suspend(me)
  await cero.resume(me)

  await put(team.messages, { text: 'after' })
  const { data: rows } = await get(team.messages)
  t.alike(rows.map((r) => r.text).sort(), ['after', 'before'])
})

test('cero(): close() works after suspend without resume', async (t) => {
  const dir = await t.tmp()
  const testnet = await makeTestnet(t)
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  await cero.suspend(me)
  await me.close()
  t.pass('close after suspend did not throw')
})

test('tx: the writes made through the batch land together, or none do', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  cero.before(room.notes, ({ row }) => row.text !== 'no')
  const batch = (note) =>
    cero.tx(room, async (tx) => {
      await put(tx.messages, { text: 'hi' })
      await put(tx.notes, { text: note })
    })

  await t.exception(batch('no'), /REFUSED/)
  t.is((await get(room.messages)).data.length, 0, 'the refused note took the message with it')
  await batch('yes')
  t.is((await get(room.messages)).data.length, 1)
  t.is((await get(room.notes)).data.length, 1)
  await t.exception(
    cero.tx(room, async () => {}),
    /fn takes the batch/
  )
})

test(
  'tx: a write outside the batch during the callback goes through on its own',
  { timeout: 20000 },
  async (t) => {
    const { me } = await ceroOpen(t)
    cero.before(me.clips, ({ row }) => row.data !== 'no')
    await t.exception(
      cero.tx(me, async (tx) => {
        await put(tx.clips, { data: 'no' })
        await set(me.profile, { name: 'outside' })
      }),
      /REFUSED/
    )
    t.is(
      (await get(me.profile)).data?.name,
      'outside',
      'landed on its own, not with the refused batch'
    )
    t.is((await get(me.clips)).data.length, 0, 'the batch itself was refused')
  }
)

test('open: an open by id that fails closes the room it opened', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await ceroOpen(t, { testnet })
  const room = await open(a.me.team, { name: 'clinic' })
  const topic = discoveryKey(room.store.key)
  const b = await ceroOpen(t, { testnet, phrase: a.me.identity.toPhrase() })
  await waitUntil(async () => (await get(b.me.team)).data.length === 1)
  await a.me.close()

  await t.exception(open(b.me.team, { id: room.id }), /TIMEOUT/)
  t.is(b.me.network.presence.mode(topic), null, 'the half-opened room left the swarm')
})

test('open: a room created while the root closes rejects with CLOSED', async (t) => {
  const { me } = await ceroOpen(t)
  const creating = open(me.team, { name: 'clinic' })
  const closing = cero.close(me)
  const err = await creating.catch((err) => err)
  t.is(err?.code, 'CLOSED', `rejected with ${err?.code}: ${err?.message}`)
  await closing
})

test('open: an open by id waiting on its seat when the root closes rejects with CLOSED', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await ceroOpen(t, { testnet })
  const room = await open(a.me.team, { name: 'clinic' })
  const topic = discoveryKey(room.store.key)
  const b = await ceroOpen(t, { testnet, phrase: a.me.identity.toPhrase() })
  await waitUntil(async () => (await get(b.me.team)).data.length === 1)
  await a.me.close()

  // a new device of the identity claims a seat, and no device is online to admit it
  const opening = open(b.me.team, { id: room.id }).catch((err) => err)
  await waitUntil(() => b.me.network.presence.mode(topic) !== null)
  await b.me.close()
  const err = await opening
  t.is(err?.code, 'CLOSED', `rejected with ${err?.code}: ${err?.message}`)
})

test('open: a room whose creation lands as the root closes rejects with CLOSED', async (t) => {
  const { me } = await ceroOpen(t)
  let closing = null
  cero.after(me.handles, () => {
    closing ??= cero.close(me)
  })
  const err = await open(me.team, { name: 'clinic' }).catch((err) => err)
  t.is(err?.code, 'CLOSED', `rejected with ${err?.code}: ${err?.message}`)
  await closing
})

test('leave: you are no longer a member of the room you left', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const joiner = await ceroOpen(t, { testnet })
  const joined = await open(joiner.me.team, await cero.invite(room))
  await waitUntil(async () => (await get(room.members, joiner.me.id)).data)

  await cero.leave(joined)
  await waitUntil(async () => !(await get(joiner.me.team, room.id)).data)
  t.is((await get(joiner.me.team)).data.length, 0, 'the room left the list')
  await waitUntil(async () => !(await get(room.members, joiner.me.id)).data)
  t.pass('the owner sees the member gone')
})

test('leave: the last owner cannot leave members behind', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const joiner = await ceroOpen(t, { testnet })
  await open(joiner.me.team, await cero.invite(room))
  await waitUntil(async () => (await get(room.members, joiner.me.id)).data)

  await t.exception(cero.leave(room), /INVALID/)
  t.is((await get(owner.me.team)).data.length, 1, 'the room stays in the list')
  t.ok((await get(room.members, owner.me.id)).data, 'and the owner stays in the room')
})

test('leave: a room can be left, the root cannot', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const joiner = await ceroOpen(t, { testnet })
  await open(joiner.me.team, await cero.invite(room))
  await waitUntil(async () => (await get(room.members, joiner.me.id)).data)
  await set(room.members, { id: joiner.me.id, role: 'owner' })

  await cero.leave(room)
  await waitUntil(async () => !(await get(owner.me.team, room.id)).data)
  t.is((await get(owner.me.team)).data.length, 0, 'the room left the list')
  await t.exception(cero.leave(owner.me), /the root cannot be left/)
})

test('extensions: setup runs before the root opens, and what it reads waits for the open', async (t) => {
  let opened = null
  let read = null
  const extensions = [
    {
      async setup(me) {
        opened = me.opened
        read = await get(me.profile)
      }
    }
  ]
  await ceroOpen(t, { extensions })
  t.is(opened, false, 'setup ran first')
  t.alike(read, { data: null }, 'the read waited for the open')
})

test('extensions: a write awaited in setup waits until the root can take it', async (t) => {
  const extensions = [
    {
      async setup(me) {
        await set(me.profile, { name: 'set up' })
      }
    }
  ]
  const { me } = await ceroOpen(t, { extensions })
  t.is((await get(me.profile)).data?.name, 'set up')
})

test('extensions: the bundled two run when nothing is named', async (t) => {
  const { me } = await ceroOpen(t)
  await set(me.profile, { name: 'jb' })
  const team = await open(me.team, { name: 'squad' })
  await waitUntil(async () => (await get(team.members, me.id)).data?.name === 'jb')
  t.pass('profileSync ran')
  await waitUntil(async () => (await get(me.handles, team.id)).data?.name === 'squad')
  t.pass('handleSync ran')
})

test('link: cero.link switches a set-up app to the identity behind an invite, as a device of it', async (t) => {
  const a = await ceroOpen(t)
  const errors = []
  const b = await ceroOpen(t, { testnet: a.testnet, onerror: (err) => errors.push(err) })
  t.not(b.me.id, a.me.id, 'two identities to start')
  const invite = await cero.invite(a.me)
  let code = null
  const linking = cero.link(b.me, invite, { onrequest: (id) => (code = id) })
  linking.catch(() => {})
  const request = await asked(a.me)
  t.is(request.id, code, 'both screens show the request id')
  await cero.accept(a.me, request)
  const linked = await linking
  t.teardown(() => linked.close().catch(() => {}), { order: 1 })
  t.is(linked.id, a.me.id, 'the same identity')
  t.not(linked.device.id, a.me.device.id, 'a device of its own')
  await t.exception(cero.phrase(linked), /no phrase on this device/, 'and no phrase')
  await devices(a.me, 2)
  t.alike(errors, [], 'nothing reported on the linked device')
})

test('link: a denied cero.link rejects DENIED', async (t) => {
  const a = await ceroOpen(t)
  const b = await ceroOpen(t, { testnet: a.testnet })
  const linking = cero.link(b.me, await cero.invite(a.me))
  await cero.deny(a.me, await asked(a.me), 'not mine')
  await t.exception(linking, /DENIED/)
})

test('link: cero.link waits for the accept as long as the invite lasts, whatever the recovery timeout', async (t) => {
  const a = await ceroOpen(t)
  const b = await ceroOpen(t, { testnet: a.testnet, recoveryTimeout: 1 })
  const linking = cero.link(b.me, await cero.invite(a.me))
  linking.catch(() => {})
  await cero.accept(a.me, await asked(a.me))
  const linked = await linking
  t.teardown(() => linked.close().catch(() => {}), { order: 1 })
  t.is(linked.id, a.me.id, 'linked, not timed out')
})

test('link: a denied launch opens as a new identity the next time, nothing left to resume', async (t) => {
  const a = await ceroOpen(t)
  const dir = await t.tmp()
  const refused = cero(dir, spec, {
    bootstrap: a.testnet.bootstrap,
    invite: await cero.invite(a.me)
  })
  refused.catch(() => {})
  await cero.deny(a.me, await asked(a.me), 'not mine')
  await t.exception(refused, /DENIED/)
  const fresh = await cero(dir, spec, { bootstrap: a.testnet.bootstrap })
  t.teardown(() => fresh.close().catch(() => {}), { order: 1 })
  t.ok(fresh.id, 'opens')
  t.not(fresh.id, a.me.id, 'as an identity of its own')
})

test('status: a new room starts at the version its build asks for', async (t) => {
  const testnet = await makeTestnet(t)
  const team = spec.handles.team
  const meta = { ...team.meta, version: team.meta.version + 1, target: team.meta.version + 1 }
  const newer = { ...spec, handles: { ...spec.handles, team: { ...team, meta } } }
  const me = await cero(await t.tmp(), newer, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const room = await open(me.team, { name: 'clinic' })
  const row = await room.store.view.get('@cero/counters', { name: '_version' })
  t.is(row?.value, meta.target, 'its genesis wrote it')
})

test('status: a context behind a newer app reads but does not write until the update', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  const { data: mine } = await put(room.messages, { text: 'mine' })
  // its owner moves it to a newer app's version
  await room.store.write([['upgrade', { version: room.store.version + 1 }]])
  await waitUntil(async () => (await get(room.status)).data.behind === room.store.version + 1)
  const err = await put(room.messages, { text: 'stale' }).catch((e) => e)
  t.is(err?.code, 'BEHIND', 'the write waits for the update')
  t.is((await get(room.messages, mine.id)).data?.text, 'mine', 'reads go on')
})

test('status: a device behind in its root is behind in every room, and the local store goes on', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  const seen = []
  cero.watch(room.status).on('data', ({ data }) => seen.push(data.behind))
  const behind = me.store.version + 1
  await me.store.write([['upgrade', { version: behind }]])
  await waitUntil(() => seen.at(-1) === behind || null)
  t.pass('the room reports it as the root goes behind')

  const err = await put(room.messages, { text: 'stale' }).catch((e) => e)
  t.is(err?.code, 'BEHIND', 'the room does not write')
  t.is((await put(me.messages, { text: 'stale' }).catch((e) => e))?.code, 'BEHIND', 'nor the root')
  t.ok(
    (await put(me.local.drafts, { text: 'draft' })).data.id,
    'the local store does: this device alone'
  )
  t.is((await get(room.status)).data.version, spec.meta.target, "the room's version is its own")
})

test('status: a room whose root is behind prunes no device from it', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  const { data: rows } = await get(room.devices)
  await me.store.write([['upgrade', { version: me.store.version + 1 }]])
  await waitUntil(() => room.store.behind !== null || null)
  // the root, past this build, reads this device as removed
  me.store.removals = async () => [me.identity.device.publicKey]
  await t.exception(me._prune(room), /BEHIND/, 'the room does not write')
  t.alike((await get(room.devices)).data, rows, 'a removal it cannot follow is not taken')
})

test('status: a device behind in its root leaves no room: nothing is half done', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  await me.store.write([['upgrade', { version: me.store.version + 1 }]])
  await waitUntil(() => room.store.behind !== null || null)
  const err = await cero.leave(room).catch((e) => e)
  t.is(err?.code, 'BEHIND', err?.message)
  t.ok((await get(room.members, me.id)).data, 'still a member')
  t.is((await get(me.team)).data.length, 1, 'still in the list')
  t.absent(room.closed, 'and open')
})

test("status: version is the room's, and supports answers from it and the spec, before and after a raise", async (t) => {
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), next, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const version = async () => (await get(me.status)).data.version
  t.is(await version(), next.meta.target, 'a new root is at the target its build asks for')
  t.ok(await cero.supports(me.messages), 'a collection it had')
  t.ok(await cero.supports(me.messages, 'text'), 'and its field')
  t.absent(await cero.supports(me.messages, 'tag'), 'a field held back')
  t.absent(await cero.supports(me.visits), 'a collection held back')

  // as its owner's device on the release that lets them go does
  await me.store.write([['upgrade', { version: next.meta.version }]])
  await waitUntil(async () => (await version()) === next.meta.version || null)
  t.ok(await cero.supports(me.messages, 'tag'), 'the field is on')
  t.ok(await cero.supports(me.visits), 'and the collection')
  t.is((await get(me.status)).data.behind, 0, 'its build has the version')
  t.ok((await put(me.messages, { text: 'a', tag: 'b' })).data.id, 'and writes it')
})

test('supports: a write of what the version holds back is refused with UNSUPPORTED', async (t) => {
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), next, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const field = await put(me.messages, { text: 'a', tag: 'b' }).catch((e) => e)
  t.is(field?.code, 'UNSUPPORTED', field?.message)
  const collection = await put(me.visits, { date: 'today' }).catch((e) => e)
  t.is(collection?.code, 'UNSUPPORTED', collection?.message)
  t.is((await get(me.messages)).data.length, 0, 'nothing was written')
  t.ok((await put(me.messages, { text: 'a' })).data.id, 'without it the write goes in')
})

test('supports: takes the ref of an open handle and a field it has', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  t.ok(await cero.supports(room.messages, 'text'), 'a room answers for its own')
  await t.exception(cero.supports(me.team.messages), /INVALID/, 'every room of a type has its own')
  await t.exception(cero.supports(me.local.drafts), /INVALID/, 'the local store has none')
  await t.exception(cero.supports(me.messages, 'nope'), /UNKNOWN/, 'a field it lacks')
})

test('status: behind, invite, rotate and tx wait for the update, and a member can still leave', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const joiner = await ceroOpen(t, { testnet })
  const joined = await open(joiner.me.team, await cero.invite(room))
  await waitUntil(async () => (await get(room.members, joiner.me.id)).data)

  await room.store.write([['upgrade', { version: room.store.version + 1 }]])
  await waitUntil(async () => (await get(room.status)).data.behind === room.store.version + 1)
  await waitUntil(async () => (await get(joined.status)).data.behind === room.store.version + 1)

  const attempts = {
    invite: () => cero.invite(room),
    rotate: () => rotate(room),
    tx: () => cero.tx(room, async (ctx) => put(ctx.messages, { text: 'a' }))
  }
  for (const [name, attempt] of Object.entries(attempts)) {
    const err = await attempt().catch((e) => e)
    t.is(err?.code, 'BEHIND', `${name} throws BEHIND`)
  }

  await cero.leave(joined)
  await waitUntil(async () => !(await get(joiner.me.team, room.id)).data)
  t.is((await get(joiner.me.team)).data.length, 0, 'the member left while behind')
  await waitUntil(async () => !(await get(room.members, joiner.me.id)).data)
  t.pass('and the owner, behind too, applied it')
})
