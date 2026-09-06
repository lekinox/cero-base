import test from 'brittle'
import b4a from 'b4a'

import { Identity } from '@cero-base/core/identity'
import hid from 'hypercore-id-encoding'

import { Handle } from '../../src/handle/index.js'
import { Local } from '../../src/local/index.js'
import { put, get, del, open, rotate } from '../../src/lib/operators.js'
import { spec } from '../fixtures/spec/index.js'
import { makeStore, makeTestnet, makeNet, waitForConnection, waitUntil } from '../helpers/index.js'

test.configure({ timeout: 90000 })

async function ceroOpen(t, opts = {}) {
  const { store } = await makeStore(t)
  const identity = opts.identity || (await Identity.generate())
  const testnet = opts.testnet || (await makeTestnet(t))
  const net = await makeNet(t, testnet)
  const discovery = net.join(identity.topic)
  await discovery.flush()
  // rejoins hinge on the per-handle writer keypairs the local store persists
  const local = new Local(null, spec, { store })
  await local.ready()
  const me = new Handle({ store, identity, network: net, spec, local, ...opts })
  await me.ready()
  t.teardown(
    async () => {
      try {
        await me.close()
      } catch {}
    },
    { order: 1 }
  )
  return { me, net, identity }
}

async function room(t, testnet) {
  const a = await ceroOpen(t, { testnet })
  await a.me.bootstrap({ name: 'owner-root' })
  const clinic = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => clinic.close().catch(() => {}))
  return { a, clinic }
}

// Apps hold a room OPEN while the user scans an invite for that same room. Only
// ONE blind-pairing listener may exist per discovery key, so a second live
// handle for the same room throws 'Active member already exist'. The idempotent
// shortcut hides this while you are still a member — these cover the paths
// where it does not apply.

test('rejoin: joining a room that is already open returns it, no pairing conflict', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'peer-root' })
  const joined = await open(b.me.team, await clinic.invite())
  t.teardown(() => joined.close().catch(() => {}))
  await waitForConnection(a.net)

  // still a member, room still open → must return the SAME handle, not re-pair
  const again = await open(b.me.team, await clinic.invite())
  t.is(again.id, joined.id, 'second join returned the open room')
})

test('rejoin: re-admission after removal while the room is still open', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'peer-root' })
  const joined = await open(b.me.team, await clinic.invite())
  t.teardown(() => joined.close().catch(() => {}))
  await waitForConnection(a.net)
  await put(clinic.messages, { text: 'pre' })

  // owner removes b, exactly like the app's member.remove (del + rotate)
  await del(clinic.members, b.identity.id)
  await rotate(clinic)
  await waitUntil(async () => {
    const { data } = await get(clinic.members, b.identity.id)
    return data ? null : true
  })

  // b's handle is STILL OPEN locally (the app keeps the expo mounted) and now
  // re-joins with a fresh invite — the re-admission path
  const back = await open(b.me.team, await clinic.invite())
  t.teardown(() => back.close().catch(() => {}))
  t.ok(back.id, 're-admitted without a pairing conflict')
})

test('rejoin: a revoked device re-joins with a fresh writer', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'peer-root' })
  const joined = await open(b.me.team, await clinic.invite())
  await waitForConnection(a.net)
  const k1 = b4a.from(joined.store.writerKey)

  // only this DEVICE is revoked, so b's member row survives — the stored
  // keypair still looks reusable while its writer core is frozen for good
  await del(clinic.devices, hid.encode(k1))
  await waitUntil(async () => {
    const { data } = await get(joined.devices, hid.encode(k1))
    return data ? null : true
  })
  await joined.close() // app restart — the re-join reaches for the stored keypair

  const back = await open(b.me.team, await clinic.invite())
  t.teardown(() => back.close().catch(() => {}))
  t.absent(b4a.equals(k1, back.store.writerKey), 're-joined on a fresh writer')
  t.ok(back.store.writable, 'writable again')

  await put(back.messages, { text: 'back' })
  await waitUntil(async () => {
    const { data } = await get(clinic.messages)
    return data.some((m) => m.text === 'back') || null
  })
  t.pass('the host sees a row from the fresh writer')
})

test('rejoin: after leave() then re-join with a fresh invite', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'peer-root' })
  const joined = await open(b.me.team, await clinic.invite())
  await waitForConnection(a.net)

  // the app's self-kick does exactly this: forget the room locally
  await joined.leave()

  const back = await open(b.me.team, await clinic.invite())
  t.teardown(() => back.close().catch(() => {}))
  t.ok(back.id, 're-joined after leave without a pairing conflict')
})

