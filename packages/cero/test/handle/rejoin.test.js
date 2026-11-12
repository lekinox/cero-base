import test from 'brittle'
import b4a from 'b4a'

import hid from 'hypercore-id-encoding'

import { Identity } from '@cero-base/core/identity'

import { put, get, del, open } from '../../src/lib/operators.js'
import { cero } from '../../src/index.js'
import {
  makeStore,
  makeTestnet,
  makeNet,
  waitForConnection,
  waitUntil,
  openHandle,
  nextRequest
} from '../helpers/index.js'

test.configure({ timeout: 90000 })

// keepOpen 0: the owner closing the room is the owner gone, nobody serving it
async function room(t, testnet) {
  const a = await openHandle(t, { testnet, opts: { keepOpen: 0 } })
  await a.me.store.bootstrap({ name: 'owner-root' })
  const clinic = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => clinic.close().catch(() => {}))
  return { a, clinic }
}

// Apps hold a room OPEN while the user scans an invite for that same room. The
// idempotent shortcut returns the open handle while you are still a member —
// these cover the paths where it does not apply.

test('rejoin: joining a room that is already open returns it, no pairing conflict', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })
  const joined = await open(b.me.team, await cero.invite(clinic))
  t.teardown(() => joined.close().catch(() => {}))
  await waitForConnection(a.net)

  // still a member, room still open → must return the SAME handle, not re-pair
  const again = await open(b.me.team, await cero.invite(clinic))
  t.is(again.id, joined.id, 'second join returned the open room')
})

test('rejoin: re-admission after removal while the room is still open', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })
  const joined = await open(b.me.team, await cero.invite(clinic))
  t.teardown(() => joined.close().catch(() => {}))
  await waitForConnection(a.net)
  await put(clinic.messages, { text: 'pre' })

  // owner removes b; the room rotates its key by itself
  await del(clinic.members, b.identity.id)
  await waitUntil(async () => (await get(clinic.status)).data.epoch === 1 || null)
  await waitUntil(async () => {
    const { data } = await get(clinic.members, b.identity.id)
    return data ? null : true
  })

  // b's handle is STILL OPEN locally (the app keeps the expo mounted) and now
  // re-joins with a fresh invite — the re-admission path
  const back = await open(b.me.team, await cero.invite(clinic))
  t.teardown(() => back.close().catch(() => {}))
  t.ok(back.id, 're-admitted without a pairing conflict')
})

test('rejoin: a member let back in after a rotation reopens the room and reads its history', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)
  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })
  const joined = await open(b.me.team, await cero.invite(clinic))
  await waitForConnection(a.net)
  await put(joined.messages, { text: 'first' })
  // written by a device that seated itself a moment ago: the owner has it before she removes it
  await waitUntil(async () => (await get(clinic.messages)).data.length === 1)

  await del(clinic.members, b.identity.id)
  await cero.rotate(clinic)
  await put(clinic.messages, { text: 'while out' })
  await waitUntil(async () => ((await get(joined.members, b.identity.id)).data ? null : true))
  await joined.close()

  const back = await open(b.me.team, await cero.invite(clinic))
  await put(back.messages, { text: 'back' })
  await put(clinic.messages, { text: 'after' })
  const texts = async (room) => (await get(room.messages)).data.map((m) => m.text).sort()
  const all = ['after', 'back', 'first', 'while out']
  await waitUntil(async () => ((await texts(back)).length === 4 ? true : null))
  t.alike(await texts(back), all, 'let back in, it reads the whole history')
  await back.close()

  const reopened = await open(b.me.team, { id: back.id })
  t.teardown(() => reopened.close().catch(() => {}))
  t.alike(await texts(reopened), all, 'and reads it again once reopened')
  await put(reopened.messages, { text: 'again' })
  await waitUntil(async () => ((await texts(clinic)).includes('again') ? true : null))
  t.pass('and writes')
})

test('rejoin: a revoked device never re-joins; a new device of the member does', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })
  const joined = await open(b.me.team, await cero.invite(clinic))
  await waitForConnection(a.net)
  const k1 = b4a.from(joined.store.writerKey)

  // the owner revokes the device once its claim reached it
  await waitUntil(async () => (await get(clinic.devices, hid.encode(k1))).data || null)
  // only this DEVICE is revoked, so b's member row survives: its key is kept out for good
  await del(clinic.devices, hid.encode(k1))
  await waitUntil(async () => {
    const { data } = await get(joined.devices, hid.encode(k1))
    return data ? null : true
  })
  await joined.close() // app restart — the re-join reaches for a fresh writer, the same key

  const err = await open(b.me.team, await cero.invite(clinic)).catch((e) => e)
  t.is(err?.code, 'DENIED', 'the revoked device key is turned away')
  t.is(err?.reason, 'removed')

  // the member comes back on a new device: here one the phrase attests
  const recovered = await Identity.create({ seed: b.identity.seed })
  const c = await openHandle(t, { testnet, identity: recovered })
  await c.me.store.bootstrap({ name: 'new-device-root' })
  const back = await open(c.me.team, await cero.invite(clinic))
  t.teardown(() => back.close().catch(() => {}))
  t.ok(back.store.writable, 'writable as a new device of the same member')
  t.is((await get(back.members)).data.length, 2, 'the member row stayed')

  await put(back.messages, { text: 'back' })
  await waitUntil(async () => {
    const { data } = await get(clinic.messages)
    return data.some((m) => m.text === 'back') || null
  })
  t.pass('the host sees a row from the new device')
})

