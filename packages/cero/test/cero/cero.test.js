import test from 'brittle'
import process from 'process'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import c from 'compact-encoding'

import { Identity } from '@cero-base/core/identity'
import { decodeId } from '@cero-base/core/blobs/codec'
import { Invite } from '@cero-base/core/invite'
import { Pairing } from '@cero-base/core/pairing'
import { epochEntries } from '@cero-base/core/database/encryption'

import { cero, put, set, get, open, peek, restore } from '../../src/index.js'
import { spec } from '../fixtures/spec/index.js'
import {
  makeTestnet,
  makeMirror,
  holds,
  waitForConnection,
  waitUntil,
  ceroOpen
} from '../helpers/index.js'

test.configure({ timeout: 90000 })

// ─── channel ──────────────────────────────────────────────────────────────

test('channel: opt threads to the network', async (t) => {
  const { me } = await ceroOpen(t, { channel: 'dev' })
  t.is(me.network.channel, 'dev', 'channel reached Network')
})

test('mirrors: opt threads to the network and survives restore', async (t) => {
  const key = b4a.toString(b4a.alloc(32, 1), 'hex')
  const { me } = await ceroOpen(t, { mirrors: [key] })
  t.ok(me.network._blindPeering, 'blind peering constructed when mirrors are passed')
  t.alike(me.network.mirrors[0], b4a.alloc(32, 1), 'mirror key decoded from hex')
  t.alike(me._opts.mirrors, [key], 'mirrors retained on opts for restore')
})

test('mirrors: a joiner knocks while every member is offline or suspended, the mirror holds it', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const mirrors = [b4a.toString(mirror.publicKey, 'hex')]
  const { me: owner } = await ceroOpen(t, { testnet, mirrors })
  const room = await open(owner.team, { name: 'clinic' })
  const invite = await room.invite()
  await owner.suspend()

  // the same app, so the same mirrors
  const { me: joiner } = await ceroOpen(t, { testnet, mirrors })
  const knocked = holds(mirror, Invite.parse(invite).address)
  const joining = open(joiner.team, invite)
  await knocked
  t.is((await get(room.members)).data.length, 1, 'a suspended owner admits nobody')

  await owner.resume()
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
  const mirrors = [b4a.toString(mirror.publicKey, 'hex')]
  const owner = await ceroOpen(t, { testnet, mirrors })
  const room = await open(owner.me.team, { name: 'clinic' })
  const { id } = room
  const invite = await room.invite()
  await owner.me.close()

  // the joiner knocks alone and leaves: the knock waits on the app's mirror
  const joiner = await ceroOpen(t, { testnet, mirrors })
  const knocked = holds(mirror, Invite.parse(invite).address)
  joiner.me._join(invite, 'team', { timeout: 500 }).catch(() => {})
  await knocked
  await joiner.me.close()

  // the owner comes back alone, admits it, and leaves once the reply and the admission are on
  // the mirror
  const back = await reopen(t, owner.dir, testnet, { mirrors })
  const reopened = await open(back.team, { id })
  await waitUntil(async () => ((await get(reopened.members)).data.length === 2 ? true : null))
  await waitUntil(async () => ((await back.mailbox.outbox.list()).length === 0 ? true : null))
  const { writerKey, bee } = reopened.store
  const mirrored = mirror.store.get({ key: writerKey })
  await mirrored.ready()
  await waitUntil(() => mirrored.contiguousLength >= bee.local.length || null)
  await mirrored.close()
  await back.close()

  const again = await reopen(t, joiner.dir, testnet, { mirrors })
  t.ok(await joined(again, id), 'joined with nobody else online')
})

