import test from 'brittle'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'
import { Identity } from '@cero-base/core/identity'
import { Invite } from '@cero-base/core/invite'
import { Pass } from '@cero-base/core/pairing'
import { Database } from '@cero-base/core/database'
import { CeroError } from '@cero-base/core/errors'

import { get, open, del } from '../../src/lib/operators.js'
import { cero } from '../../src/index.js'
import { spec } from '../fixtures/spec/index.js'
import {
  makeStore,
  makeTestnet,
  makeNet,
  makeMirror,
  waitForConnection,
  waitUntil,
  openHandle,
  ceroOpen
} from '../helpers/index.js'

test.configure({ timeout: 90000 })

async function joinAsRoot(t, testnet, inviteStr, opts = {}) {
  const peer = await openHandle(t, { testnet, ...opts })
  await peer.me.store.bootstrap({ name: 'peer-root' })
  const child = await open(peer.me.team, inviteStr)
  t.teardown(() => child.close().catch(() => {}))
  return { ...peer, room: child }
}

const memberCount = (room, n) =>
  waitUntil(async () => {
    const { data } = await get(room.members)
    return data.length === n ? true : null
  })

test('invites: a member cannot mint an invite above its own rank', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })

  const room = await open(a.me.team, { name: 'clinic' })
  const b = await joinAsRoot(t, testnet, await cero.invite(room, { role: 'member' }))
  await memberCount(room, 2)

  // b joined as a member — it may pass on what it holds, and nothing above it
  await t.exception(cero.invite(b.room, { role: 'owner' }), /exceeds your own role/i)
  await t.exception(cero.invite(b.room, { role: 'admin' }), /exceeds your own role/i)
  t.ok(await cero.invite(b.room, { role: 'member' }), 'its own rank is fine')
})

test('invites: a member cannot revoke — an owner can, and every replica drops it', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  const b = await joinAsRoot(t, testnet, await cero.invite(room, { role: 'member' }))
  await memberCount(room, 2)

  const inv = await cero.invite(room, { role: 'member' })
  const rows = async (h) => (await get(h.invites)).data.length
  t.is(await rows(room), 1, 'one live invite')

  // refused before anything reaches the log
  await t.exception(cero.revoke(b.room, inv), /remove permission/i, 'a member is refused')
  t.is(await rows(room), 1, 'the invite row is untouched')

  t.ok(await cero.revoke(room, inv), 'the owner revokes it')
  await waitUntil(async () => ((await rows(b.room)) === 0 ? true : null))
  t.is(await rows(b.room), 0, "and the member's replica drops it")
})

test('invites: survive a close/reopen — answered by a fresh handle', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })

  const room = await open(a.me.team, { name: 'clinic' })
  const inviteStr = await cero.invite(room)
  const roomId = room.id
  await room.close()

  // fresh handle, fresh Pairing: the invite comes back from its row
  const reopened = await open(a.me.team, { id: roomId })
  t.teardown(() => reopened.close().catch(() => {}))

  const b = await joinAsRoot(t, testnet, inviteStr)
  t.ok(b.room, 'joiner admitted with an invite minted before the reopen')
  await memberCount(reopened, 2)

  // single-use: admission consumed the row everywhere
  await waitUntil(async () => {
    const { data } = await get(reopened.invites)
    return data.length === 0 ? true : null
  })
  t.pass('consumed single-use invite dropped from the collection')
})

test('invites: any member replica answers an invite after the minter goes offline', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))

  const b = await joinAsRoot(t, testnet, await cero.invite(room))
  await waitForConnection(a.net)

  const invite2 = await cero.invite(room)
  // the invite must land in B's replica before A leaves
  await waitUntil(() => (b.room._pair.serving ? true : null))
  await room.close()

  const c = await joinAsRoot(t, testnet, invite2)
  t.ok(c.room, 'joiner admitted while the minting device is offline')
  await memberCount(c.room, 3)
  t.pass('member B answered an invite it never minted')
})

