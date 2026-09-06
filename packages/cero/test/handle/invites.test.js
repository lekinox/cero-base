import test from 'brittle'

import { Identity } from '@cero-base/core/identity'

import { Handle } from '../../src/handle/index.js'
import { get, open } from '../../src/lib/operators.js'
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
  const me = new Handle({ store, identity, network: net, spec, ...opts })
  await me.ready()
  t.teardown(
    async () => {
      try {
        await me.close()
      } catch {}
      try {
        await discovery.destroy()
      } catch {}
    },
    { order: 5 }
  )
  return { me, store, identity, net, testnet, discovery }
}

async function joinAsRoot(t, testnet, inviteStr) {
  const peer = await ceroOpen(t, { testnet })
  await peer.me.bootstrap({ name: 'peer-root' })
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
  const a = await ceroOpen(t, { testnet })
  await a.me.bootstrap({ name: 'a-root' })

  const room = await open(a.me.team, { name: 'clinic' })
  const b = await joinAsRoot(t, testnet, await room.invite({ role: 'member' }))
  await memberCount(room, 2)

  // b joined as a member — it may pass on what it holds, and nothing above it
  await t.exception(b.room.invite({ role: 'owner' }), /exceeds your own role/i)
  await t.exception(b.room.invite({ role: 'admin' }), /exceeds your own role/i)
  t.ok(await b.room.invite({ role: 'member' }), 'its own rank is fine')
})

test('invites: a member cannot revoke — an owner can, and every replica stops serving', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await ceroOpen(t, { testnet })
  await a.me.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  const b = await joinAsRoot(t, testnet, await room.invite({ role: 'member' }))
  await memberCount(room, 2)

  const inv = await room.invite({ role: 'member' })
  const rows = async (h) => (await get(h.invites)).data.length
  t.is(await rows(room), 1, 'one live invite')

  // refused before anything is revoked locally — otherwise b would stop serving
  // it while every other replica kept doing so
  await t.exception(b.room.revoke(inv), /remove permission/i, 'a member is refused')
  t.is(await rows(room), 1, 'the invite row is untouched')

  t.ok(await room.revoke(inv), 'the owner revokes it')
  await waitUntil(async () => ((await rows(b.room)) === 0 ? true : null))
  t.is(await rows(b.room), 0, "and the member's replica stops serving it")
})

test('invites: survive a close/reopen — served by a fresh handle', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await ceroOpen(t, { testnet })
  await a.me.bootstrap({ name: 'a-root' })

  const room = await open(a.me.team, { name: 'clinic' })
  const inviteStr = await room.invite()
  const roomId = room.id
  await room.close()

  // fresh handle, fresh Pairing, empty in-memory invite map — the invite must
  // come back from the persisted row
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

test('invites: any member replica serves an invite after the minter goes offline', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await ceroOpen(t, { testnet })
  await a.me.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))

  const b = await joinAsRoot(t, testnet, await room.invite())
  await waitForConnection(a.net)

  const invite2 = await room.invite()
  // the persisted row must land in B's replica AND its served set before A leaves
  await waitUntil(() => (b.room.pair._invites.size >= 1 ? true : null))
  await room.close()

  const c = await joinAsRoot(t, testnet, invite2)
  t.ok(c.room, 'joiner admitted while the minting device is offline')
  await memberCount(c.room, 3)
  t.pass('member B served an invite it never minted')
})

test('invites: revoke propagates — other members stop serving', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await ceroOpen(t, { testnet })
  await a.me.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))

  const b = await joinAsRoot(t, testnet, await room.invite())
  await waitForConnection(a.net)

  const invite3 = await room.invite()
  await waitUntil(() => (b.room.pair._invites.size >= 1 ? true : null))

  t.ok(room.revoke(invite3), 'revoke found the live invite')
  await waitUntil(async () => {
    const { data } = await get(b.room.invites)
    return data.length === 0 ? true : null
  })
  await waitUntil(() => (b.room.pair._invites.size === 0 ? true : null))
  t.pass('replicated revoke cleared the served set on the other member')
})

test('invites: reuse admits multiple joiners and its row survives', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await ceroOpen(t, { testnet })
  await a.me.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))

  const multi = await room.invite({ reuse: true })
  await joinAsRoot(t, testnet, multi)
  await joinAsRoot(t, testnet, multi)
  await memberCount(room, 3)

  const { data: rows } = await get(room.invites)
  t.is(rows.length, 1, 'reusable invite row still present after two admissions')
})