test('invites: a join survives the joiner restarting, and lands once a member is back', async (t) => {
  const testnet = await makeTestnet(t)
  const { me: owner } = await ceroOpen(t, { testnet })
  const room = await open(owner.team, { name: 'clinic' })
  const invite = await room.invite()
  await owner.suspend()

  const joiner = await ceroOpen(t, { testnet })
  const err = await joiner.me._join(invite, 'team', { timeout: 1000 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT', 'the caller stops waiting')
  await joiner.me.close()

  await owner.resume()
  const again = await reopen(t, joiner.dir, testnet)
  t.ok(await joined(again, room.id), 'the join went on after the restart')
})

test('invites: a reply survives the member restarting', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic', accept: false })
  const { id } = room
  const invite = await room.invite()

  // the joiner knocks, then leaves before the member answers
  const joiner = await ceroOpen(t, { testnet })
  const knocked = new Promise((resolve) => room.pair.once('candidate', resolve))
  const waiting = joiner.me._join(invite, 'team', { timeout: 1000 }).catch((e) => e)
  const candidate = await knocked
  await waiting
  await joiner.me.close()

  // admitted while the joiner is away, and the invite consumed: only the kept reply can get
  // the joiner in, the outbox has to carry it across the restart
  await room.accept(candidate)
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
  const invite = await room.invite()

  // the reply landed and the writer was admitted, then the joiner stopped: nothing left to knock for
  const joiner = await ceroOpen(t, { testnet })
  const { identity, mailbox } = joiner.me
  const { key, encryptionKey, epochs, writer } = await Pairing.join(mailbox, invite, { identity })
  await room.revoke(invite)
  const { discoveryKey } = Invite.parse(invite)
  await joiner.me.local.store.put('joins', {
    id: b4a.toHex(discoveryKey),
    type: 'team',
    invite,
    publicKey: writer.publicKey,
    secretKey: writer.secretKey,
    key,
    encryptionKey,
    epochs: c.encode(epochEntries, epochs)
  })
  await joiner.me.close()

  const again = await reopen(t, joiner.dir, testnet)
  t.ok(await joined(again, room.id), 'opened from the kept keys')
})

test('invites: a join request waiting for approval survives the member restarting', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic', accept: false })
  const { id } = room
  const invite = await room.invite()

  // the joiner knocks and leaves; only the member's inbox still has the request
  const joiner = await ceroOpen(t, { testnet })
  const knocked = new Promise((resolve) => room.pair.once('candidate', resolve))
  const waiting = joiner.me._join(invite, 'team', { timeout: 1000 }).catch((e) => e)
  await knocked
  await waiting
  await joiner.me.close()

  // the member restarts before approving, and still sees the request
  await owner.me.close()
  const back = await reopen(t, owner.dir, testnet)
  const again = await open(back.team, { id, accept: false })
  await waitUntil(() => again.pair.pending.size > 0 || null)
  await again.accept([...again.pair.pending][0])

  const returned = await reopen(t, joiner.dir, testnet)
  t.ok(await joined(returned, id), 'approved while the joiner was away')
})

// an invite nobody serves: the join stays pending
function nowhere(opts) {
  const random = () => Identity.randomBytes(32)
  return Invite.create({ discoveryKey: random(), address: random(), ...opts }).toString()
}

test('invites: an owner back online serves its invites without opening the room', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const { id } = room
  const invite = await room.invite()
  await owner.me.close()

  const joiner = await ceroOpen(t, { testnet })
  joiner.me._join(invite, 'team', { timeout: 0 }).catch(() => {})

  // the app only boots; nobody opens the room
  await reopen(t, owner.dir, testnet)
  t.ok(await joined(joiner.me, id), 'admitted by the room reopened at boot')
})

test('invites: a gated room reopened at boot stays gated', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic', accept: false })
  const { id } = room
  const invite = await room.invite()
  await owner.me.close()

  const joiner = await ceroOpen(t, { testnet })
  joiner.me._join(invite, 'team', { timeout: 0 }).catch(() => {})

  const back = await reopen(t, owner.dir, testnet)
  const served = await waitUntil(() => [...back.children].find((c) => c.id === id) || null)
  const request = await waitUntil(() => [...served.pair.pending][0] || null)
  t.is((await get(served.members)).data.length, 1, 'waiting for the app, not admitted')
  await served.accept(request)
  t.ok(await joined(joiner.me, id))
})

test('invites: a room with no invite left is not reopened at boot', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const serving = async (me) => (await me.local.store.get('serving')).data.length
  const invite = await room.invite()
  await waitUntil(async () => ((await serving(owner.me)) === 1 ? true : null))

  const joiner = await ceroOpen(t, { testnet })
  await open(joiner.me.team, invite)
  await waitUntil(async () => ((await serving(owner.me)) === 0 ? true : null))
  t.pass('the used invite takes the room off the list')
})

test('invites: a room left with invites still served is dropped from the list at boot', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  await room.invite()
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
  const invite = await room.invite({ role: 'reader' })

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
  const joined = await open(joiner.me.team, await room.invite({ role: 'reader' }))
  t.absent(joined.store.writable)

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
  const joined = await open(joiner.me.team, await room.invite({ role: 'admin' }))

  const { data: member } = await get(joined.members, joiner.me.identity.id)
  t.is(member.role, 'admin')
  t.ok(joined.store.writable)
  t.ok(await joined.invite({ role: 'member' }), 'an admin mints invites')
})