test('invites: revoke propagates — other members stop answering', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))

  const b = await joinAsRoot(t, testnet, await cero.invite(room))
  await waitForConnection(a.net)

  const invite3 = await cero.invite(room)
  await waitUntil(() => (b.room._pair.serving ? true : null))

  t.ok(cero.revoke(room, invite3), 'revoke found the live invite')
  await waitUntil(async () => {
    const { data } = await get(b.room.invites)
    return data.length === 0 ? true : null
  })
  await waitUntil(() => (b.room._pair.serving ? null : true))
  t.pass('the other member no longer answers it')
})

test('invites: reuse admits multiple joiners and its row survives', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))

  const multi = await cero.invite(room, { reuse: true })
  await joinAsRoot(t, testnet, multi)
  await joinAsRoot(t, testnet, multi)
  await memberCount(room, 3)

  const { data: rows } = await get(room.invites)
  t.is(rows.length, 1, 'reusable invite row still present after two admissions')
})

test('invites: a removed member comes back only through an invite minted after its removal', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'records' })
  t.teardown(() => room.close().catch(() => {}))
  const before = await cero.invite(room, { reuse: true })
  const b = await joinAsRoot(t, testnet, before)
  await memberCount(room, 2)

  // the patient revokes the clinician, who still holds the reusable invite
  await del(room.members, b.identity.id)
  await memberCount(room, 1)
  await waitUntil(async () => ((await get(b.room.members, b.identity.id)).data ? null : true))
  const err = await open(b.me.team, before).catch((e) => e)
  t.is(err.code, 'DENIED', 'the old invite admits nobody')
  t.is(err.reason, 'removed', 'and says why')
  t.is((await get(b.me.team, room.id)).data.state, 'removed', 'and its row reads removed')
  t.absent((await get(room.members, b.identity.id)).data)

  const back = await open(b.me.team, await cero.invite(room))
  t.teardown(() => back.close().catch(() => {}))
  await memberCount(room, 2)
  t.pass('an invite minted after the removal brings them back')
})

test('invites: after a removal and a rotation, an invite minted before is turned away as removed, a new one admits, and the removed member answers none', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))

  const b = await joinAsRoot(t, testnet, await cero.invite(room))
  await waitForConnection(a.net)
  const before = await cero.invite(room)

  await del(room.members, b.identity.id)
  await waitUntil(async () => (await get(room.status)).data.epoch === 1 || null)
  const after = await cero.invite(room)

  // the new invite's row is sealed under an epoch the removed member never learns
  t.is(b.room.store.keyring.entropy(room.store.keyring.current), null)
  await waitUntil(() => (b.room._pair.serving ? null : true))
  t.pass('the removed member stops answering joins')

  // the removal spent the invite she could have seen
  const late = await openHandle(t, { testnet })
  await late.me.store.bootstrap({ name: 'peer-root' })
  const err = await open(late.me.team, before).catch((e) => e)
  t.is(err.code, 'DENIED', 'the invite minted before the removal admits nobody')
  t.is(err.reason, 'removed', 'and says why')

  await joinAsRoot(t, testnet, after)
  await memberCount(room, 2)
})

// two identities in `general`, the first of them alone in `plans`
async function sharing(t) {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })
  const general = await open(a.me.team, { name: 'general' })
  t.teardown(() => general.close().catch(() => {}))
  const b = await joinAsRoot(t, testnet, await cero.invite(general))
  await waitUntil(async () => (await devicesOf(general, b.identity.id)).length > 0 || null)
  const plans = await open(a.me.team, { name: 'plans' })
  t.teardown(() => plans.close().catch(() => {}))
  return { testnet, a, b, general, plans }
}

const devicesOf = async (room, id) =>
  (await get(room.devices)).data.filter((d) => d.memberId === id && d.key)
