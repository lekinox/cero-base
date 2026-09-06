import test from 'brittle'
import process from 'process'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'

import { Identity } from '@cero-base/core/identity'
import { decodeId } from '@cero-base/core/blobs/codec'

import { cero, put, set, get, open, peek, restore, define } from '../src/index.js'
import { _clearDefined } from '../src/lib/operators.js'
import { spec } from './fixtures/spec/index.js'
import { makeTestnet, waitForConnection, waitUntil } from './helpers/index.js'

test.configure({ timeout: 90000 })

async function ceroOpen(t, opts = {}) {
  const testnet = opts.testnet || (await makeTestnet(t))
  const dir = await t.tmp()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, ...opts })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return { me, dir, testnet }
}

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
    /TIMED_OUT/,
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

  const inviteStr = await team.invite({ role: 'member', expiresIn: 60_000 })

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

test('cero(): suspend() suspends child handle pairing', async (t) => {
  const { me } = await ceroOpen(t)
  const team = await open(me.team)
  t.absent(team.pair.suspended, 'child pair starts active')
  await me.suspend()
  t.ok(team.pair.suspended, 'child pair suspended via composer')
  await me.resume()
  t.absent(team.pair.suspended, 'child pair resumed via composer')
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

// ─── custom operators (define) ──────────────────────────────────────────────

test('define: cero() auto-binds root operators', async (t) => {
  define({ user: { rename: (h, name) => set(h.profile, { name }) } })
  t.teardown(_clearDefined)
  const { me } = await ceroOpen(t)
  await me.user.rename('Auto')
  t.is((await get(me.profile)).data.name, 'Auto')
})

test('define: open() auto-binds child operators (not on the root)', async (t) => {
  define({ team: { note: { add: (h, text) => put(h.notes, { text }) } } })
  t.teardown(_clearDefined)
  const { me } = await ceroOpen(t)
  t.absent(me.note, 'child-scope op is not on the root')
  const team = await open(me.team, { name: 'squad' })
  await team.note.add('hello')
  t.is((await get(team.notes)).data[0].text, 'hello')
})