test('rejoin: two concurrent joins of the same room do not collide', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'peer-root' })

  // a retry racing a still-pending join (the client times out before the
  // server-side join does, the user taps Join again) — the joiner Pairing
  // must not collide with the previous attempt's
  const invite = await clinic.invite()
  const [one, two] = await Promise.all([open(b.me.team, invite), open(b.me.team, invite)])
  t.teardown(() => one.close().catch(() => {}))
  t.is(one.id, two.id, 'both resolved to a single room handle')
})

test('rejoin: joins to two DIFFERENT rooms can be in flight at once', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const other = await ceroOpen(t, { testnet })
  await other.me.bootstrap({ name: 'other-owner' })
  const gym = await open(other.me.team, { name: 'gym' })
  t.teardown(() => gym.close().catch(() => {}))

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'peer-root' })

  const [one, two] = await Promise.all([
    open(b.me.team, await clinic.invite()),
    open(b.me.team, await gym.invite())
  ])
  t.teardown(() => one.close().catch(() => {}))
  t.teardown(() => two.close().catch(() => {}))
  t.not(one.id, two.id, 'joined both rooms concurrently without a pairing conflict')
})

// ─── coalescing semantics ────────────────────────────────────────────────────

test('rejoin: coalesced by room, not by invite string', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'peer-root' })

  // two DIFFERENT invites to the same room, in flight together — the in-flight
  // map is keyed by the room topic, so both must land on one handle
  const [one, two] = await Promise.all([
    open(b.me.team, await clinic.invite()),
    open(b.me.team, await clinic.invite())
  ])
  t.teardown(() => one.close().catch(() => {}))
  t.is(one.id, two.id, 'different invites to one room coalesced')
})

test('rejoin: a failed join does not poison later joins of the same room', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, clinic } = await room(t, testnet)
  const id = clinic.id
  const dead = await clinic.invite()

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'peer-root' })

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
  const back = await open(b.me.team, await clinic2.invite())
  t.teardown(() => back.close().catch(() => {}))
  t.is(back.id, id, 'retry after a failed join pairs cleanly')
})

test('rejoin: concurrent waiters share the in-flight join failure', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const dead = await clinic.invite()
  await clinic.close()

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'peer-root' })

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

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'host-and-joiner' })
  const gym = await open(b.me.team, { name: 'gym' }) // b hosts…
  t.teardown(() => gym.close().catch(() => {}))

  const joined = await open(b.me.team, await clinic.invite()) // …while joining
  t.teardown(() => joined.close().catch(() => {}))
  t.ok(joined.id, 'joined while hosting')

  // and b's own room still serves invites afterwards
  const c = await ceroOpen(t, { testnet })
  await c.me.bootstrap({ name: 'third' })
  const intoGym = await open(c.me.team, await gym.invite())
  t.teardown(() => intoGym.close().catch(() => {}))
  t.is(intoGym.id, gym.id, "b's hosting pairing still accepts candidates")
})

test('rejoin: reuse invite admits two identities concurrently', async (t) => {
  const testnet = await makeTestnet(t)
  const { clinic } = await room(t, testnet)
  const invite = await clinic.invite({ reuse: true })

  const b = await ceroOpen(t, { testnet })
  await b.me.bootstrap({ name: 'peer-b' })
  const c = await ceroOpen(t, { testnet })
  await c.me.bootstrap({ name: 'peer-c' })

  const [one, two] = await Promise.all([open(b.me.team, invite), open(c.me.team, invite)])
  t.teardown(() => one.close().catch(() => {}))
  t.teardown(() => two.close().catch(() => {}))
  t.is(one.id, clinic.id, 'first identity admitted')
  t.is(two.id, clinic.id, 'second identity admitted')
})

test('rejoin: a join-only Pairing refuses to mint invites', async (t) => {
  const { Pairing } = await import('@cero-base/core/pairing')
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  const identity = await Identity.generate()

  const pair = new Pairing({ network: net, identity, host: false })
  await pair.ready()
  t.teardown(() => pair.close().catch(() => {}))

  await t.exception(
    () => pair.createInvite(),
    /join-only/,
    'minting on a join-only pairing fails loudly instead of handing out a dead invite'
  )
})
