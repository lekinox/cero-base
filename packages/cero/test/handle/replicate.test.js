import test from 'brittle'
import b4a from 'b4a'
import { Duplex } from 'streamx'

import { encodeId, decodeId } from '@cero-base/core/blobs'

import { cero, put, get, del, watch, open } from '../../src/index.js'
import { spec } from '../fixtures/spec/index.js'
import { makeTestnet, waitForConnection, waitUntil, observe, fetch } from '../helpers/index.js'

test.configure({ timeout: 90000 })

async function ceroOpen(t, opts = {}) {
  const testnet = opts.testnet || (await makeTestnet(t))
  const dir = await t.tmp()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, ...opts })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return { me, dir, testnet }
}

async function publishMember(me) {
  await me.store.call('add-member', {
    id: me.id,
    key: me.identity.publicKey,
    role: 'owner',
    name: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
}

// ─── del replicates ───────────────────────────────────────────────────────

test('replicate: del propagates A → B', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet })
  const seed = a.me.identity.seed
  await publishMember(a.me)
  const { data: row } = await put(a.me.messages, { text: 'gonna die' })

  const b = await ceroOpen(t, { testnet, seed, key: a.me.store.key })

  await waitUntil(async () => {
    const { data } = await get(b.me.messages, row.id)
    return data || null
  })

  await del(a.me.messages, row.id)

  await waitUntil(async () => {
    const { data } = await get(b.me.messages, row.id)
    return data === null ? true : null
  })

  const { data: list } = await get(b.me.messages)
  t.is(list.length, 0, 'tombstone propagated to B')
})

// ─── watch fires on remote writes ─────────────────────────────────────────

test('replicate: watch on B fires when A writes', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet })
  const seed = a.me.identity.seed
  await publishMember(a.me)

  const b = await ceroOpen(t, { testnet, seed, key: a.me.store.key })
  await waitForConnection(a.me.network)
  await waitForConnection(b.me.network)

  await waitUntil(async () => {
    const m = await b.me.store.view.get('@cero/members', { id: a.me.id })
    return m || null
  })

  const stream = watch(b.me.messages)
  const observed = observe(t, stream, [
    (snap) => t.alike(snap.data, [], 'initial snapshot is empty'),
    (snap) => t.is(snap.data[0]?.text, 'remote write', 'watch fires when peer writes')
  ])

  await put(a.me.messages, { text: 'remote write' })
  await observed
  stream.destroy()
})

// ─── three-peer public scope ──────────────────────────────────────────────

test('replicate: three-peer public scope converges (A invites B + C)', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet })
  const team = await open(a.me.team)
  team.pair.on('candidate', async (cand) => {
    try {
      await team.accept(cand, { role: 'member' })
    } catch (e) {
      t.fail('candidate accept failed: ' + e.message)
    }
  })
  await put(team.messages, { text: 'from-a' })

  const inviteB = await team.invite({ role: 'member' })
  const b = await ceroOpen(t, { testnet })
  const teamB = await open(b.me.team, inviteB)

  const inviteC = await team.invite({ role: 'member' })
  const c = await ceroOpen(t, { testnet })
  const teamC = await open(c.me.team, inviteC)

  await waitForConnection(a.me.network)
  await waitForConnection(b.me.network)
  await waitForConnection(c.me.network)
  await waitUntil(() => teamB.store.writable)
  await waitUntil(() => teamC.store.writable)

  await put(teamB.messages, { text: 'from-b' })
  await put(teamC.messages, { text: 'from-c' })

  for (const room of [team, teamB, teamC]) {
    await waitUntil(async () => {
      const { data } = await get(room.messages)
      return data.length >= 3 ? true : null
    })
  }

  for (const room of [team, teamB, teamC]) {
    const { data } = await get(room.messages)
    t.alike(data.map((r) => r.text).sort(), ['from-a', 'from-b', 'from-c'])
  }
})

// ─── idempotent re-join ─────────────────────────────────────────────────────

test('replicate: re-joining a room you are in is idempotent', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet })
  const team = await open(a.me.team)
  team.pair.on('candidate', async (cand) => {
    try {
      await team.accept(cand, { role: 'member' })
    } catch (e) {
      if (!e.message.includes('already') && !e.message.includes('duplicate')) {
        t.fail('candidate accept failed: ' + e.message)
      }
    }
  })

  const inviteB = await team.invite({ role: 'member' })
  const b = await ceroOpen(t, { testnet })
  const teamB = await open(b.me.team, inviteB)
  await waitForConnection(a.me.network)
  await waitForConnection(b.me.network)
  await waitUntil(() => teamB.store.writable)

  // join again with a fresh invite for the same room
  const inviteB2 = await team.invite({ role: 'member' })
  const teamB2 = await open(b.me.team, inviteB2)

  t.is(teamB2.id, teamB.id, 'returns the existing room handle')
  t.is((await get(b.me.team)).data.length, 1, 'no duplicate handle for the joiner')

  await waitUntil(async () => {
    const { data } = await get(team.members)
    return data.some((m) => m.id === b.me.id) ? true : null
  })
  const { data: members } = await get(team.members)
  t.is(members.filter((m) => m.id === b.me.id).length, 1, 'member added once, not duplicated')
})