test('rejoin: after leave() then re-join with a fresh invite', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })
  const joined = await open(b.me.team, await cero.invite(clinic))
  await waitForConnection(a.net)

  // the app's self-kick does exactly this: forget the room locally
  await cero.leave(joined)
  // a code minted once the room holds her leaving lets her straight back in
  await waitUntil(async () => !(await get(clinic.members, b.me.identity.id)).data)

  const back = await open(b.me.team, await cero.invite(clinic))
  t.teardown(() => back.close().catch(() => {}))
  t.ok(back.id, 're-joined after leave without a pairing conflict')
})

// leaving is hers, not a removal: an older code, or the reusable one, brings her back once a member accepts her again,
// so leaving first never dodges a removal; a code minted after she left lets her straight in. Someone else taking her
// out turns older codes away
async function leaver(t, testnet, clinic, code) {
  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })
  const joined = await open(b.me.team, code)
  await waitUntil(async () => (await get(clinic.members, b.me.identity.id)).data)
  return { b, joined }
}

async function left(t, testnet, clinic, code) {
  const { b, joined } = await leaver(t, testnet, clinic, code)
  await cero.leave(joined)
  await waitUntil(async () => !(await get(clinic.members, b.me.identity.id)).data)
  return b
}

test('rejoin: she leaves; a code minted before brings her back once a member accepts her', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const spare = await cero.invite(clinic)
  const b = await left(t, testnet, clinic, await cero.invite(clinic))
  const back = open(b.me.team, spare)
  back.catch(() => {})
  const request = await nextRequest(clinic)
  t.is(
    request.identity && hid.encode(request.identity),
    b.me.identity.id,
    'she waits for an answer'
  )
  await cero.accept(clinic, request)
  const room2 = await back
  t.teardown(() => room2.close().catch(() => {}))
  await waitUntil(async () => (await get(clinic.members, b.me.identity.id)).data)
  t.pass('back in')
})

test('rejoin: she leaves; the reusable code waits too, and a denial turns her away', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const reusable = await cero.invite(clinic, { reuse: true })
  const b = await left(t, testnet, clinic, reusable)
  const back = open(b.me.team, reusable)
  back.catch(() => {})
  await cero.deny(clinic, await nextRequest(clinic), 'not now')
  await t.exception(back, /DENIED/)
})

test('rejoin: she leaves; a code minted after lets her straight in', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const b = await left(t, testnet, clinic, await cero.invite(clinic))
  const back = await open(b.me.team, await cero.invite(clinic))
  t.teardown(() => back.close().catch(() => {}))
  t.ok(back.id, 'in, nobody asked')
})

test('rejoin: taken out by the owner, a code minted before is still turned away', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const spare = await cero.invite(clinic)
  const { b, joined } = await leaver(t, testnet, clinic, await cero.invite(clinic))
  await del(clinic.members, b.me.identity.id)
  // her device learns it was taken out before she scans the older code
  await waitUntil(async () => !(await get(joined.members, b.me.identity.id)).data)
  const err = await open(b.me.team, spare).catch((e) => e)
  t.is(err?.code, 'DENIED')
  t.is(err?.reason, 'removed')
})

// what an app reads to end what the handle gave her elsewhere: an explicit record, never a row not yet here
test('removed: taken out says removed, leaving says left, a member or a stranger says nothing', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)
  const { b } = await leaver(t, testnet, clinic, await cero.invite(clinic))
  t.is(await cero.removed(clinic, b.me.identity.id), null, 'a member')
  t.is(await cero.removed(clinic, Identity.randomBytes(32).toString('hex')), null, 'never one')
  t.is(await cero.removed(clinic, a.me.identity.id), null, 'the owner')
  await del(clinic.members, b.me.identity.id)
  t.is(await cero.removed(clinic, b.me.identity.id), 'removed', 'taken out')
  const c = await left(t, testnet, clinic, await cero.invite(clinic))
  t.is(await cero.removed(clinic, c.me.identity.id), 'left', 'left on her own')
})

test('removed: someone let in again after is a member', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const b = await left(t, testnet, clinic, await cero.invite(clinic))
  t.is(await cero.removed(clinic, b.me.identity.id), 'left')
  const back = await open(b.me.team, await cero.invite(clinic))
  t.teardown(() => back.close().catch(() => {}))
  await waitUntil(async () => (await get(clinic.members, b.me.identity.id)).data)
  t.is(await cero.removed(clinic, b.me.identity.id), null, 'back in')
})