const passesOf = (room) => room.store.view.find(`@${room.store.ns}/seats`, {}).toArray()
const rowOf = async (me, id) => (await get(me.handles, id)).data

test('seat: a member of a room both are in is let into another, with nothing called on her side', async (t) => {
  const { a, b, general, plans } = await sharing(t)

  t.is(await cero.seat(plans, b.identity.id, { from: general }), undefined)
  const [invite] = (await get(plans.invites)).data
  t.is(invite.to, b.identity.id, 'an invite made to her')
  t.is(plans._pair.serving, false, 'which owes no answer')
  t.is((await passesOf(general)).length, 1, 'and its pass waits in the room both are in')

  await waitUntil(async () => (await rowOf(b.me, plans.id))?.state === 'in' || null)
  const room = await open(b.me.team, { id: plans.id })
  t.teardown(() => room.close().catch(() => {}))
  t.is((await get(room.status)).data.role, 'member', 'she is in, at the role it named')
  await cero.put(room.notes, { text: 'hi' })
  await waitUntil(async () => (await get(plans.notes)).data.length === 1 || null)
  t.pass('and writes there')
  await memberCount(plans, 2)
  await waitUntil(async () => (await passesOf(general)).length === 0 || null)
  await waitUntil(async () => (await passesOf(b.room)).length === 0 || null)
  t.pass('her device takes the pass out once she is in')
  t.is((await get(a.me.handles, plans.id)).data?.state ?? 'in', 'in')
})

test('seat: a pass the room both are in cannot keep, or that room below the version that brings passes, is refused before any invite is minted', async (t) => {
  const { b, general, plans } = await sharing(t)
  const { keyring } = plans.store
  const { all } = keyring
  const entropy = Identity.randomBytes(32)
  const many = Array.from({ length: 2000 }, (_, i) => ({ epoch: i + 1, stamp: i + 2, entropy }))
  keyring.all = () => [...all.call(keyring), ...many]
  const big = await cero.seat(plans, b.identity.id, { from: general }).catch((e) => e)
  keyring.all = all
  t.is(big?.code, 'INVALID', 'too many keys for her devices')

  const { meta } = general.store
  const routes = { ...meta.since.routes, [`@${general.store.ns}/add-pass`]: meta.version + 1 }
  general.store.meta = { ...meta, since: { ...meta.since, routes } }
  const low = await cero.seat(plans, b.identity.id, { from: general }).catch((e) => e)
  general.store.meta = meta
  t.is(low?.code, 'UNSUPPORTED', 'a room with no passes yet')

  t.is((await get(plans.invites)).data.length, 0, 'no invite was minted')
  t.is((await passesOf(general)).length, 0, 'nor a pass written')
  await cero.seat(plans, b.identity.id, { from: general })
  t.is((await get(plans.invites)).data.length, 1, 'one is, once both hold')
})

const code = async (run) => (await run().catch((e) => e))?.code
const stateOf = async (me, id) => (await rowOf(me, id))?.state
const reaches = (me, id, state) => waitUntil(async () => (await stateOf(me, id)) === state || null)