test('invites: a pending join is listed, survives a restart, and a cancel ends it for good', async (t) => {
  const joiner = await ceroOpen(t)
  const invite = nowhere()
  const err = await joiner.me._join(invite, 'team', { timeout: 500 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT')
  t.alike(await joiner.me.joining(), [invite])
  await joiner.me.close()

  const again = await reopen(t, joiner.dir, joiner.testnet)
  t.alike(await again.joining(), [invite], 'still pending after the restart')
  t.ok(await again.cancel(invite))
  t.alike(await again.joining(), [])
  t.absent(await again.cancel(invite), 'nothing left to cancel')
  await again.close()

  const last = await reopen(t, joiner.dir, joiner.testnet)
  t.alike(await last.joining(), [], 'not resumed')
  t.is(last._joining.size, 0)
})

test('invites: a join row left behind for a handle already open is dropped at boot', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic' })
  const invite = await room.invite()
  const joiner = await ceroOpen(t, { testnet })
  await open(joiner.me.team, invite)

  // stopped between opening the handle and forgetting the join
  const id = b4a.toHex(Invite.parse(invite).discoveryKey)
  const { publicKey, secretKey } = Identity.randomKeyPair()
  await joiner.me.local.store.put('joins', { id, type: 'team', invite, publicKey, secretKey })
  await joiner.me.close()

  const again = await reopen(t, joiner.dir, testnet)
  t.alike(await again.joining(), [])
  t.is(again._joining.size, 0, 'no knock')
})

test('invites: a caller waiting on a cancelled join hears CLOSED', async (t) => {
  const { me } = await ceroOpen(t)
  const invite = nowhere()
  const waiting = me._join(invite, 'team', { timeout: 0 }).catch((e) => e)
  await waitUntil(async () => ((await me.joining()).length ? true : null))
  await me.cancel(invite)
  t.is((await waiting).code, 'CLOSED')
})

test('invites: a pending join ends when its invite expires, and says so', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  const invite = nowhere({ ttl: 1500 })
  const err = await me._join(invite, 'team', { timeout: 200 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT', 'the caller stops waiting first')
  await waitUntil(() => errors.length || null)
  t.is(errors[0].code, 'EXPIRED', 'nobody waits, so onerror hears it')
  t.alike(await me.joining(), [])
})

test('invites: a denial reaches the caller, or onerror once nobody waits', async (t) => {
  const testnet = await makeTestnet(t)
  const owner = await ceroOpen(t, { testnet })
  const room = await open(owner.me.team, { name: 'clinic', accept: false })
  const candidates = []
  room.pair.on('candidate', (candidate) => candidates.push(candidate))

  const errors = []
  const onerror = (err) => errors.push(err)
  const waited = await ceroOpen(t, { testnet, onerror })
  const joining = waited.me._join(await room.invite(), 'team', { timeout: 0 }).catch((e) => e)
  await waitUntil(() => candidates.length || null)
  await candidates[0].deny('not now')
  t.is((await joining).code, 'DENIED', 'the caller hears it')
  t.is(errors.length, 0, 'and onerror does not')

  // the joiner knocks and leaves; the denial waits in the member's outbox for its return
  const away = await ceroOpen(t, { testnet })
  await away.me._join(await room.invite(), 'team', { timeout: 1000 }).catch((e) => e)
  await waitUntil(() => candidates.length === 2 || null)
  await away.me.close()
  await candidates[1].deny('not now')

  const back = await reopen(t, away.dir, testnet, { onerror })
  await waitUntil(() => errors.length || null)
  t.is(errors[0].code, 'DENIED', 'a resumed join reports to onerror')
  t.alike(await back.joining(), [])
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
      phrase: 'not actually a valid bip39 mnemonic'
    }),
    'invalid phrase rejected'
  )
  // a retry on the same dir must not hit a corestore lock leaked by the failure
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.ok(me.id, 'retry opened cleanly — storage was not left locked')
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

test('peek(): false on fresh dir', async (t) => {
  const dir = await t.tmp()
  t.is(await peek(dir, spec), false)
})

test('peek(): true after cero() seeds master', async (t) => {
  const { me, dir } = await ceroOpen(t)
  await me.close()
  t.is(await peek(dir, spec), true)
})

test('peek(): true after reopening with the stored phrase', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const first = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  const phrase = first.identity.toPhrase()
  await first.close()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, phrase })
  await me.close()
  t.is(await peek(dir, spec), true)
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
  return { testnet, a, phrase: a.identity.toPhrase() }
}