// ─── pre-join writes visible after admission ──────────────────────────────

test('replicate: pre-join writes are visible to joiner after admission', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet })
  const team = await open(a.me.team)
  team.pair.on('candidate', async (cand) => {
    try {
      await team.accept(cand, { role: 'member' })
    } catch (e) {
      t.fail('candidate accept failed: ' + e.message)
    }
  })

  for (let i = 0; i < 5; i++) await put(team.messages, { text: `msg-${i}` })

  const invite = await team.invite({ role: 'member' })
  const b = await ceroOpen(t, { testnet })
  const teamB = await open(b.me.team, invite)

  await waitForConnection(a.me.network)
  await waitForConnection(b.me.network)
  await waitUntil(() => teamB.store.writable)

  await waitUntil(async () => {
    const { data } = await get(teamB.messages)
    return data.length >= 5 ? true : null
  })

  const { data } = await get(teamB.messages)
  t.is(data.length, 5)
  t.alike(data.map((r) => r.text).sort(), ['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4'])
})

// ─── files replicate to members, not to strangers ─────────────────────────

test('replicate: a member resolves + fetches a file; a non-member core 404s', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await ceroOpen(t, { testnet })
  const seed = a.me.identity.seed
  await publishMember(a.me)

  await a.me.blobs.ready()
  const data = b4a.from('replicated-bytes')
  const blobId = await a.me.blobs.put(data)
  const id = encodeId(a.me.blobs.key, blobId, 'text/plain')
  await a.me.store.call('add-file', { id, name: 'r.txt' })

  const b = await ceroOpen(t, { testnet, seed, key: a.me.store.key })

  await waitUntil(async () => {
    const { data: row } = await get(b.me.files, id)
    return row || null
  })

  await b.me.blobs.ready()
  const url = b.me.fileServer.getLink(id)

  await waitUntil(async () => {
    const res = await fetch(url)
    if (res.status !== 200) return null
    const body = b4a.from(await res.arrayBuffer())
    return b4a.equals(b4a.toBuffer(body), b4a.toBuffer(data)) ? true : null
  })
  t.pass('member B fetched the replicated file byte-perfect')

  const { coreKey } = decodeId(id)
  const unknownKey = b4a.alloc(coreKey.byteLength, 7)
  const strangerId = encodeId(unknownKey, blobId, 'text/plain')
  const res404 = await fetch(b.me.fileServer.getLink(strangerId))
  t.is(res404.status, 404, 'unknown core is not served')
})

// ─── offline join: pairing + replication over an injected connection ────────
// (bluetooth design P1 — the DHTs are disjoint, only the pipe connects A and B)

function duplexPair() {
  let a, b
  a = new Duplex({
    write(data, cb) {
      b.push(data)
      cb(null)
    }
  })
  b = new Duplex({
    write(data, cb) {
      a.push(data)
      cb(null)
    }
  })
  return [a, b]
}

test('offline: invite → join → replicate purely over an injected connection', async (t) => {
  // each instance gets its OWN testnet — no shared DHT exists anywhere
  const a = await ceroOpen(t)
  const b = await ceroOpen(t)

  const [s1, s2] = duplexPair()
  a.me.network.inject(s1, { isInitiator: true })
  b.me.network.inject(s2, { isInitiator: false })

  const team = await open(a.me.team, { name: 'field-expo' })
  await put(team.messages, { text: 'registered-before-join' })
  const invite = await team.invite({ role: 'member' })

  const teamB = await open(b.me.team, invite)
  t.ok(teamB.id, 'late volunteer joined with zero internet')

  const seen = await waitUntil(async () => {
    const { data } = await get(teamB.messages)
    return data.find((m) => m.text === 'registered-before-join') ?? null
  })
  t.ok(seen, 'pre-join data replicated over the injected link')

  await waitUntil(() => teamB.store.writable)
  await put(teamB.messages, { text: 'from-late-volunteer' })
  const back = await waitUntil(async () => {
    const { data } = await get(team.messages)
    return data.find((m) => m.text === 'from-late-volunteer') ?? null
  })
  t.ok(back, 'the new member writes and it converges back — writer grant carried offline')
})