test('seat: a reader, a rank above your own or a room you cannot write in is DENIED, what is no seat INVALID or UNKNOWN, and nothing is written', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })
  const general = await open(a.me.team, { name: 'general' })
  const plans = await open(a.me.team, { name: 'plans' })
  t.teardown(() => Promise.all([general, plans].map((room) => room.close().catch(() => {}))))
  const b = await joinAsRoot(t, testnet, await cero.invite(general))
  const c = await joinAsRoot(t, testnet, await cero.invite(general))
  const d = await joinAsRoot(t, testnet, await cero.invite(general, { role: 'reader' }))
  const reader = await open(b.me.team, await cero.invite(plans, { role: 'reader' }))
  const member = await open(c.me.team, await cero.invite(plans))
  const dee = await open(d.me.team, { name: 'dee' })
  t.teardown(() => Promise.all([reader, member, dee].map((room) => room.close().catch(() => {}))))
  for (const room of [general, b.room, c.room]) {
    await waitUntil(async () => (await devicesOf(room, d.identity.id)).length > 0 || null)
  }
  await memberCount(plans, 3)

  const her = d.identity.id
  t.is(
    await code(() => cero.seat(reader, her, { from: b.room })),
    'DENIED',
    'a reader seats nobody'
  )
  const admin = { from: c.room, role: 'admin' }
  t.is(await code(() => cero.seat(member, her, admin)), 'DENIED', 'nor a member above her rank')
  const from = { from: d.room }
  t.is(await code(() => cero.seat(dee, b.identity.id, from)), 'DENIED', 'nor a reader in from')
  t.is(
    await code(() => cero.seat(a.me, her, { from: general })),
    'INVALID',
    'the root seats nobody'
  )
  t.is(await code(() => cero.seat(plans, her)), 'INVALID', 'nor with no room to find her in')
  const there = c.identity.id
  t.is(
    await code(() => cero.seat(plans, there, { from: general })),
    'INVALID',
    'nor one in already'
  )
  const stranger = (await Identity.create()).id
  t.is(await code(() => cero.seat(plans, stranger, { from: general })), 'UNKNOWN', 'nor a stranger')
  t.is(
    await code(() => cero.seat(plans, her, { from: 'nope' })),
    'UNKNOWN',
    'nor from no room here'
  )
  const { get: read } = general.store
  general.store.get = (name, q) =>
    name === 'devices' ? { data: [] } : read.call(general.store, name, q)
  t.is(
    await code(() => cero.seat(plans, her, { from: general })),
    'UNKNOWN',
    'nor with no device known'
  )
  general.store.get = read
  for (const room of [plans, reader, member, dee]) {
    t.is((await get(room.invites)).data.length, 0, 'no invite minted')
  }
  t.is((await passesOf(general)).length, 0, 'and no pass written')
})

test('seat: a pass she cannot use writes nothing on her root and nothing goes to onerror', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })
  const general = await open(a.me.team, { name: 'general' })
  const plans = await open(a.me.team, { name: 'plans' })
  t.teardown(() => Promise.all([general, plans].map((room) => room.close().catch(() => {}))))
  const errors = []
  const onerror = (err) => errors.push(err)
  const b = await joinAsRoot(t, testnet, await cero.invite(general), { opts: { onerror } })
  await waitUntil(async () => (await devicesOf(general, b.identity.id)).length > 0 || null)

  const to = b.identity.id
  const add = (pass) =>
    general.store.call('add-pass', { id: b4a.toHex(Identity.randomBytes(16)), to, pass })
  const link = { key: Identity.randomBytes(32), length: 1 }
  const address = plans.store.address
  const inviteTo = (key) => Invite.create({ key, address, own: true, link }).toString()
  const { key, encryptionKey } = plans.store
  const team = b4a.from('team')
  const hers = [{ key: b.identity.device.publicKey }]
  const someone = [{ key: (await Identity.create()).device.publicKey }]
  const nowhere = Identity.randomBytes(32)
  const unread = { key: nowhere, encryptionKey: Identity.randomBytes(32), data: team }
  await add(Identity.randomBytes(64))
  await add(Pass.seal(someone, { invite: inviteTo(key), key, encryptionKey, data: team }))
  const other = Identity.randomBytes(32)
  const foreign = { key: other, encryptionKey, data: b4a.from('nope') }
  await add(Pass.seal(hers, { invite: inviteTo(other), ...foreign }))
  await add(Pass.seal(hers, { invite: inviteTo(nowhere), ...unread }))
  await add(Pass.seal(hers, { invite: inviteTo(key), key, encryptionKey, data: team }))

  await waitUntil(() => b.me._joining.size === 2 || null)
  t.pass('a pass in no form, sealed to another device or of a type her app lacks is left alone')
  const quiet = async () => {
    t.absent(await rowOf(b.me, plans.id), 'nothing on her root for an invite in no log')
    t.absent(await rowOf(b.me, hid.encode(nowhere)), 'nor for keys that open nothing')
  }
  await quiet()
  // each tried for as long as a reply is waited for, then let go
  await waitUntil(() => b.me._joining.size === 0 || null, 60000)
  await quiet()
  t.is((await passesOf(b.room)).length, 5, 'every pass stays')
  t.alike(errors, [], 'and onerror hears nothing')
})