test('restore(): rejects bad input', async (t) => {
  const { testnet } = await withPeer(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })

  await t.exception.all(() => restore(null, 'x'), /me/)
  await t.exception.all(() => restore(me, null), /phrase/)
  await t.exception.all(() => restore(me, 123), /phrase/)
})

test('restore(): swaps identity to the given phrase', async (t) => {
  const { testnet, a, phrase } = await withPeer(t)

  let b = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  const oldId = b.id
  b = await restore(b, phrase)
  t.teardown(() => b.close().catch(() => {}), { order: 5 })

  t.not(b.id, oldId, 'identity changed')
  t.is(b.id, a.id, 'matches the peer with the same phrase')
  t.is(b.identity.toPhrase(), phrase, 'phrase round-trips')
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
  const phrase = a.identity.toPhrase()
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
  await a.close()
  t.absent(await diskContains(`${dir}/main`, seed), 'seed unreadable on disk with storageKey')

  const b = await cero(dir, spec, { bootstrap: testnet.bootstrap, storageKey: key })
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  t.is(b.id, id, 'same identity reopens with the key')
})

// a closed child's blob core keys must leave the root registry, or the file
// server keeps serving them for the root's whole life
test('closing a child prunes its blob core keys from the root', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'blobby' })

  const { data: file } = await put(room.files, { data: b4a.from('x'), type: 'text/plain' })
  await get(room.files, file.id)
  const hex = b4a.toString(decodeId(file.id).coreKey, 'hex')
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
  const phrase = a.identity.toPhrase()
  t.teardown(() => a.close().catch(() => {}), { order: 5 })

  const b = await cero(await t.tmp(), spec, {
    bootstrap: testnet.bootstrap,
    channel: 'channel-two',
    recoveryTimeout: 2000
  })

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
  t.is(me.identity.toPhrase(), phrase, 'phrase preserved')
})

test('restore(): peek reflects the new identity', async (t) => {
  const { testnet, phrase } = await withPeer(t)
  const dir = await t.tmp()

  let me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  me = await restore(me, phrase)
  await me.close()

  t.is(await peek(dir, spec), true, 'peek sees new identity')
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

test('cero(): from seed', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const first = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  const seed = first.identity.seed
  await first.close()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, seed })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.alike(b4a.toBuffer(me.identity.seed), b4a.toBuffer(seed))
})

test('cero(): from phrase', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const first = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  const phrase = first.identity.toPhrase()
  await first.close()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, phrase })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  t.is(me.identity.toPhrase(), phrase)
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