test('rejoin: deleting someone who is no member, by any id, revokes no device', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const b = await left(t, testnet, clinic, await cero.invite(clinic))
  await del(clinic.members, b.me.identity.id)
  await del(clinic.members, b.me.device.id)
  await del(clinic.members, hid.encode(b.me.identity.device.publicKey))
  const back = await open(b.me.team, await cero.invite(clinic))
  t.teardown(() => back.close().catch(() => {}))
  t.ok(back.id, 'her device still comes in with a new code')
})

test('rejoin: two concurrent joins of the same room do not collide', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })

  // a retry racing a still-pending join (the client times out before the
  // server-side join does, the user taps Join again) — the joiner Pairing
  // must not collide with the previous attempt's
  const invite = await cero.invite(clinic)
  const [one, two] = await Promise.all([open(b.me.team, invite), open(b.me.team, invite)])
  t.teardown(() => one.close().catch(() => {}))
  t.is(one.id, two.id, 'both resolved to a single room handle')
})

test('rejoin: joins to two DIFFERENT rooms can be in flight at once', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const other = await openHandle(t, { testnet })
  await other.me.store.bootstrap({ name: 'other-owner' })
  const gym = await open(other.me.team, { name: 'gym' })
  t.teardown(() => gym.close().catch(() => {}))

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })

  const [one, two] = await Promise.all([
    open(b.me.team, await cero.invite(clinic)),
    open(b.me.team, await cero.invite(gym))
  ])
  t.teardown(() => one.close().catch(() => {}))
  t.teardown(() => two.close().catch(() => {}))
  t.not(one.id, two.id, 'joined both rooms concurrently without a pairing conflict')
})

// ─── coalescing semantics ────────────────────────────────────────────────────

test('rejoin: coalesced by room, not by invite string', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })

  // two DIFFERENT invites to the same room, in flight together — the in-flight
  // map is keyed by the room topic, so both must land on one handle
  const [one, two] = await Promise.all([
    open(b.me.team, await cero.invite(clinic)),
    open(b.me.team, await cero.invite(clinic))
  ])
  t.teardown(() => one.close().catch(() => {}))
  t.is(one.id, two.id, 'different invites to one room coalesced')
})

test('rejoin: a failed join does not poison later joins of the same room', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)
  const id = clinic.id
  const dead = await cero.invite(clinic)

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })

  // nobody serves the invite once the room is closed → the join times out
  await clinic.close()
  try {
    await b.me._join(dead, 'team', { timeout: 3000 })
    t.fail('join of an unserved invite should time out')
  } catch (err) {
    t.is(err.code, 'TIMEOUT', 'unserved join timed out')
  }

  // the owner comes back; a FRESH invite (same room topic — same in-flight
  // key) must pair cleanly, so the failed attempt was cleared from the map
  const clinic2 = await open(a.me.team, { id })
  t.teardown(() => clinic2.close().catch(() => {}))
  const back = await open(b.me.team, await cero.invite(clinic2))
  t.teardown(() => back.close().catch(() => {}))
  t.is(back.id, id, 'retry after a failed join pairs cleanly')
})

test('rejoin: concurrent waiters share the in-flight join failure', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const dead = await cero.invite(clinic)
  await clinic.close()

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-root' })

  const results = await Promise.allSettled([
    b.me._join(dead, 'team', { timeout: 3000 }),
    b.me._join(dead, 'team', { timeout: 3000 })
  ])
  t.is(results[0].status, 'rejected', 'first waiter rejected')
  t.is(results[1].status, 'rejected', 'second waiter rejected')
  for (const r of results) {
    t.is(r.reason.code, 'TIMEOUT', 'waiters saw the real failure, not a pairing collision')
  }
})

// ─── host and joiner pairings coexist ────────────────────────────────────────

test('rejoin: hosting a room while joining another does not collide', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'host-and-joiner' })
  const gym = await open(b.me.team, { name: 'gym' }) // b hosts…
  t.teardown(() => gym.close().catch(() => {}))

  const joined = await open(b.me.team, await cero.invite(clinic)) // …while joining
  t.teardown(() => joined.close().catch(() => {}))
  t.ok(joined.id, 'joined while hosting')

  // and b's own room still serves invites afterwards
  const c = await openHandle(t, { testnet })
  await c.me.store.bootstrap({ name: 'third' })
  const intoGym = await open(c.me.team, await cero.invite(gym))
  t.teardown(() => intoGym.close().catch(() => {}))
  t.is(intoGym.id, gym.id, "b's hosting pairing still accepts candidates")
})

test('rejoin: reuse invite admits two identities concurrently', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const invite = await cero.invite(clinic, { reuse: true })

  const b = await openHandle(t, { testnet })
  await b.me.store.bootstrap({ name: 'peer-b' })
  const c = await openHandle(t, { testnet })
  await c.me.store.bootstrap({ name: 'peer-c' })

  const [one, two] = await Promise.all([open(b.me.team, invite), open(c.me.team, invite)])
  t.teardown(() => one.close().catch(() => {}))
  t.teardown(() => two.close().catch(() => {}))
  t.is(one.id, clinic.id, 'first identity admitted')
  t.is(two.id, clinic.id, 'second identity admitted')
})