// two devices that come and go, each cero() in a directory of its own
async function apart(t, opts = {}) {
  const testnet = opts.testnet || (await makeTestnet(t))
  const a = await ceroOpen(t, { ...opts, testnet })
  const general = await open(a.me.team, { name: 'general' })
  const b = await ceroOpen(t, { ...opts, testnet })
  await open(b.me.team, await cero.invite(general))
  await waitUntil(async () => (await devicesOf(general, b.me.id)).length > 0 || null)
  const plans = await open(a.me.team, { name: 'plans' })
  return { testnet, a, b, general, plans }
}

async function back(t, { dir, testnet }, opts = {}) {
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, ...opts })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return me
}

test('seat: she is offline at the seat, and the room shows up once she opens the room both are in', async (t) => {
  const { b, general, plans } = await apart(t)
  await b.me.close()
  await cero.seat(plans, b.me.id, { from: general })
  const me = await back(t, b)
  t.absent(await rowOf(me, plans.id), 'nothing while the room both are in stays closed')
  await open(me.team, { id: general.id })
  await reaches(me, plans.id, 'in')
  t.pass('in once it opens')
  await waitUntil(async () => (await passesOf(general)).length === 0 || null)
  t.pass('and the pass goes')
})

test('seat: revoked before she comes, she is turned away, the pass goes and the room rotates; seated again, she is in', async (t) => {
  const { b, general, plans } = await apart(t)
  await b.me.close()
  await cero.seat(plans, b.me.id, { from: general })
  const [{ id }] = (await get(plans.invites)).data
  t.ok(await cero.revoke(plans, id))
  await waitUntil(async () => (await get(plans.status)).data.epoch === 1 || null)
  t.pass('her devices had its keys: the room rotates')
  const me = await back(t, b)
  await open(me.team, { id: general.id })
  await reaches(me, plans.id, 'denied')
  t.is((await rowOf(me, plans.id)).reason, 'revoked', 'with the reason')
  await waitUntil(async () => (await passesOf(general)).length === 0 || null)
  t.is((await get(plans.members)).data.length, 1, 'nobody let in')

  await cero.seat(plans, b.me.id, { from: general })
  await reaches(me, plans.id, 'in')
  t.pass('seated again after her row ended, she is in')
})

test('seat: past its ttl before she comes, she is let into nothing and the pass goes', async (t) => {
  const { b, general, plans } = await apart(t)
  await b.me.close()
  await cero.seat(plans, b.me.id, { from: general, ttl: 200 })
  await waitUntil(async () => (await get(plans.invites)).data.length === 0 || null)
  const me = await back(t, b)
  await open(me.team, { id: general.id })
  await waitUntil(async () => (await passesOf(general)).length === 0 || null)
  t.absent(await rowOf(me, plans.id), 'nothing on her root')
})

test('seat: spent by a removal of someone else before she comes, she is turned away as removed', async (t) => {
  const { testnet, b, general, plans } = await apart(t)
  const c = await ceroOpen(t, { testnet })
  await open(c.me.team, await cero.invite(plans))
  await memberCount(plans, 2)
  await b.me.close()
  await cero.seat(plans, b.me.id, { from: general })
  await del(plans.members, c.me.id)
  const me = await back(t, b)
  await open(me.team, { id: general.id })
  await reaches(me, plans.id, 'denied')
  t.is((await rowOf(me, plans.id)).reason, 'removed')
})