test('cero(): data persists across reopen with same dir + seed', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()

  const me1 = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  const seed = me1.identity.seed
  await put(me1.messages, { text: 'persist me' })
  await set(me1.profile, { name: 'jb' })
  await put(me1.local.drafts, { text: 'draft-1' })
  await me1.close()

  const me2 = await cero(dir, spec, { bootstrap: testnet.bootstrap, seed })
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
  const seed = a.me.identity.seed
  const room = await a.me._create('team', { name: 'general' })
  await put(room.messages, { text: 'from-a' })

  const b = await ceroOpen(t, { testnet, seed, name: 'laptop-B' })
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
  const invite = await room.invite()
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
  const seed = a.me.identity.seed
  await set(a.me.profile, { name: 'alice' })

  // Device B has only the seed (no key handed over). Recovery should
  // discover device A via the identity topic and replicate its data.
  const b = await ceroOpen(t, { testnet, seed, name: 'laptop-B' })

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

test('cero(): a second device auto-claims', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet })
  const seed = a.me.identity.seed
  await a.me.store.call('add-member', {
    id: a.me.id,
    key: a.me.identity.publicKey,
    role: 'owner',
    name: 'a',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  await put(a.me.messages, { text: 'from-a' })

  const b = await ceroOpen(t, { testnet, seed, key: a.me.store.key })

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
  const seed = a.me.identity.seed

  // Publish a member entry so device B can claim against it.
  await a.me.store.call('add-member', {
    id: a.me.id,
    key: a.me.identity.publicKey,
    role: 'owner',
    name: 'a',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  await put(a.me.messages, { text: 'from-a' })

  // Device B opens with the same seed: its own device core, admitted by the
  // identity's signature over the history it pulled from A.
  const b = await ceroOpen(t, { testnet, seed, key: a.me.store.key })

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
  team.pair.on('candidate', async (cand) => {
    try {
      await team.accept(cand, { role: 'member' })
    } catch (e) {
      t.fail('candidate accept failed: ' + e.message)
    }
  })
  await put(team.messages, { text: 'from-host' })

  const inviteStr = await team.invite({ role: 'member', ttl: 60_000 })

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
  const phrase = a.identity.toPhrase()

  // a new device with nothing but the phrase: its own writer core, the
  // history pulled from A, admitted by the identity's signature
  const b = await cero(await t.tmp(), spec, {
    bootstrap: testnet.bootstrap,
    phrase,
    name: 'laptop-B'
  })
  t.teardown(() => b.close().catch(() => {}), { order: 5 })

  t.is(b.id, a.id, 'same identity')
  t.is(b.store.key.toString('hex'), a.store.key.toString('hex'), 'same root database')
  t.not(b.store.writerKey.toString('hex'), a.store.writerKey.toString('hex'), 'its own writer core')
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
  t.absent(me.suspended, 'starts not suspended')
  t.absent(me.network.swarm.suspended)
  t.absent(me.store.opened === false && me.store.suspended)

  await me.suspend()
  t.ok(me.suspended, 'composer reports suspended')
  t.ok(me.network.swarm.suspended, 'swarm suspended')

  await me.resume()
  t.absent(me.suspended)
  t.absent(me.network.swarm.suspended)
})

test('suspend: a failing step is reported to onerror, the rest still suspends', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  me.network.suspend = async () => {
    throw new Error('radio')
  }
  await me.suspend()
  t.is(errors[0]?.message, 'radio', 'the failure is reported')
  t.ok(me.suspended, 'suspend still completes')
  await me.resume()
  t.absent(me.suspended)
})

test('onerror: without a handler background errors emit "error" on the root', async (t) => {
  const { me } = await ceroOpen(t)
  const seen = new Promise((resolve) => me.once('error', resolve))
  me.network.suspend = async () => {
    throw new Error('radio')
  }
  await me.suspend()
  t.is((await seen).message, 'radio')
  await me.resume()
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

test('onerror: with neither a handler nor a listener background errors are printed', async (t) => {
  const { me } = await ceroOpen(t)
  const printed = []
  const error = console.error
  console.error = (err) => printed.push(err)
  t.teardown(() => (console.error = error))
  me.network.suspend = async () => {
    throw new Error('radio')
  }
  await me.suspend()
  t.is(printed[0]?.message, 'radio')
  await me.resume()
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

  await me.suspend()
  const resuming = me.resume()
  const suspending = me.suspend() // fired while resume is still in flight
  await Promise.all([resuming, suspending])

  t.ok(me.suspended, 'handle reports suspended')
  t.is(calls[calls.length - 1], 'suspend', 'network ops ran in call order')
  t.ok(me.network.swarm.suspended, 'swarm actually ended suspended')
})

test('cero(): a blob core resolving after close does not re-register its key', async (t) => {
  const { Blobs } = await import('@cero-base/core/blobs')
  const { me } = await ceroOpen(t)
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
    me._coreKeys.has(b4a.toString(blobs.key, 'hex')),
    "a late blob open must not resurrect the closed handle's key on the root"
  )
})

test('cero(): suspend()/resume() is idempotent', async (t) => {
  const { me } = await ceroOpen(t)
  await me.suspend()
  await me.suspend() // no-op
  t.ok(me.suspended)
  await me.resume()
  await me.resume() // no-op
  t.absent(me.suspended)
})

test('cero(): writes work after suspend()+resume() cycle', async (t) => {
  const { me } = await ceroOpen(t)
  const team = await open(me.team)
  await put(team.messages, { text: 'before' })

  await me.suspend()
  await me.resume()

  await put(team.messages, { text: 'after' })
  const { data: rows } = await get(team.messages)
  t.alike(rows.map((r) => r.text).sort(), ['after', 'before'])
})

test('cero(): close() works after suspend without resume', async (t) => {
  const dir = await t.tmp()
  const testnet = await makeTestnet(t)
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  await me.suspend()
  await me.close()
  t.pass('close after suspend did not throw')
})

// ─── operators ──────────────────────────────────────────────────────────────

test('operators: a map binds root operators on cero()', async (t) => {
  const operators = { user: { rename: (h, name) => set(h.profile, { name }) } }
  const { me } = await ceroOpen(t, { operators })
  await me.user.rename('Auto')
  t.is((await get(me.profile)).data.name, 'Auto')
})

test('operators: a handle-type key binds on open(), not on the root', async (t) => {
  const operators = { team: { note: { add: (h, text) => put(h.notes, { text }) } } }
  const { me } = await ceroOpen(t, { operators })
  t.absent(me.note, 'child-scope op is not on the root')
  const team = await open(me.team, { name: 'squad' })
  await team.note.add('hello')
  t.is((await get(team.notes)).data[0].text, 'hello')
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
