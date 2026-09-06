import test from 'brittle'
import { Duplex } from 'streamx'
import createTestnet from '@hyperswarm/testnet'

import { cero, put, set, get, watch, open } from '@cero-base/cero'
import { serve } from '../server.js'
import { connect, restore } from '../client.js'
import { spec } from '../index.js'

function streamPair() {
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

async function makeTestnet(t) {
  const net = await createTestnet(3)
  t.teardown(() => net.destroy(), { order: 100 })
  return net
}

async function makeChat(t, opts = {}) {
  const me = await cero(await t.tmp(), spec, opts)
  t.teardown(() => me.close(), { order: 1 })
  return me
}

test('open room + put message + read back', async (t) => {
  const me = await makeChat(t)
  await set(me.profile, { name: 'alice' })

  const room = await open(me.room, { name: 'general' })
  await put(room.messages, { text: 'hello' })

  const { data: rows } = await get(room.messages)
  t.is(rows.length, 1)
  t.is(rows[0].text, 'hello')
  t.is(rows[0].memberId, me.id)
})

test('host invites + joiner sees existing messages', async (t) => {
  const net = await makeTestnet(t)
  const host = await makeChat(t, { bootstrap: net.bootstrap })
  const guest = await makeChat(t, { bootstrap: net.bootstrap })

  const room = await open(host.room, { name: 'general' })
  await put(room.messages, { text: 'welcome' })

  const inv = await room.invite()
  const joined = await open(guest.room, { invite: inv })

  const stream = watch(joined.messages)
  let msgs = []
  while (msgs.length === 0) {
    const event = await new Promise((r) => stream.once('data', r))
    msgs = event.data
  }
  stream.destroy()

  t.is(msgs[0].text, 'welcome')
})

test('me exposes an identity id', async (t) => {
  const me = await makeChat(t, { name: 'laptop' })
  t.ok(me.id, 'id exposed')
  t.is(me.id, me.identity.id, 'me.id matches identity.id')
})

// ─── Server helper (serve()) ──────────────────────────────────────────────

test('cero() opens a chat backend over a tmp dir', async (t) => {
  const me = await makeChat(t)
  t.ok(me.id, 'cero returned a ready instance')
  await set(me.profile, { name: 'jb' })
  const { data } = await get(me.profile)
  t.is(data.name, 'jb')
})

test('serve() + connect(): client mirrors server identity over the wire', async (t) => {
  const [s, c] = streamPair()
  const server = await serve(s, { storage: await t.tmp() })
  t.teardown(() => server.close())

  const client = await connect(c)
  t.teardown(() => {
    try {
      s.destroy()
    } catch {}
    try {
      c.destroy()
    } catch {}
  })

  t.is(client.id, server.id, 'client.id matches server.id')
})

test('joiner sees the room name in their handles list', async (t) => {
  const net = await makeTestnet(t)
  const host = await makeChat(t, { bootstrap: net.bootstrap })
  const guest = await makeChat(t, { bootstrap: net.bootstrap })
  await open(host.room, { name: 'general' })
  const invite = await (await open(host.room, { name: 'general-2' })).invite()
  await open(guest.room, { invite })
  // handleSync mirrors the name asynchronously (replication → watch), so wait for it.
  let rooms = []
  const start = Date.now()
  while (Date.now() - start < 10000) {
    rooms = (await get(guest.room)).data
    if (rooms[0]?.name === 'general-2') break
    await new Promise((r) => setTimeout(r, 50))
  }
  t.is(rooms.length, 1)
  t.is(rooms[0].name, 'general-2', 'guest sees host-given room name')
})

test('member.name in a room mirrors identity profile.name', async (t) => {
  const net = await makeTestnet(t)
  const host = await makeChat(t, { bootstrap: net.bootstrap })
  await set(host.profile, { name: 'Alice' })

  const guest = await makeChat(t, { bootstrap: net.bootstrap })
  await set(guest.profile, { name: 'Bob' })

  const room = await open(host.room, { name: 'general' })
  const invite = await room.invite()
  await open(guest.room, { invite })

  // Both members eventually show their respective profile names in the room.
  const start = Date.now()
  let members = []
  while (Date.now() - start < 10000) {
    const { data } = await get(room.members)
    members = data
    if (members.length >= 2 && members.every((m) => m.name)) break
    await new Promise((r) => setTimeout(r, 50))
  }
  const byId = Object.fromEntries(members.map((m) => [m.id, m.name]))
  t.is(byId[host.id], 'Alice')
  t.is(byId[guest.id], 'Bob')
})

test('member.name re-syncs when identity profile.name changes', async (t) => {
  const net = await makeTestnet(t)
  const host = await makeChat(t, { bootstrap: net.bootstrap })
  await set(host.profile, { name: 'OldName' })
  const room = await open(host.room, { name: 'general' })

  await set(host.profile, { name: 'NewName' })

  const start = Date.now()
  let m = null
  while (Date.now() - start < 10000) {
    const r = await get(room.members, host.id)
    m = r.data
    if (m?.name === 'NewName') break
    await new Promise((r) => setTimeout(r, 50))
  }
  t.is(m?.name, 'NewName', 'member.name updated after profile change')
})

test('guest messages are attributed to guest identity, not host', async (t) => {
  const net = await makeTestnet(t)
  const host = await makeChat(t, { bootstrap: net.bootstrap })
  const guest = await makeChat(t, { bootstrap: net.bootstrap })

  const room = await open(host.room, { name: 'general' })
  const invite = await room.invite()
  const joined = await open(guest.room, { invite })

  await put(joined.messages, { text: 'hi from guest' })

  const stream = watch(room.messages)
  let msgs = []
  while (msgs.length === 0) {
    const event = await new Promise((r) => stream.once('data', r))
    msgs = event.data
  }
  stream.destroy()
  t.is(msgs[0].text, 'hi from guest')
  t.is(msgs[0].memberId, guest.id, 'message attributed to guest, not host')
})

test('messages get a monotonic index and sort consistently across writers', async (t) => {
  const net = await makeTestnet(t)
  const host = await makeChat(t, { bootstrap: net.bootstrap })
  const guest = await makeChat(t, { bootstrap: net.bootstrap })

  const room = await open(host.room, { name: 'general' })
  const invite = await room.invite()
  const joined = await open(guest.room, { invite })

  await put(room.messages, { text: 'h1' })
  await put(joined.messages, { text: 'g1' })
  await put(room.messages, { text: 'h2' })
  await put(joined.messages, { text: 'g2' })

  const deadline = Date.now() + 15000
  let hostMsgs = []
  let guestMsgs = []
  while (Date.now() < deadline) {
    hostMsgs = (await get(room.messages)).data ?? []
    guestMsgs = (await get(joined.messages)).data ?? []
    if (hostMsgs.length === 4 && guestMsgs.length === 4) break
    await new Promise((r) => setTimeout(r, 100))
  }
  t.is(hostMsgs.length, 4, 'host sees all 4 messages')
  t.is(guestMsgs.length, 4, 'guest sees all 4 messages')

  for (const list of [hostMsgs, guestMsgs]) {
    for (const m of list)
      t.ok(typeof m.index === 'number' && m.index > 0, 'each message has a positive index')
    const indexes = list.map((m) => m.index)
    const unique = new Set(indexes)
    t.is(unique.size, indexes.length, 'indexes are unique within a writer')
  }

  const byIndex = (a, b) => a.index - b.index
  const hostSorted = [...hostMsgs].sort(byIndex).map((m) => m.text)
  const guestSorted = [...guestMsgs].sort(byIndex).map((m) => m.text)
  t.alike(hostSorted, guestSorted, 'both writers agree on the index order of messages')
})

test('two separate ceros: host with multiple handles, guest joins specific room', async (t) => {
  const net = await makeTestnet(t)
  // Host with TWO existing rooms — each has its own Pairing
  const hostMe = await makeChat(t, { bootstrap: net.bootstrap })
  const roomA = await open(hostMe.room, { name: 'roomA' })
  const roomB = await open(hostMe.room, { name: 'roomB' })

  const inviteB = await roomB.invite()

  // Guest joins roomB specifically — host has 3 pairings (root + roomA + roomB)
  // all listening on the same identity topic in current cero2 design.
  const guestMe = await makeChat(t, { bootstrap: net.bootstrap })
  const joined = await open(guestMe.room, inviteB)
  t.is(joined.id, roomB.id, 'joined into roomB (not roomA or root)')
})

test('serve() + connect(): full pairing flow with both sides over RPC', async (t) => {
  const net = await makeTestnet(t)

  const [hs, hc] = streamPair()
  const hostMe = await serve(hs, { storage: await t.tmp(), bootstrap: net.bootstrap })
  t.teardown(() => hostMe.close())
  const hostClient = await connect(hc)
  t.teardown(() => {
    try {
      hs.destroy()
    } catch {}
    try {
      hc.destroy()
    } catch {}
  })

  const [gs, gc] = streamPair()
  const guestMe = await serve(gs, { storage: await t.tmp(), bootstrap: net.bootstrap })
  t.teardown(() => guestMe.close())
  const guestClient = await connect(gc)
  t.teardown(() => {
    try {
      gs.destroy()
    } catch {}
    try {
      gc.destroy()
    } catch {}
  })

  // Host creates a room over RPC + invites
  const hostRoom = await open(hostClient.room, { name: 'general' })
  await put(hostRoom.messages, { text: 'welcome' })
  const invite = await hostRoom.invite()
  t.ok(invite, 'invite created via RPC')

  // Guest joins via RPC
  const guestRoom = await open(guestClient.room, invite)
  t.is(guestRoom.id, hostRoom.id, 'guest joined same room')

  // Guest sees host's existing messages
  const gStream = watch(guestRoom.messages)
  let gMsgs = []
  while (gMsgs.length === 0) {
    const event = await new Promise((r) => gStream.once('data', r))
    gMsgs = event.data
  }
  gStream.destroy()
  t.is(gMsgs[0].text, 'welcome', 'guest sees host message')

  // Guest writes, host should see it
  await put(guestRoom.messages, { text: 'thanks for the invite' })
  const hStream = watch(hostRoom.messages)
  let hMsgs = []
  const start = Date.now()
  while (hMsgs.length < 2 && Date.now() - start < 10000) {
    const event = await new Promise((r) => hStream.once('data', r))
    hMsgs = event.data
  }
  hStream.destroy()
  const texts = hMsgs.map((m) => m.text).sort()
  t.alike(texts, ['thanks for the invite', 'welcome'], 'host sees guest message')
})

test('serve() + connect(): joined room persists in handles list across reopen', async (t) => {
  const net = await makeTestnet(t)
  const storage = await t.tmp()

  const hostMe = await makeChat(t, { bootstrap: net.bootstrap })
  const hostRoom = await open(hostMe.room, { name: 'general' })
  const invite = await hostRoom.invite()

  // First boot: guest joins
  const guest1 = await cero(storage, spec, { bootstrap: net.bootstrap })
  await open(guest1.room, invite)
  await guest1.close()

  // Second boot: guest should still see the room in its handles list
  const guest2 = await cero(storage, spec, { bootstrap: net.bootstrap })
  t.teardown(() => guest2.close())
  const { data: rooms } = await get(guest2.room)
  t.is(rooms.length, 1, 'guest sees the room across reopen')
  t.is(rooms[0].id, hostRoom.id, 'same room id')
})

test('serve() + connect(): open(client.room, invite) joins via RPC', async (t) => {
  const net = await makeTestnet(t)
  const hostMe = await makeChat(t, { bootstrap: net.bootstrap })
  const room = await open(hostMe.room, { name: 'general' })
  await put(room.messages, { text: 'welcome' })
  const invite = await room.invite()

  const [s, c] = streamPair()
  const guestMe = await serve(s, { storage: await t.tmp(), bootstrap: net.bootstrap })
  t.teardown(() => guestMe.close())
  const guestClient = await connect(c)
  t.teardown(() => {
    try {
      s.destroy()
    } catch {}
    try {
      c.destroy()
    } catch {}
  })

  const joined = await open(guestClient.room, invite)
  t.is(typeof joined.id, 'string', 'joined room has id')
  const stream = watch(joined.messages)
  let msgs = []
  while (msgs.length === 0) {
    const event = await new Promise((r) => stream.once('data', r))
    msgs = event.data
  }
  stream.destroy()
  t.is(msgs[0]?.text, 'welcome')
})

test('serve() + connect(): SubHandle.invite() round-trips over the wire', async (t) => {
  const [s, c] = streamPair()
  const server = await serve(s, { storage: await t.tmp() })
  t.teardown(() => server.close())

  const client = await connect(c)
  t.teardown(() => {
    try {
      s.destroy()
    } catch {}
    try {
      c.destroy()
    } catch {}
  })

  const room = await open(client.room, { name: 'general' })
  t.is(typeof room.invite, 'function', 'invite is a function')
  const invite = await room.invite({ role: 'member' })
  t.is(typeof invite, 'string', 'invite is a non-empty string')
  t.ok(invite.length > 0)
})

test('serve() + connect(): room.revoke(invite) over RPC', async (t) => {
  const [s, c] = streamPair()
  const server = await serve(s, { storage: await t.tmp() })
  t.teardown(() => server.close())

  const client = await connect(c)
  t.teardown(() => {
    try {
      s.destroy()
    } catch {}
    try {
      c.destroy()
    } catch {}
  })

  const room = await open(client.room, { name: 'general' })
  t.is(typeof room.revoke, 'function', 'revoke is a function')
  const invite = await room.invite({ role: 'member' })
  t.is(await room.revoke(invite), true, 'first revoke returns true')
  t.is(await room.revoke(invite), false, 'second revoke returns false')
})

test('serve() + connect(): open(me.room, { id }) loads existing room over the wire', async (t) => {
  const [s, c] = streamPair()
  const server = await serve(s, { storage: await t.tmp() })
  t.teardown(() => server.close())

  const client = await connect(c)
  t.teardown(() => {
    try {
      s.destroy()
    } catch {}
    try {
      c.destroy()
    } catch {}
  })

  const created = await open(client.room, { name: 'general' })
  await put(created.messages, { text: 'hi' })

  const reopened = await open(client.room, { id: created.id })
  t.is(reopened.id, created.id, 'same id')
  const { data: msgs } = await get(reopened.messages)
  t.is(msgs[0]?.text, 'hi', 'messages visible from reopened handle')
})

// ─── restore over RPC ─────────────────────────────────────────────────────

test('restore() over RPC: swaps client identity to the given phrase', async (t) => {
  const net = await makeTestnet(t)

  // peer device A holds the identity; its phrase recovers it elsewhere
  const a = await cero(await t.tmp(), spec, { bootstrap: net.bootstrap })
  t.teardown(() => a.close())
  const phrase = a.identity.toPhrase()

  // device B: serve over RPC, fresh identity, then restore via the wire
  const [s, c] = streamPair()
  const server = await serve(s, { storage: await t.tmp(), bootstrap: net.bootstrap })
  t.teardown(() => server.close())
  const client = await connect(c)
  t.teardown(() => {
    try {
      s.destroy()
    } catch {}
    try {
      c.destroy()
    } catch {}
  })

  const before = client.id
  await restore(client, phrase)

  t.not(client.id, before, 'client identity changed')
  t.is(client.id, a.id, 'client matches peer with same phrase')
  t.is(server.id, client.id, 'server identity updated alongside client')
  t.is(await client.identity.toPhrase(), phrase, 'phrase round-trips')
})

test('restore() over RPC: client sees data from the peer after recovery', async (t) => {
  const net = await makeTestnet(t)

  const a = await cero(await t.tmp(), spec, { bootstrap: net.bootstrap })
  t.teardown(() => a.close())
  const phrase = a.identity.toPhrase()
  await set(a.profile, { name: 'jb' })

  const [s, c] = streamPair()
  const server = await serve(s, { storage: await t.tmp(), bootstrap: net.bootstrap })
  t.teardown(() => server.close())
  const client = await connect(c)
  t.teardown(() => {
    try {
      s.destroy()
    } catch {}
    try {
      c.destroy()
    } catch {}
  })

  await restore(client, phrase)

  // wait for profile to replicate, then read via RPC
  let profile = null
  for (let i = 0; i < 50 && !profile?.name; i++) {
    profile = (await get(client.profile)).data
    if (!profile?.name) await new Promise((r) => setTimeout(r, 100))
  }
  t.is(profile?.name, 'jb', 'profile replicated from peer over RPC')
})

test('restore() over RPC: rejects empty phrase', async (t) => {
  const [s, c] = streamPair()
  const server = await serve(s, { storage: await t.tmp() })
  t.teardown(() => server.close())
  const client = await connect(c)
  t.teardown(() => {
    try {
      s.destroy()
    } catch {}
    try {
      c.destroy()
    } catch {}
  })

  await t.exception.all(() => restore(client, ''), /phrase|REQUIRED|INVALID/)
})

// ─── Seed lifecycle ───────────────────────────────────────────────────────

test('seed: data persists across boots when the same phrase is supplied', async (t) => {
  const storage = await t.tmp()

  const first = await cero(storage, spec)
  const phrase = first.identity.toPhrase()
  await set(first.profile, { name: 'jb' })
  await first.close()

  const second = await cero(storage, spec, { phrase })
  t.teardown(() => second.close())

  t.is(second.id, first.id, 'same identity from same phrase + storage')
  const { data: profile } = await get(second.profile)
  t.is(profile.name, 'jb', 'profile read back from disk')
})

test('seed: recovery from a phrase yields that identity on a fresh dir', async (t) => {
  const net = await makeTestnet(t)

  const a = await cero(await t.tmp(), spec, { bootstrap: net.bootstrap })
  t.teardown(() => a.close())
  const phrase = a.identity.toPhrase()
  const b = await cero(await t.tmp(), spec, { bootstrap: net.bootstrap, phrase })
  t.teardown(() => b.close())

  t.is(a.id, b.id, 'same identity from same phrase across storages')
  t.is(b.identity.toPhrase(), phrase, 'phrase round-trips')
})

// ─── handle leave() — drops the room from the joiner's handles list ──────

test("handle leave() removes the room from the joiner's handles, others untouched", async (t) => {
  const net = await makeTestnet(t)
  const host = await makeChat(t, { bootstrap: net.bootstrap })
  const guest = await makeChat(t, { bootstrap: net.bootstrap })

  const stay = await open(host.room, { name: 'stay' })
  const leaveRoom = await open(host.room, { name: 'leaveme' })
  const stayInvite = await stay.invite()
  const leaveInvite = await leaveRoom.invite()

  const joinedStay = await open(guest.room, { invite: stayInvite })
  const joinedLeave = await open(guest.room, { invite: leaveInvite })

  let { data: rooms } = await get(guest.room)
  t.is(rooms.length, 2, 'guest has both rooms')

  await joinedLeave.leave()

  rooms = (await get(guest.room)).data
  t.is(rooms.length, 1, "leave() dropped one row from the guest's handles")
  t.is(rooms[0].id, joinedStay.id, 'the other room is still there')
})

test('handle close() detaches without removing the row (resume on next open)', async (t) => {
  const net = await makeTestnet(t)
  const host = await makeChat(t, { bootstrap: net.bootstrap })
  const guest = await makeChat(t, { bootstrap: net.bootstrap })

  const room = await open(host.room, { name: 'persistent' })
  const invite = await room.invite()
  const joined = await open(guest.room, { invite })
  const joinedId = joined.id

  await joined.close()

  const { data: rooms } = await get(guest.room)
  t.is(rooms.length, 1, 'close() does NOT remove the handle row')
  t.is(rooms[0].id, joinedId)

  // And the joiner can reopen the same room by id.
  const reopened = await open(guest.room, { id: joinedId })
  t.is(reopened.id, joinedId, 'reopen works after close')
})