test('seat: the room rotated after the seat, she is let in and reads what was written since', async (t) => {
  const { b, general, plans } = await apart(t)
  await b.me.close()
  await cero.seat(plans, b.me.id, { from: general })
  await cero.rotate(plans)
  await cero.put(plans.notes, { text: 'after' })
  const me = await back(t, b)
  await open(me.team, { id: general.id })
  await reaches(me, plans.id, 'in')
  const room = await open(me.team, { id: plans.id })
  await waitUntil(async () => (await get(room.notes)).data.length === 1 || null)
  t.pass('she reads what was written under the new key')
})

test('seat: the seater is offline when she comes, and she is let in through the mirror', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const mirrors = [b4a.toHex(mirror.publicKey)]
  const { a, b, general, plans } = await apart(t, { testnet, mirrors })
  await b.me.close()
  await cero.seat(plans, b.me.id, { from: general })
  for (const { store } of [general, plans]) {
    const core = mirror.store.get({ key: store.writerKey })
    await core.ready()
    await waitUntil(() => core.contiguousLength >= store.bee.local.length || null)
    await core.close()
  }
  await a.me.close()
  const me = await back(t, b, { mirrors })
  await open(me.team, { id: general.id })
  await reaches(me, plans.id, 'in')
  t.pass('in with nobody else online')
})

// her device stops at its `n`th claim in the room, as a killed app would, and comes back
async function stopsAt(t, n) {
  const { b, general, plans } = await apart(t)
  const { claim } = Database.prototype
  t.teardown(() => void (Database.prototype.claim = claim))
  let claims = 0
  Database.prototype.claim = async function (opts) {
    await claim.call(this, opts)
    if (this.identity.id !== b.me.id || !b4a.equals(this.key, plans.store.key)) return
    if (++claims === n) throw CeroError.CLOSED('Database')
  }
  await cero.seat(plans, b.me.id, { from: general })
  await waitUntil(() => claims === n || null)
  const state = await stateOf(b.me, plans.id)
  await b.me.close()
  Database.prototype.claim = claim
  const me = await back(t, b)
  await open(me.team, { id: general.id })
  await reaches(me, plans.id, 'in')
  await memberCount(plans, 2)
  t.is((await devicesOf(plans, b.me.id)).length, 1, 'one seat')
  return state
}

test('seat: stopped after its claim, before the root row moves on, she comes back in with one seat', async (t) => {
  t.is(await stopsAt(t, 1), 'asking')
})

test('seat: stopped while her root row is joining, she comes back in with one seat', async (t) => {
  t.is(await stopsAt(t, 2), 'joining')
})

test('seat: her other device took the seat and stopped before her root moved on, so this one sits beside it, that one comes in from her root, and so does one linked after', async (t) => {
  const { testnet, b, general, plans } = await apart(t)
  const linked = async (dir, root) => {
    const fresh = await cero(dir, spec, { bootstrap: testnet.bootstrap })
    t.teardown(() => fresh.close().catch(() => {}), { order: 5 })
    const linking = cero.link(fresh, await cero.invite(root))
    const asked = async () => (await get(root.requests)).data.find((r) => !r.admitted) || null
    await cero.accept(root, await waitUntil(asked))
    const me = await linking
    t.teardown(() => me.close().catch(() => {}), { order: 4 })
    return me
  }
  const phone = { dir: await t.tmp(), testnet }
  phone.me = await linked(phone.dir, b.me)
  await open(phone.me.team, { id: general.id })
  await waitUntil(async () => (await devicesOf(general, b.me.id)).length === 2 || null)

  // the phone is let in and stops before her root row moves on
  await b.me.close()
  const { claim } = Database.prototype
  t.teardown(() => void (Database.prototype.claim = claim))
  const device = phone.me.identity.device.publicKey
  Database.prototype.claim = async function (opts) {
    await claim.call(this, opts)
    const theirs = b4a.equals(this.identity.device.publicKey, device)
    if (theirs && b4a.equals(this.key, plans.store.key)) throw CeroError.CLOSED('Database')
  }
  await cero.seat(plans, b.me.id, { from: general })
  await waitUntil(async () => (await devicesOf(plans, b.me.id)).length === 1 || null)
  await phone.me.close()
  Database.prototype.claim = claim

  const me = await back(t, b)
  await open(me.team, { id: general.id })
  await reaches(me, plans.id, 'in')
  const room = await open(me.team, { id: plans.id })
  await cero.put(room.notes, { text: 'beside' })
  await waitUntil(async () => (await get(plans.notes)).data.length === 1 || null)
  t.pass('in, writing, on a writer of its own')

  const again = await back(t, phone)
  await reaches(again, plans.id, 'in')
  const theirs = await open(again.team, { id: plans.id })
  await cero.put(theirs.notes, { text: 'phone' })
  await waitUntil(async () => (await get(plans.notes)).data.length === 2 || null)
  t.pass('the phone comes in on the seat it took')
  const laptop = await linked(await t.tmp(), me)
  await reaches(laptop, plans.id, 'in')
  const late = await open(laptop.team, { id: plans.id })
  t.is(late.id, plans.id, 'one linked after opens it from her root')
})
test('seat: the room out of reach, nothing is on her root; in reach at the next open of the room both are in, she is in', async (t) => {
  const { testnet, a, b, general, plans } = await apart(t)
  const c = await ceroOpen(t, { testnet })
  const relay = await open(c.me.team, await cero.invite(general))
  await b.me.close()
  await cero.seat(plans, b.me.id, { from: general })
  await waitUntil(async () => (await passesOf(relay)).length === 1 || null)
  await a.me.close()
  const me = await back(t, b)
  await open(me.team, { id: general.id })
  await waitUntil(() => me._joining.size === 1 || null)
  await waitUntil(() => me._joining.size === 0 || null, 60000)
  t.absent(
    await rowOf(me, plans.id),
    'nothing on her root while only the room both are in is served'
  )
  const seater = await back(t, a)
  await open(seater.team, { id: plans.id })
  await me.close()
  const again = await back(t, b)
  await open(again.team, { id: general.id })
  await reaches(again, plans.id, 'in')
  t.pass('in once it is in reach')
})

test('seat: one at a time: a second before she comes, or while she is let in and not yet seated, is INVALID, and none is left open once she is in', async (t) => {
  const { b, general, plans } = await apart(t)
  const again = () => code(() => cero.seat(plans, b.me.id, { from: general }))
  await b.me.close()
  await cero.seat(plans, b.me.id, { from: general })
  t.is(await again(), 'INVALID', 'a second before she comes')
  t.is((await get(plans.invites)).data.length, 1, 'one seat open')

  const { claim } = Database.prototype
  t.teardown(() => void (Database.prototype.claim = claim))
  let held = false
  Database.prototype.claim = async function (opts) {
    if (!held && this.identity.id === b.me.id && b4a.equals(this.key, plans.store.key)) {
      held = true
      const promised = async () => (await get(plans.requests)).data.some((r) => r.promised) || null
      await waitUntil(promised)
      t.absent((await get(plans.members, b.me.id)).data, 'let in, not yet a member')
      t.is((await get(plans.invites)).data.length, 0, 'her seat used')
      t.is(await again(), 'INVALID', 'a second while her seat is not yet claimed')
    }
    return claim.call(this, opts)
  }
  const me = await back(t, b)
  await open(me.team, { id: general.id })
  await reaches(me, plans.id, 'in')
  t.ok(held)
  await memberCount(plans, 2)
  t.is((await get(plans.invites)).data.length, 0, 'none left open once she is in')
})

test('seat: a device that closes a room as soon as nothing holds it keeps the writer it came in on, and opens it seated on that one', async (t) => {
  const errors = []
  const { b, general, plans } = await apart(t, { keepOpen: 0, onerror: (err) => errors.push(err) })
  await cero.seat(plans, b.me.id, { from: general })
  await reaches(b.me, plans.id, 'in')
  await waitUntil(async () => (await devicesOf(plans, b.me.id)).length === 1 || null)
  await waitUntil(async () => (await b.me.local.store.get('asks')).data.length === 0 || null)
  const { data: kept } = await b.me.local.store.get('handle-keypairs', plans.id)
  t.ok(kept, 'its writer is kept')
  const room = await open(b.me.team, { id: plans.id })
  t.teardown(() => room.close().catch(() => {}))
  t.ok(room.store.writable, 'and the room opens seated on it')
  t.alike(room.store.keyPair.publicKey, kept.publicKey)
  t.is((await devicesOf(plans, b.me.id)).length, 1, 'no second seat')
  t.alike(errors, [])
})

test('seat: revoked and seated again before she comes, she takes the new seat whichever pass she reads first', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await ceroOpen(t, { testnet })
  const general = await open(a.me.team, { name: 'general' })
  const b = await ceroOpen(t, { testnet })
  // a reader where the passes wait: her device cannot take one away
  await open(b.me.team, await cero.invite(general, { role: 'reader' }))
  await waitUntil(async () => (await get(general.members)).data.length === 2 || null)
  const plans = await open(a.me.team, { name: 'plans' })
  await b.me.close()
  await cero.seat(plans, b.me.id, { from: general })
  const [{ id }] = (await get(plans.invites)).data
  t.ok(await cero.revoke(plans, id))
  await cero.seat(plans, b.me.id, { from: general })
  const me = await back(t, b)
  await open(me.team, { id: general.id })
  await reaches(me, plans.id, 'in')
  t.pass('in on the new seat')
})

test('seat: taken out while the room is closed on her device and seated again, she takes the new seat', async (t) => {
  const errors = []
  const { b, general, plans } = await apart(t, { keepOpen: 0, onerror: (err) => errors.push(err) })
  await cero.seat(plans, b.me.id, { from: general })
  await reaches(b.me, plans.id, 'in')
  await waitUntil(async () => (await devicesOf(plans, b.me.id)).length === 1 || null)
  await cero.del(plans.members, b.me.id)
  await waitUntil(async () => (await devicesOf(plans, b.me.id)).length === 0 || null)
  await cero.seat(plans, b.me.id, { from: general })
  await waitUntil(async () => (await devicesOf(plans, b.me.id)).length === 1 || null)
  t.pass('seated again')
  await waitUntil(async () => (await get(plans.invites)).data.length === 0 || null)
  t.pass('and no invite is left open')
  const room = await open(b.me.team, { id: plans.id })
  t.teardown(() => room.close().catch(() => {}))
  t.ok(room.store.writable, 'the room opens seated')
  t.alike(errors, [])
})

test('seat: her request turned away after she asked, her row is denied with the reason', async (t) => {
  const { b, general, plans } = await apart(t)
  const { claim } = Database.prototype
  t.teardown(() => void (Database.prototype.claim = claim))
  Database.prototype.claim = async function (opts) {
    if (this.identity.id === b.me.id && b4a.equals(this.key, plans.store.key)) {
      t.is(await stateOf(b.me, plans.id), 'asking', 'she asked')
      const asked = async () => (await get(plans.requests)).data[0] || null
      await cero.deny(plans, await waitUntil(asked), 'not now')
      const writer = hid.encode(this.writerKey)
      await waitUntil(() => this.view.get(`@${this.ns}/refusals`, { id: writer }))
    }
    return claim.call(this, opts)
  }
  await cero.seat(plans, b.me.id, { from: general })
  await reaches(b.me, plans.id, 'denied')
  t.is((await rowOf(b.me, plans.id)).reason, 'not now')
  await waitUntil(async () => (await passesOf(general)).length === 0 || null)
  t.pass('and the pass goes')
})
