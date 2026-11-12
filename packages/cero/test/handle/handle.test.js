import test from 'brittle'
import b4a from 'b4a'
import c from 'compact-encoding'
import z32 from 'z32'

import { Identity } from '@cero-base/core/identity'
import { Invite } from '@cero-base/core/invite'
import { Database } from '@cero-base/core/database'
import { encodeId, decodeId } from '@cero-base/core/blobs/codec'

import { Handle, Ref } from '../../src/handle/index.js'
import { cero } from '../../src/index.js'
import { put, set, get, del, open, rotate, accept, watch, after } from '../../src/lib/operators.js'
import { Response, STATUS_ACCEPTED } from '../../../core/src/pairing/response.js'
import { spec } from '../fixtures/spec/index.js'
import {
  makeStore,
  makeTestnet,
  waitForConnection,
  waitUntil,
  nextRequest,
  fetch,
  openHandle,
  ceroOpen
} from '../helpers/index.js'

// ─── Phase 4: root getter, fileServer, blobs, files ops ─────────────────────

test.configure({ timeout: 90000 })

// ─── admission guards (B3.2) ──────────────────────────────────────────────

// a host's room, and people joining it, each with their own cero() as an app opens them
async function hosted(t, name) {
  const { me: host, testnet } = await ceroOpen(t)
  const room = await open(host.team, { name })
  const join = async (invite) => {
    const { me } = await ceroOpen(t, { testnet })
    const joined = await open(me.team, invite)
    // a joiner's device seats itself: the host has the member once that claim reached it
    await waitUntil(async () => (await get(room.members, me.identity.id)).data)
    return { me, room: joined }
  }
  return { host, room, join, testnet }
}

test('invite: a confirm invite waits for the app to accept', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await openHandle(t, { testnet })
  const room = await open(host.me.team, { name: 'gated' })
  const invite = await cero.invite(room, { role: 'reader', confirm: true })

  const peer = await openHandle(t, { testnet })
  const joining = open(peer.me.team, invite)
  const request = await nextRequest(room)
  t.alike(request.identity, peer.identity.publicKey, 'the room lists who is asking')
  t.is(request.role, 'reader', 'and the role they ask for, from the invite')
  t.absent((await get(room.members, peer.identity.id)).data, 'nobody admitted yet')
  await accept(room, request)
  const joined = await joining
  t.teardown(() => joined.close().catch(() => {}))
  // its device seats itself: the host has the member once that claim reached it
  const member = await waitUntil(async () => (await get(room.members, peer.identity.id)).data)
  t.is(member.role, 'reader')
})

test('invite: made-up keys a reader sends a confirm join are not kept, the accept still lets it in', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await openHandle(t, { testnet })
  const room = await open(host.me.team, { name: 'gated' })
  const reader = await openHandle(t, { testnet })
  const seen = await open(reader.me.team, await cero.invite(room, { role: 'reader' }))
  const invite = await cero.invite(room, { confirm: true })

  const peer = await openHandle(t, { testnet })
  const joining = open(peer.me.team, invite)
  // a reader sees where the reply goes
  const { reply } = await nextRequest(seen)
  const read = new Set()
  const put = peer.me.mailbox.inbox.put
  peer.me.mailbox.inbox.put = async (m) => {
    if (b4a.equals(m.address, reply)) read.add(m.id)
    return put(m)
  }
  const forged = {
    status: STATUS_ACCEPTED,
    reason: '',
    key: Invite.parse(invite).key,
    encryptionKey: Identity.randomBytes(32),
    epochs: []
  }
  await reader.me.mailbox.send(reply, c.encode(Response, forged))
  const rows = () => peer.me.mailbox.inbox.list()
  await waitUntil(
    async () => read.size && !(await rows()).some((m) => read.has(m.id) && !m.handled)
  )
  const { data: joins } = await peer.me.local.store.get('joins')
  t.absent(
    joins.find((row) => row.key),
    'the made-up keys are not kept'
  )

  await accept(room, await nextRequest(room))
  const joined = await joining
  t.teardown(() => joined.close().catch(() => {}))
  t.ok((await get(room.members, peer.identity.id)).data)
})

test('invite: refuses a role that is not a rank', async (t) => {
  const { me } = await openHandle(t)
  const room = await open(me.team, { name: 'capped' })
  await t.exception(cero.invite(room, { role: 'volunteer' }), /not a rank/i)
})

// ─── construction ─────────────────────────────────────────────────────────

test('Handle: rejects missing store', (t) => {
  t.exception.all(() => new Handle({ identity: {}, network: {}, spec }), /store is required/)
})

test('Handle: rejects missing identity', async (t) => {
  const { store } = await makeStore(t)
  t.exception.all(() => new Handle({ store, network: {}, spec }), /identity is required/)
})

test('Handle: rejects missing network', async (t) => {
  const { store } = await makeStore(t)
  t.exception.all(() => new Handle({ store, identity: {}, spec }), /network is required/)
})

test('Handle: rejects missing spec', async (t) => {
  const { store } = await makeStore(t)
  t.exception.all(() => new Handle({ store, identity: {}, network: {} }), /spec is required/)
})

test('Handle: a new room is written at its target, so its owner row keeps a field newer than the start', async (t) => {
  const team = spec.handles.team
  const { since } = team.meta
  const member = { ...since.types['@cero/member'], createdAt: 2 }
  const meta = {
    ...team.meta,
    version: 2,
    target: 2,
    since: { ...since, types: { ...since.types, '@cero/member': member } }
  }
  const handles = { ...spec.handles, team: { ...team, meta } }
  const { me, identity } = await openHandle(t, { spec: { ...spec, handles } })
  const room = await open(me.team, { name: 'dated' })
  t.ok((await get(room.members, identity.id)).data?.createdAt, 'the owner row has it')
})

test('Handle: a root rejects missing local', async (t) => {
  const { store } = await makeStore(t)
  t.exception.all(() => new Handle({ store, identity: {}, network: {}, spec }), /local is required/)
})

// ─── lifecycle ────────────────────────────────────────────────────────────

test('Handle: opens and closes', async (t) => {
  const { me } = await openHandle(t)
  t.is(me.opened, true)
  t.ok(me._pair, 'the root pairs too: its own devices')
  await me.close()
  t.is(me.closed, true)
})

// ─── ref attachment ───────────────────────────────────────────────────────

test('Handle: attaches user + builtin + handle-kind refs', async (t) => {
  const { me } = await openHandle(t)
  t.ok(me.profile instanceof Ref, 'user single')
  t.ok(me.messages instanceof Ref, 'user collection')
  t.ok(me.members instanceof Ref, 'builtin members')
  t.ok(me.devices instanceof Ref, 'builtin devices')
  t.ok(me.team instanceof Ref, 'handle-kind ref')
  t.is(me.team.kind, 'handle')
})

test('Handle: ref carries handle + name + kind', async (t) => {
  const { me } = await openHandle(t)
  t.is(me.messages.handle, me)
  t.is(me.messages.name, 'messages')
  t.is(me.messages.kind, 'collection')
})

// ─── bootstrap ────────────────────────────────────────────────────────────

test('Handle: bootstrap on fresh', async (t) => {
  const { me } = await openHandle(t, { name: 'desktop' })
  t.is(me.store.writable, true)
  t.is((await get(me.members)).data.length, 1, 'bootstrap enrolls the owner')
})

// ─── operators ────────────────────────────────────────────────────────────

test('Handle: put/get on a collection', async (t) => {
  const { me } = await openHandle(t)
  await me.store.bootstrap()
  const { data: row } = await put(me.messages, { text: 'hi' })
  t.ok(row.id)
  t.is(row.text, 'hi')
  const { data: list } = await get(me.messages)
  t.is(list.length, 1)
})

test('Handle: operators reject CLOSED after close', async (t) => {
  const { me } = await openHandle(t)
  await me.close()
  await t.exception.all(() => get(me.messages), /closed/i)
  await t.exception.all(() => put(me.messages, { text: 'x' }), /closed/i)
  let code
  try {
    await get(me.messages)
  } catch (e) {
    code = e.code
  }
  t.is(code, 'CLOSED', 'a closed-handle read throws CeroError code CLOSED')
})

test('Handle: set/get on a single', async (t) => {
  const { me } = await openHandle(t)
  await me.store.bootstrap()
  await set(me.profile, { name: 'jb' })
  const { data } = await get(me.profile)
  t.is(data.name, 'jb')
})

test('Handle: a named child names the room, not the creator device', async (t) => {
  const { me } = await openHandle(t)
  await me.store.bootstrap({ name: 'my-laptop' })
  const team = await open(me.team, { name: 'General' })
  t.teardown(() => team.close().catch(() => {}))

  t.is(team.name, 'General', 'the child handle carries the room name')

  const { data: devices } = await get(team.devices)
  t.is(devices.length, 1, 'just the creator device')
  t.absent(devices[0].name, 'creator device is NOT mislabeled with the room name')
})

test('Handle: t.extend adds a field to the member builtin', async (t) => {
  const { me } = await openHandle(t)
  await me.store.bootstrap()
  const avatar = b4a.from([7, 8, 9])
  await me.store.call('set-member', {
    id: me.id,
    key: me.store.writerKey,
    role: 'owner',
    name: 'JB',
    avatar,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const { data: members } = await get(me.members)
  const mine = members.find((m) => m.id === me.id)
  t.ok(mine, 'member present')
  t.alike(b4a.toBuffer(mine.avatar), b4a.toBuffer(avatar), 'extended avatar field persisted')
})

// ─── multi-device sync (same identity, claim) ─────────────────────────────

test('open: a reader opens the room by id on a second device', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await openHandle(t, { testnet })
  const room = await open(host.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))
  await put(room.messages, { text: 'hi' })
  const a = await openHandle(t, { testnet })
  const joined = await open(a.me.team, await cero.invite(room, { role: 'reader' }))
  t.teardown(() => joined.close().catch(() => {}))
  const b = await openHandle(t, { testnet, identity: a.identity, key: a.me.store.key })
  await b.me.store.bootstrap({ recovering: true })
  await waitUntil(async () => (await get(b.me.team)).data.length === 1)

  const reopened = await open(b.me.team, { id: joined.id })
  t.teardown(() => reopened.close().catch(() => {}))
  await waitUntil(async () => (await get(reopened.messages)).data.length === 1)
  t.absent(reopened.store.writable, 'a reader holds no seat')
  t.is(reopened.store.length, 0, 'and appends nothing')
})

test('open: an invited member opens the room by id on a second device and writes', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await openHandle(t, { testnet })
  const room = await open(host.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))
  const a = await openHandle(t, { testnet })
  const joined = await open(a.me.team, await cero.invite(room))
  t.teardown(() => joined.close().catch(() => {}))
  const b = await openHandle(t, { testnet, identity: a.identity, key: a.me.store.key })
  await b.me.store.bootstrap({ recovering: true })
  await waitUntil(async () => (await get(b.me.team)).data.length === 1)

  const reopened = await open(b.me.team, { id: joined.id })
  t.teardown(() => reopened.close().catch(() => {}))
  t.ok(reopened.store.writable, 'its claim seats the second device')
  await put(reopened.messages, { text: 'from the second device' })
  await waitUntil(async () => (await get(room.messages)).data.length === 1)
  t.pass('the host reads it')
})

test('open: a second device stopped once its claim landed reopens on that writer', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))
  const b = await openHandle(t, { testnet, identity: a.identity, key: a.me.store.key })
  await b.me.store.bootstrap({ recovering: true })
  await waitUntil(async () => (await get(b.me.team)).data.length === 1)

  // the device stops right after its claim reached the log
  let claimed = null
  const make = b.me._room
  b.me._room = (opts) => {
    const child = make.call(b.me, opts)
    const claim = child.store.claim.bind(child.store)
    child.store.claim = async () => {
      await claim()
      claimed = b4a.from(child.store.writerKey)
      throw new Error('stopped')
    }
    return child
  }
  await t.exception(open(b.me.team, { id: room.id }), /stopped/)
  b.me._room = make

  const reopened = await open(b.me.team, { id: room.id })
  t.teardown(() => reopened.close().catch(() => {}))
  t.alike(b4a.from(reopened.store.writerKey), claimed, 'the retry is the writer on the log')
})

test('Handle: second device claims and syncs', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.create()

  const a = await openHandle(t, { testnet, identity })
  await a.me.store.bootstrap({ name: 'a' })
  await put(a.me.messages, { text: 'from-a' })

  const b = await openHandle(t, { testnet, identity, key: a.me.store.key })

  await waitForConnection(a.net)
  await waitForConnection(b.net)

  await b.me.store.bootstrap({ recovering: true })
  t.ok(b.me.store.writable, 'b writable after recovery')

  await waitUntil(async () => {
    const m = await b.me.store.view.get('@cero/members', { id: identity.id })
    return m || null
  })

  await put(b.me.messages, { text: 'from-b' })
  await waitUntil(async () => {
    const { data: list } = await get(a.me.messages)
    return list.find((r) => r.text === 'from-b') ? true : null
  })
  const { data: onA } = await get(a.me.messages)
  t.alike(onA.map((r) => r.text).sort(), ['from-a', 'from-b'])
})

// ─── reader role (can read, cannot write) ────────────────────────────────

test('Handle: reader-role invite can read but cannot write', async (t) => {
  const { room, join } = await hosted(t, 'readers')
  await put(room.messages, { text: 'host-msg' })
  const { room: reader } = await join(await cero.invite(room, { role: 'reader' }))
  await waitUntil(async () => ((await get(reader.messages)).data.length > 0 ? true : null))
  const { data: list } = await get(reader.messages)
  t.is(list[0].text, 'host-msg', 'reader can read host messages')
  await t.exception.all(() => put(reader.messages, { text: 'should fail' }), /not writable/i)
})

test('Handle: a removal rotates the room key, the removed member reads nothing new, late joiners read all', async (t) => {
  const { room, join } = await hosted(t, 'rotation')
  const joinRoom = async () => {
    const { me, room: h } = await join(await cero.invite(room))
    return { h, me }
  }

  await put(room.messages, { text: 'before' })
  const stays = await joinRoom()
  const leaves = await joinRoom()
  const sees = (h, text) =>
    waitUntil(async () => {
      const { data } = await get(h.messages)
      return data.some((r) => r.text === text) ? true : null
    })
  await sees(stays.h, 'before')
  await sees(leaves.h, 'before')

  await del(room.members, leaves.me.id)
  await waitUntil(async () => (await get(room.status)).data.epoch === 1 || null)
  t.pass('the removal opened epoch 1 by itself')

  await put(room.messages, { text: 'after' })
  await sees(stays.h, 'after')
  t.is(stays.h.store.keyring.seq, 1, 'remaining member picked up the epoch')
  const { data: leavesSees } = await get(leaves.h.messages)
  t.alike(
    leavesSees.map((r) => r.text),
    ['before'],
    'removed member never reads post-rotation data'
  )
  t.is(leaves.h.store.keyring.seq, 0, 'removed member has no envelope')

  const late = await joinRoom()
  await sees(late.h, 'before')
  await sees(late.h, 'after')
  // the join itself may trigger a self-healing rotation, so epoch 1 is a lower bound
  t.ok(
    late.h.store.keyring.all().some((e) => e.epoch === 1),
    'join delivered the rotation epoch via confirm'
  )
})

test('Handle: files rotate with the room — cross-member reads, epoch cutoff, legacy passthrough', async (t) => {
  const { room, testnet } = await hosted(t, 'files-rotate')

  // the reader is a proper root + child room: its ROOT key differs from the
  // room key, which is exactly the shape where blob cores must resolve with
  // the room's key (registering them under the root key serves garbage)
  const m = await openHandle(t, { testnet })
  await m.me.store.bootstrap({ name: 'member-root' })
  const member = await open(m.me.team, await cero.invite(room))
  t.teardown(() => member.close().catch(() => {}))
  await waitForConnection(m.net)

  const legacyBytes = b4a.from('legacy-file-contents')
  const { data: legacy } = await put(room.files, { data: legacyBytes, type: 'text/plain' })

  // pre-rotation: another member reads a file it did not write, over HTTP —
  // the blob core must resolve with the ROOM key, not the root identity key
  const fetchAs = async (h, id) => {
    const { data: rows } = await get(h.files)
    const row = rows.find((r) => r.id === id)
    if (!row) return null
    const res = await fetch(row.url)
    if (!res.ok) return null
    return b4a.from(new Uint8Array(await res.arrayBuffer()))
  }
  await waitUntil(async () => (await fetchAs(member, legacy.id)) !== null)
  t.alike(await fetchAs(member, legacy.id), legacyBytes, 'cross-member read with the room key')

  const { epoch } = await rotate(room)
  t.is(epoch, 1)
  await waitUntil(async () => member.store.keyring.seq === 1)

  const rotatedBytes = b4a.from('post-rotation-file')
  const { data: rotated } = await put(room.files, { data: rotatedBytes, type: 'text/plain' })
  t.is(room.blobs.stamp, room.store.keyring.current, 'new files land in the epoch blob core')

  await waitUntil(async () => (await fetchAs(member, rotated.id)) !== null)
  t.alike(await fetchAs(member, rotated.id), rotatedBytes, 'member reads the epoch file via HTTP')
  t.alike(
    await fetchAs(member, legacy.id),
    legacyBytes,
    'legacy file still readable after rotation'
  )

  const { data: memberRows } = await get(member.files)
  const rotatedRow = memberRows.find((r) => r.id === rotated.id)
  t.is(rotatedRow.stamp, room.store.keyring.current, 'file row records its epoch stamp')
})

test('Handle: rotation works on nested child rooms — remove, late join, reopen by id', async (t) => {
  const testnet = await makeTestnet(t)

  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))

  const joinAsRoot = async () => {
    const peer = await openHandle(t, { testnet })
    await peer.me.store.bootstrap({ name: 'peer-root' })
    const child = await open(peer.me.team, await cero.invite(room))
    t.teardown(() => child.close().catch(() => {}))
    return { ...peer, room: child }
  }

  await put(room.messages, { text: 'before' })
  const b = await joinAsRoot()
  await waitForConnection(a.net)

  const sees = (h, text) =>
    waitUntil(async () => {
      const { data } = await get(h.messages)
      return data.some((r) => r.text === text) ? true : null
    })
  await sees(b.room, 'before')

  await del(room.members, b.identity.id)
  const { epoch } = await rotate(room)
  t.is(epoch, 2, 'nested child rotates through the operator, after the removal did')
  await put(room.messages, { text: 'after' })

  // late joiner through a nested child reads everything (confirm delivery)
  const c = await joinAsRoot()
  await sees(c.room, 'before')
  await sees(c.room, 'after')
  // a join after a rotation heals the envelopes, so the epoch may already be past 1
  t.ok(c.room.store.keyring.seq >= 1, 'nested late joiner received the epoch at join')

  const { data: bSees } = await get(b.room.messages)
  t.alike(
    bSees.map((r) => r.text),
    ['before'],
    'removed nested member frozen at the cut'
  )

  // reopen the rotated child by id via the parent's handles row: the row carries its epochs, and
  // local userData primes them too
  const roomId = room.id
  await room.close()
  const reopened = await open(a.me.team, { id: roomId })
  t.teardown(() => reopened.close().catch(() => {}))
  t.ok(reopened.store.keyring.seq >= 1, 'reopened child primed its keyring')
  const { data: reread } = await get(reopened.messages)
  t.alike(reread.map((r) => r.text).sort(), ['after', 'before'], 'reopened child reads every era')
})

test('rotation: a second device by phrase reads a room past its rotation, through the epochs its root carries', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  await put(room.messages, { text: 'pre' })
  await rotate(room)
  await put(room.messages, { text: 'post' })
  const texts = async (r) => (await get(r.messages)).data.map((m) => m.text).sort()

  // nothing in the room's log is sealed to this device: the epoch comes with the root's row
  const b = await ceroOpen(t, { testnet: a.testnet, phrase: a.me.identity.toPhrase() })
  await waitUntil(async () => ((await get(b.me.handles)).data.length === 1 ? true : null))
  const mine = await open(b.me.team, { id: room.id })
  t.teardown(() => mine.close().catch(() => {}))
  await waitUntil(async () => ((await texts(mine)).length === 2 ? true : null))
  t.alike(await texts(mine), ['post', 'pre'], 'reads the era sealed before it existed')

  // seated, the next rotation seals to it directly
  await waitUntil(async () => (mine.store.writable ? true : null))
  await rotate(room)
  await put(room.messages, { text: 'later' })
  await waitUntil(async () => ((await texts(mine)).includes('later') ? true : null))
  t.pass('and reads on from its own envelope')
})

// ─── nested rotation: healer, files, devices, watch ────────────────────────

async function nestedRoom(t, testnet) {
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'owner-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))
  const joinAsRoot = async () => {
    const peer = await openHandle(t, { testnet })
    await peer.me.store.bootstrap({ name: 'peer-root' })
    const child = await open(peer.me.team, await cero.invite(room))
    t.teardown(() => child.close().catch(() => {}))
    return { ...peer, room: child }
  }
  const sees = (h, text) =>
    waitUntil(async () => {
      const { data } = await get(h.messages)
      return data.some((r) => r.text === text) ? true : null
    })
  return { a, room, joinAsRoot, sees }
}

test('Handle: a removal rotates the key as it resolves, and the removed device does not read the next write', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, room, joinAsRoot, sees } = await nestedRoom(t, testnet)

  await put(room.messages, { text: 'pre' })
  const stays = await joinAsRoot()
  const removed = await joinAsRoot()
  await waitForConnection(a.net)
  await sees(stays.room, 'pre')
  await sees(removed.room, 'pre')

  await del(room.members, removed.identity.id)
  t.is((await get(room.status)).data.epoch, 1, 'the key is in place')
  await put(room.messages, { text: 'post' })

  await sees(stays.room, 'post')
  const key = room.store.keyring.current
  t.ok(stays.room.store.keyring.entropy(key), 'a member who stays holds it')
  t.absent(removed.room.store.keyring.entropy(key), 'the removed device does not')
  const { data } = await get(removed.room.messages)
  t.alike(
    data.map((r) => r.text),
    ['pre'],
    'and reads nothing written after'
  )
})

test('Handle: nested healer — soft delete in a rotated child auto-rotates', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, room, joinAsRoot, sees } = await nestedRoom(t, testnet)

  await put(room.messages, { text: 'pre' })
  const b = await joinAsRoot()
  await waitForConnection(a.net)
  await sees(b.room, 'pre')

  await rotate(room) // activates rotation policy on the child
  await waitUntil(() => (b.room.store.keyring.seq === 1 ? true : null))

  await del(room.members, b.identity.id) // soft delete only — no explicit rotate
  await waitUntil(() => (room.store.keyring.seq >= 2 ? true : null))
  t.pass('healer rotated the nested child on its own')

  await put(room.messages, { text: 'post' })
  await new Promise((r) => setTimeout(r, 1500))
  const { data: bSees } = await get(b.room.messages)
  t.absent(
    bSees.some((r) => r.text === 'post'),
    'softly-deleted nested member cannot read past the healed epoch'
  )
})

test('Handle: nested files rotate with the child room', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, room, joinAsRoot } = await nestedRoom(t, testnet)

  const b = await joinAsRoot()
  await waitForConnection(a.net)

  const fetchAs = async (h, id) => {
    const { data: rows } = await get(h.files)
    const row = rows.find((r) => r.id === id)
    if (!row) return null
    const res = await fetch(row.url)
    if (!res.ok) return null
    return b4a.from(new Uint8Array(await res.arrayBuffer()))
  }

  const legacyBytes = b4a.from('nested-legacy-file')
  const { data: legacy } = await put(room.files, { data: legacyBytes, type: 'text/plain' })
  await waitUntil(async () => (await fetchAs(b.room, legacy.id)) !== null)
  t.alike(await fetchAs(b.room, legacy.id), legacyBytes, 'nested cross-member file read')

  await rotate(room)
  await waitUntil(() => (b.room.store.keyring.seq === 1 ? true : null))

  const rotatedBytes = b4a.from('nested-epoch-file')
  const { data: rotated } = await put(room.files, { data: rotatedBytes, type: 'text/plain' })
  t.is(room.blobs.stamp, room.store.keyring.current, 'nested child writes into its epoch core')

  await waitUntil(async () => (await fetchAs(b.room, rotated.id)) !== null)
  t.alike(await fetchAs(b.room, rotated.id), rotatedBytes, 'nested member reads the epoch file')
  t.alike(await fetchAs(b.room, legacy.id), legacyBytes, 'nested legacy file survives rotation')
})

test('Handle: second device opens a rotated child by id and reads every era', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.create()

  const a = await openHandle(t, { testnet, identity })
  await a.me.store.bootstrap({ name: 'device-1' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))
  await put(room.messages, { text: 'before' })
  await rotate(room)
  await put(room.messages, { text: 'after' })

  const b = await openHandle(t, { testnet, identity, key: a.me.store.key })
  await waitForConnection(a.net)
  await waitForConnection(b.net)
  await b.me.store.bootstrap({ recovering: true })

  // the child's handles row replicates through the root — open by id
  await waitUntil(async () => {
    const { data: rows } = await get(b.me.team)
    return rows.some((r) => r.id === room.id) ? true : null
  })
  const mirror = await open(b.me.team, { id: room.id })
  t.teardown(() => mirror.close().catch(() => {}))

  await waitUntil(async () => {
    const { data } = await get(mirror.messages)
    return data.length === 2 ? true : null
  })
  t.alike(
    (await get(mirror.messages)).data.map((r) => r.text).sort(),
    ['after', 'before'],
    'second device reads both eras from log replay alone'
  )
  t.is(mirror.store.keyring.seq, 1, 'second device hydrated the epoch from announcements')
})

test('Handle: a nested watch stream keeps emitting across a rotation', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, room, joinAsRoot, sees } = await nestedRoom(t, testnet)

  const b = await joinAsRoot()
  await waitForConnection(a.net)
  await put(room.messages, { text: 'pre' })
  await sees(b.room, 'pre')

  const seen = []
  const stream = watch(b.room.messages)
  stream.on('data', ({ data }) => seen.push(data.map((r) => r.text).sort()))
  t.teardown(() => stream.destroy())

  await rotate(room)
  await put(room.messages, { text: 'post' })

  await waitUntil(() => (seen.some((s) => s.includes('post')) ? true : null))
  t.alike(
    seen[seen.length - 1],
    ['post', 'pre'],
    'watch delivered post-rotation rows without interruption'
  )
})

test('Handle: subscriptions are rotation-transparent — watch, hooks, removed stays silent', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, room, joinAsRoot, sees } = await nestedRoom(t, testnet)

  const b = await joinAsRoot()
  const removed = await joinAsRoot()
  await waitForConnection(a.net)
  await put(room.messages, { text: 'pre' })
  await sees(b.room, 'pre')
  await sees(removed.room, 'pre')

  // live subscriptions opened BEFORE the rotation, on three different peers
  const batches = []
  const changeStream = watch(b.room.messages, { changes: true })
  changeStream.on('data', (batch) => batches.push(batch))
  t.teardown(() => changeStream.destroy())

  const hookRows = []
  const offAfter = after(room.messages, ({ row }) => hookRows.push(row.text))
  t.teardown(offAfter)

  const removedSeen = []
  const removedErrors = []
  const removedStream = watch(removed.room.messages)
  removedStream.on('data', ({ data }) => removedSeen.push(data.length))
  removedStream.on('error', (e) => removedErrors.push(e))
  t.teardown(() => removedStream.destroy())
  await waitUntil(() => (removedSeen.length > 0 ? true : null))

  await del(room.members, removed.identity.id)
  await rotate(room)
  await put(room.messages, { text: 'post' })

  // rotator-side hook fired for the post-rotation write, uninterrupted
  await waitUntil(() => (hookRows.includes('post') ? true : null))
  t.pass('after() hook kept firing across the rotation')

  // member-side changes stream delivered the post-rotation row
  await waitUntil(() =>
    batches.some((batch) => batch.changes?.some((c) => c.next?.text === 'post')) ? true : null
  )
  t.pass('watch delivered post-rotation rows without resubscribing')

  // the removed member's stream is ALIVE and SILENT — no error, no new data
  await new Promise((r) => setTimeout(r, 1500))
  t.is(removedErrors.length, 0, 'removed member stream emitted no error')
  t.absent(removedStream.destroyed, 'removed member stream is still open')
  t.is(
    Math.max(...removedSeen),
    1,
    'removed member stream never saw past the cut — silent, not broken'
  )
})

test('Handle: removal is observable — observers get the delete, the victim is notified', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, room, joinAsRoot, sees } = await nestedRoom(t, testnet)

  const victim = await joinAsRoot()
  const observer = await joinAsRoot()
  await waitForConnection(a.net)
  await put(room.messages, { text: 'pre' })
  await sees(victim.room, 'pre')
  await sees(observer.room, 'pre')
  await waitUntil(async () => ((await get(observer.room.members)).data.length === 3 ? true : null))

  // an observer receives a removal as an ordinary delete: { prev: row, next: null }
  const deleted = []
  const feed = watch(observer.room.members, { changes: true })
  feed.on('data', (batch) => {
    for (const c of batch.changes) if (c.next === null) deleted.push(c.prev.id)
  })
  t.teardown(() => feed.destroy())

  // ORDERING GUARANTEE: del-member is appended before the rotation, under the
  // epoch the victim can still read, so their own members watch reports the
  // removal. This is the signal an app renders as "you were removed" — batching
  // removal and rotation into one epoch would make removed members go silently
  // dark with no signal at all.
  const snapshots = []
  const own = watch(victim.room.members)
  own.on('data', ({ data }) => snapshots.push(data.map((m) => m.id)))
  t.teardown(() => own.destroy())
  await waitUntil(() => (snapshots.length > 0 ? true : null))

  await del(room.members, victim.identity.id)
  await rotate(room)
  await put(room.messages, { text: 'post' })

  await waitUntil(() => (deleted.includes(victim.identity.id) ? true : null))
  t.pass('observer received the removal as a change with no next')

  await waitUntil(() => (snapshots.some((s) => !s.includes(victim.identity.id)) ? true : null))
  t.pass('the removed member was notified of their own removal before the cut')
  t.absent(own.destroyed, 'and their stream stays open — silent, not broken')
})

test('Handle: removal fires unwritable on the victim and apply on observers', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, room, joinAsRoot, sees } = await nestedRoom(t, testnet)

  const victim = await joinAsRoot()
  const observer = await joinAsRoot()
  await waitForConnection(a.net)
  await put(room.messages, { text: 'pre' })
  await sees(victim.room, 'pre')
  await sees(observer.room, 'pre')
  await waitUntil(() => (victim.room.store.writable ? true : null))

  // the victim gets an explicit signal instead of having to scan `members`
  let lostAccess = false
  victim.room.store.on('unwritable', () => {
    lostAccess = true
  })

  // hooks are an app-data rule: membership moves through the builtin routes, which run
  // none, so the apply event is what tells an observer about a removal
  const applied = []
  const onApply = ({ op, name, row }) => {
    if (op === 'del' && name === 'member') applied.push(row.id)
  }
  observer.room.store.on('apply', onApply)
  const off = () => observer.room.store.off('apply', onApply)
  t.teardown(off)
  let afterFired = false
  t.teardown(
    after(observer.room.members, () => (afterFired = true), { signal: observer.me.signal })
  )

  await del(room.members, victim.identity.id)
  await rotate(room)

  await waitUntil(() => (lostAccess ? true : null))
  t.pass('victim received unwritable when their access ended')
  t.absent(victim.room.store.writable, 'and the store reports it as state too')

  await waitUntil(() => (applied.includes(victim.identity.id) ? true : null))
  t.pass('observer saw the replicated removal via the apply event')
  await waitUntil(() => afterFired || null)
  t.pass('after() fires on the replicated removal of a member row')
})

test('Handle: a re-invited removed member reads the gap era (documented semantics)', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, room, joinAsRoot, sees } = await nestedRoom(t, testnet)

  const bob = await joinAsRoot()
  await waitForConnection(a.net)
  await put(room.messages, { text: 'before' })
  await sees(bob.room, 'before')

  await del(room.members, bob.identity.id)
  await rotate(room)
  await put(room.messages, { text: 'gossip-about-bob' })
  await new Promise((r) => setTimeout(r, 1000))
  t.absent(
    (await get(bob.room.messages)).data.some((r) => r.text === 'gossip-about-bob'),
    'removed bob cannot read the gap while excluded'
  )
  await waitUntil(async () => {
    const { data } = await get(room.devices)
    return data.every((d) => d.memberId !== bob.identity.id) ? true : null
  })
  t.pass('removal swept the member device rows')

  // re-inviting is FULL re-trust: the idempotent-join shortcut detects the
  // dead membership, discards the revoked session, runs a real pairing, and
  // the join delivers every epoch secret — the re-admitted member reads the
  // era they were excluded from, by design
  const bob2 = await open(bob.me.team, await cero.invite(room))
  t.teardown(() => bob2.close().catch(() => {}))
  await waitUntil(async () => {
    const { data } = await get(bob2.messages)
    return data.some((r) => r.text === 'gossip-about-bob') ? true : null
  })
  t.pass('re-invited member reads the excluded era — re-inviting means full re-trust')
})

test('Handle: an invite minted before a rotation still works after it', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, room, sees } = await nestedRoom(t, testnet)

  await put(room.messages, { text: 'before' })
  const invite = await cero.invite(room) // minted at epoch 0
  await rotate(room)
  await put(room.messages, { text: 'after' })

  const peer = await openHandle(t, { testnet })
  await peer.me.store.bootstrap({ name: 'late' })
  const joined = await open(peer.me.team, invite) // redeemed at epoch 1
  t.teardown(() => joined.close().catch(() => {}))
  await waitForConnection(a.net)

  await sees(joined, 'before')
  await sees(joined, 'after')
  // a join after a rotation heals the envelopes, so the epoch may already be past 1
  t.ok(joined.store.keyring.seq >= 1, 'confirm delivered the epochs current at accept time')
})

test('Handle: self-removal in a rotated room — the healer cuts the leaver off', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, room, joinAsRoot, sees } = await nestedRoom(t, testnet)

  const leaver = await joinAsRoot()
  await waitForConnection(a.net)
  await put(room.messages, { text: 'pre' })
  await sees(leaver.room, 'pre')

  await rotate(room) // activate rotation policy
  await waitUntil(() => (leaver.room.store.keyring.seq === 1 ? true : null))

  // the member removes THEMSELVES (allowed) — the admin's healer must rotate
  await del(leaver.room.members, leaver.identity.id)
  await waitUntil(() => (room.store.keyring.seq >= 2 ? true : null))

  await put(room.messages, { text: 'post-departure' })
  await new Promise((r) => setTimeout(r, 1500))
  t.absent(
    (await get(leaver.room.messages)).data.some((r) => r.text === 'post-departure'),
    'self-removed member cannot read past the healed epoch'
  )
})

test('Handle: sibling rooms rotate independently under one root', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'root' })
  const clinic = await open(a.me.team, { name: 'clinic' })
  const admin = await open(a.me.team, { name: 'admin' })
  t.teardown(() => Promise.all([clinic.close(), admin.close()]).catch(() => {}))

  await put(clinic.messages, { text: 'clinic-pre' })
  await put(admin.messages, { text: 'admin-only' })

  const { epoch } = await rotate(clinic)
  t.is(epoch, 1)
  await put(clinic.messages, { text: 'clinic-post' })

  t.is(admin.store.keyring.seq, 0, 'sibling room untouched by the rotation')
  t.unlike(
    clinic.store.encryptionKey,
    admin.store.encryptionKey,
    'sibling rooms keep distinct keys'
  )
  t.alike(
    (await get(clinic.messages)).data.map((r) => r.text).sort(),
    ['clinic-post', 'clinic-pre'],
    'rotated room reads both eras'
  )
  t.alike(
    (await get(admin.messages)).data.map((r) => r.text),
    ['admin-only'],
    'sibling room unaffected'
  )
})

// ─── invite + join (different identity, multi-user) ───────────────────────

test('Handle: an invite admits a member atomically, whose writes reach the host', async (t) => {
  const { room, join } = await hosted(t, 'admission')
  await put(room.messages, { text: 'from-host' })
  const { room: joiner } = await join(await cero.invite(room, { role: 'member', ttl: 60_000 }))
  await waitUntil(() => joiner.store.writable)
  await put(joiner.messages, { text: 'from-joiner' })
  await waitUntil(async () => {
    const { data: list } = await get(room.messages)
    return list.find((r) => r.text === 'from-joiner') ? true : null
  })
  const { data: onHost } = await get(room.messages)
  t.alike(onHost.map((r) => r.text).sort(), ['from-host', 'from-joiner'])
})

test('Handle: revoke makes the invite un-joinable', async (t) => {
  const { room, join } = await hosted(t, 'revoked')
  const inviteStr = await cero.invite(room, { role: 'member', ttl: 60_000 })
  t.is(await cero.revoke(room, inviteStr), true, 'revoke returns true the first time')
  t.is(await cero.revoke(room, inviteStr), false, 'revoke returns false the second time')
  await t.exception.all(join(inviteStr), /DENIED/)
})

// ─── Phase 4: root getter + coreKey→handle registry ──────────────────────────

test('Handle: root getter — root returns self, child returns the root', async (t) => {
  const { me } = await openHandle(t)
  await me.store.bootstrap({ name: 'desktop' })
  t.is(me.root, me, 'root handle is its own root')

  const child = await me._create('team', { name: 'T' })
  t.teardown(() => child.close().catch(() => {}))
  t.is(child.root, me, 'child resolves to the top handle')
  t.is(child.parent, me, 'parent is still the direct parent')
})

test('Handle: root owns the coreKey→encryptionKey registry', async (t) => {
  const { me } = await openHandle(t, { opts: { keepOpen: 0 } })
  await me.store.bootstrap({ name: 'desktop' })
  const child = await me._create('team', { name: 'T' })

  const key = child.store.key
  const hex = b4a.toHex(key)
  t.alike(
    me._coreKeys.get(hex),
    child.store.encryptionKey,
    'child encryptionKey registered under its db key'
  )
  t.is(child._coreKeys, null, 'only the root carries the registry')

  await child.close()
  t.absent(me._coreKeys.get(hex), 'unregistered on close')
})

test('Handle: each created room gets its own random encryption key', async (t) => {
  const { me, identity } = await openHandle(t)
  await me.store.bootstrap({ name: 'desktop' })

  const a = await me._create('team', { name: 'A' })
  const b = await me._create('team', { name: 'B' })
  t.teardown(() => Promise.all([a.close(), b.close()]).catch(() => {}))

  t.unlike(a.store.encryptionKey, b.store.encryptionKey, 'rooms do not share a key')
  t.unlike(a.store.encryptionKey, identity.encryptionKey, 'room key is not the identity key')
  t.unlike(b.store.encryptionKey, identity.encryptionKey, 'room key is not the identity key')
  t.alike(me.store.encryptionKey, identity.encryptionKey, 'root stays seed-derived for recovery')
})

// ─── Phase 4: fileServer ──────────────────────────────────────────────────────

test('Handle: fileServer listens on the root, resolve maps coreKey→encryptionKey', async (t) => {
  const { me } = await openHandle(t)
  await me.store.bootstrap({ name: 'desktop' })

  const fs = me.fileServer
  t.is(me.fileServer, fs, 'same lazily-constructed instance')
  t.ok(fs.port > 0, 'listening on a port')

  const resolved = me._resolveCore(me.store.key, {})
  t.alike(
    resolved.encryptionKey,
    me.store.encryptionKey,
    'own handle resolves to its encryptionKey'
  )
  t.alike(resolved.key, me.store.key, 'echoes the coreKey back as key')

  const stranger = await Identity.create()
  t.is(me._resolveCore(stranger.publicKey, {}), null, 'unknown core → null (404)')
})

test('Handle: fileServer closes with the root', async (t) => {
  const { me } = await openHandle(t)
  await me.store.bootstrap({ name: 'desktop' })
  const fs = me.fileServer
  t.ok(fs.port > 0)
  await me.close()
  t.is(me._fileServer, null, 'fileServer dropped on close')
})

// ─── Phase 4: blobs ───────────────────────────────────────────────────────────

test('Handle: blobs — lazy, per-handle, round-trips bytes', async (t) => {
  const { me } = await openHandle(t)
  await me.store.bootstrap({ name: 'desktop' })

  const b = me.blobs
  t.is(me.blobs, b, 'same lazily-constructed instance')
  await b.ready()

  const bytes = b4a.from('hello blobs')
  const blobId = await b.put(bytes)
  const back = await b.get(blobId)
  t.alike(back, bytes, 'put → get round-trips')
  t.ok(b.key, 'exposes its blob core key')
})

// ─── Phase 4: files put/get ───────────────────────────────────────────────────

test('files: put(handle.files, { data, type }) uploads and returns a resolved file', async (t) => {
  const { me } = await openHandle(t)

  const data = b4a.from('a tiny png')
  const { data: file } = await put(me.files, { data, type: 'image/png', name: 'pic.png' })

  t.is(file.name, 'pic.png', 'echoes the declared name')
  t.is(file.type, 'image/png', 'carries the mimetype')
  t.is(file.size, data.byteLength, 'size = byteLength')
  t.ok(file.id, 'durable id')
  t.ok(file.url.startsWith('http'), 'ephemeral url from the file server')

  const { data: row } = await get(me.files, file.id)
  t.is(row.id, file.id, 'the row id IS the file id')
  t.is(row.name, 'pic.png')
})

// ─── Phase 4: file() field resolution on get/watch ───────────────────────────

test('files: set(profile, { avatar: file.id }) → get(profile) yields avatar as a resolved file', async (t) => {
  const { me } = await openHandle(t)

  const { data: file } = await put(me.files, {
    data: b4a.from('AV'),
    type: 'image/png',
    name: 'a.png'
  })
  await set(me.profile, { name: 'jb', avatar: file.id })

  const { data: profile } = await get(me.profile)
  t.is(typeof profile.avatar, 'object', 'avatar resolved, not a bare id')
  t.is(profile.avatar.id, file.id)
  t.is(profile.avatar.type, 'image/png')
  t.is(profile.avatar.size, 2)
  t.ok(profile.avatar.url.startsWith('http'), 'url derived from the id, no files lookup')
})

test('files: get(handle.files, id) resolves a single file row', async (t) => {
  const { me } = await openHandle(t)

  const { data: file } = await put(me.files, {
    data: b4a.from('one'),
    type: 'text/plain',
    name: 'o.txt'
  })
  const { data } = await get(me.files, file.id)
  t.is(data.id, file.id)
  t.is(data.name, 'o.txt')
  t.is(data.type, 'text/plain')
  t.is(data.size, 3)
  t.ok(data.url.startsWith('http'))
})

// ─── Phase 4: WRITE gate ──────────────────────────────────────────────────────

test('Handle: me.topics and me.joins read one row by id, as a collection does', async (t) => {
  const { me } = await ceroOpen(t)
  await open(me.team, { name: 'clinic' })
  await waitUntil(async () => (await get(me.topics)).data.length === 1)
  const [row] = (await get(me.topics)).data
  t.alike((await get(me.topics, row.id)).data, row, 'a topic by its id')
  t.alike((await get(me.topics, { name: 'clinic' })).data, [row], 'a filter still lists')
  t.is((await get(me.topics, 'unknown')).data, null, 'an unknown topic reads null')
  t.is((await get(me.joins, 'unknown')).data, null, 'an unknown join reads null')
})

test('files: a reader cannot add a file', async (t) => {
  const { room, join } = await hosted(t, 'files')
  const { room: reader } = await join(await cero.invite(room, { role: 'reader' }))
  await waitUntil(async () => ((await get(reader.members)).data.length > 0 ? true : null))
  await t.exception.all(
    put(reader.files, { data: b4a.from('nope'), type: 'text/plain', name: 'x.txt' }),
    /not writable/i,
    'a reader is refused'
  )
  const { data } = await get(reader.files)
  t.is(data.length, 0, 'no file row landed')
})

test('files: a file resolves in its own handle whatever a room on the device does', async (t) => {
  const { me } = await openHandle(t)
  const read = async (id) => {
    const res = await fetch((await get(me.files, id)).data.url)
    return res.ok ? b4a.toString(b4a.from(new Uint8Array(await res.arrayBuffer()))) : null
  }
  const { data: file } = await put(me.files, { data: b4a.from('root file'), type: 'text/plain' })
  const room = await open(me.team, { name: 'r' })
  await put(room.files, { data: b4a.from('room file'), type: 'text/plain' })
  t.is(await read(file.id), 'root file', 'while a room holds files too')
  await room.close()
  t.is(await read(file.id), 'root file', 'and once the room closed')
})

test("files: a row naming another member's blob with the wrong epoch leaves that member's file readable", async (t) => {
  const { room, join } = await hosted(t, 'files')
  const { room: mallory } = await join(await cero.invite(room))
  const { room: olive } = await join(await cero.invite(room))
  await rotate(room)
  await waitUntil(() => olive.store.keyring.seq === 1 && mallory.store.keyring.seq === 1)
  const want = 'the host file after the rotation'
  const { data: real } = await put(room.files, { data: b4a.from(want), type: 'text/plain' })

  // the same core and blob under another type, stamped with the base epoch
  await waitUntil(async () => (await get(mallory.files, real.id)).data)
  const { coreKey, blobId } = decodeId(real.id)
  const forged = encodeId(coreKey, blobId, 'text/html')
  await mallory.store.call('add-file', { id: forged, name: 'hi', stamp: 0, from: null })

  // olive reads the forged row first
  await waitUntil(async () => (await get(olive.files, forged)).data)
  await waitUntil(async () => (await get(olive.files, real.id)).data)
  const { data: row } = await get(olive.files, real.id)
  const read = await waitUntil(async () => {
    const res = await fetch(row.url)
    return res.ok ? b4a.toString(b4a.from(new Uint8Array(await res.arrayBuffer()))) : null
  })
  t.is(read, want, 'the host file decrypts on olive')
})

test("files: a row whose type no header carries leaves another member's untyped file readable", async (t) => {
  const { room, join } = await hosted(t, 'files')
  const { room: mallory } = await join(await cero.invite(room))
  const { room: olive } = await join(await cero.invite(room))
  await rotate(room)
  await waitUntil(() => olive.store.keyring.seq === 1 && mallory.store.keyring.seq === 1)
  const want = 'the host file after the rotation'
  const { data: real } = await put(room.files, { data: b4a.from(want), type: '' })

  // the same core and blob under the type '\x01', served as '' like the real one, stamped with the base epoch
  await waitUntil(async () => (await get(mallory.files, real.id)).data)
  const { coreKey, blobId } = decodeId(real.id)
  const bytes = z32.decode(encodeId(coreKey, blobId, 'x'))
  bytes[bytes.length - 1] = 1
  const forged = z32.encode(bytes)
  await mallory.store.call('add-file', { id: forged, name: 'hi', stamp: 0, from: null })

  // olive reads the forged row first
  await waitUntil(async () => (await get(olive.files, forged)).data)
  await waitUntil(async () => (await get(olive.files, real.id)).data)
  const { data: row } = await get(olive.files, real.id)
  const read = await waitUntil(async () => {
    const res = await fetch(row.url)
    return res.ok ? b4a.toString(b4a.from(new Uint8Array(await res.arrayBuffer()))) : null
  })
  t.is(read, want, 'the host file decrypts on olive')
})

test("files: a stored type a header cannot carry serves another member's file", async (t) => {
  const { room, join } = await hosted(t, 'files')
  const { room: olive } = await join(await cero.invite(room))
  const want = 'an earlier build stored it'
  const { data: file } = await put(room.files, { data: b4a.from(want), type: 'x' })
  // the same blob under the type '\x01', as an earlier build could have stored it
  const bytes = z32.decode(file.id)
  bytes[bytes.length - 1] = 1
  const id = z32.encode(bytes)
  await room.store.call('add-file', { id, name: null, stamp: 0, from: null })

  const { data: row } = await waitUntil(async () => {
    const got = await get(olive.files, id)
    return got.data && got
  })
  const read = await waitUntil(async () => {
    const res = await fetch(row.url)
    return res.ok ? b4a.toString(b4a.from(new Uint8Array(await res.arrayBuffer()))) : null
  }, 10000).catch(() => null)
  t.is(read, want, 'the bytes decrypt on olive')
})

test('files: reading its own files adds nothing to the root registry', async (t) => {
  const { me } = await openHandle(t)
  await me.store.bootstrap({ name: 'desktop' })
  const { data: first } = await put(me.files, { data: b4a.from('0'), type: 'text/plain' })
  await get(me.files, first.id)
  const size = me._coreKeys.size
  for (let i = 1; i < 20; i++) await put(me.files, { data: b4a.from(`${i}`), type: 'text/plain' })
  const { data: rows } = await get(me.files)
  t.is(rows.length, 20, 'every file read')
  t.is(me._coreKeys.size, size, 'one entry for the core, none per file')
})

test('watch: changes carry file fields resolved on both sides', async (t) => {
  const { me } = await openHandle(t)

  const stream = watch(me.profile, { changes: true })
  const batches = []
  stream.on('data', (b) => batches.push(b))
  await waitUntil(() => batches.length >= 1)

  const { data: file } = await put(me.files, {
    data: b4a.from('AV'),
    type: 'image/png',
    name: 'a.png'
  })
  await set(me.profile, { name: 'jb', avatar: file.id })
  await waitUntil(() => {
    const last = batches[batches.length - 1]
    return last && !last.reset && last.changes.some((c) => c.next?.name === 'jb')
  })

  const delta = batches[batches.length - 1].changes.find((c) => c.next?.name === 'jb')
  t.is(delta.next.avatar.id, file.id, 'file field resolved on next')
  t.is(delta.next.avatar.type, 'image/png')
  t.ok(delta.next.avatar.url.startsWith('http'), 'url resolved')

  await set(me.profile, { name: 'jb2' })
  await waitUntil(() => {
    const last = batches[batches.length - 1]
    return last.changes.some((c) => c.next?.name === 'jb2')
  })
  const upd = batches[batches.length - 1].changes.find((c) => c.next?.name === 'jb2')
  t.is(upd.prev.name, 'jb', 'prev side present')
  t.is(upd.prev.avatar?.id, file.id, 'file field resolved on prev too')
  stream.destroy()
})

test('Handle: open by id while its create is still in flight shares the child', async (t) => {
  const { me } = await openHandle(t)
  await me.store.bootstrap()

  // The add-handle row lands mid-create, so a watcher can see the id before
  // create resolves. That open must share the in-flight child — a duplicate
  // Handle over the same core deadlocks in ready().
  const seen = new Promise((resolve) => {
    const stream = watch(me.team)
    stream.on('data', ({ data }) => {
      if (data.length) {
        stream.destroy()
        resolve(data[0].id)
      }
    })
    t.teardown(() => stream.destroy())
  })

  const creating = open(me.team, { name: 'race' })
  const id = await seen
  const reopened = await Promise.race([
    open(me.team, { id }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('open-by-id hung')), 15000))
  ])
  const created = await creating
  t.teardown(() => created.close().catch(() => {}))

  t.is(reopened, created, 'concurrent open shares the in-flight create')
  const { data: mine } = await get(created.members, me.id)
  t.is(mine.role, 'owner', 'creator member row intact')
})

test('Handle: an invite to a room this device is in opens it from its one row, no list read', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'known' })
  await open(me.team, { name: 'other' })
  const invite = await cero.invite(room)

  const reads = []
  const read = me.store.get.bind(me.store)
  me.store.get = (name, query) => {
    if (name === 'handles') reads.push(query)
    return read(name, query)
  }
  const again = await open(me.team, invite)
  t.is(again.id, room.id, 'the room it is in')
  t.ok(reads.includes(room.id), 'its row read by id')
  t.alike(
    reads.filter((query) => typeof query !== 'string'),
    [],
    'and no list of the handles'
  )
})

// ─── devices: a room is told which device keys of an identity are out ──────

const asked = (me) =>
  waitUntil(async () => (await get(me.requests)).data.find((r) => !r.admitted) || null)

// a new device linked from `from`, accepted there
async function linkTo(t, from) {
  const invite = await cero.invite(from.me)
  const linking = ceroOpen(t, { testnet: from.testnet, invite })
  await cero.accept(from.me, await asked(from.me))
  return linking
}

const deviceKey = (peer) => peer.me.identity.device.publicKey
const names = (keys, key) => keys.some((k) => b4a.equals(k, key))
const seats = (me, n) => waitUntil(async () => (await get(me.devices)).data.length === n)
const sits = async (room, peer) =>
  (await get(room.devices)).data.some((row) => row.key && b4a.equals(row.key, deviceKey(peer)))
// what a room was told of the identity's device keys, once it names the removed one
const toldOf = (room, removed) =>
  waitUntil(async () => {
    const told = await room.store.told(room.identity.id)
    return names(told.removed, deviceKey(removed)) ? told : null
  })

test('devices: a phone removed in the root is told to each open room once, with the keys removed and those that stand, and not again at the next open', async (t) => {
  const a = await ceroOpen(t)
  const rooms = [await open(a.me.team, { name: 'clinic' }), await open(a.me.team, { name: 'lab' })]
  const phone = await linkTo(t, a)
  await seats(a.me, 2)
  const before = rooms.map((room) => room.store.length)

  await del(a.me.devices, phone.me.device.id)
  for (const room of rooms) {
    const told = await toldOf(room, phone)
    t.alike(told.removed, [deviceKey(phone)], 'the key removed')
    t.alike(told.standing, [deviceKey(a)], 'and the one that stands')
  }
  await a.me._pruneAll()
  const once = before.map((length) => length + 1)
  t.alike(
    rooms.map((room) => room.store.length),
    once,
    'one append in each'
  )

  const ids = rooms.map((room) => room.id)
  await a.me.close()
  const again = await cero(a.dir, spec, { bootstrap: a.testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 1 })
  for (const [i, id] of ids.entries()) {
    const room = await open(again.team, { id })
    await again._pruneAll()
    t.is(room.store.length, once[i], 'and none at the next open')
  }
})

test('devices: a device the removed phone had linked keeps its seat, and opens a room it never sat in', async (t) => {
  const a = await ceroOpen(t)
  const sat = await open(a.me.team, { name: 'clinic' })
  const other = await open(a.me.team, { name: 'lab' })
  const phone = await linkTo(t, a)
  const tablet = await linkTo(t, phone)
  await seats(a.me, 3)
  const mine = await open(tablet.me.team, { id: sat.id })
  await waitUntil(() => mine.store.writable)

  await del(a.me.devices, phone.me.device.id)
  for (const room of [sat, other]) {
    const told = await toldOf(room, phone)
    t.ok(names(told.standing, deviceKey(tablet)), 'the room is told it stands')
  }
  t.ok(await sits(sat, tablet), 'it keeps its seat')
  await put(mine.messages, { text: 'still here' })
  await waitUntil(async () => (await get(sat.messages)).data.length === 1)
  const late = await open(tablet.me.team, { id: other.id })
  await waitUntil(() => late.store.writable)
  await waitUntil(() => sits(other, tablet))
  t.pass('and takes one in a room it never sat in')
})

test('devices: a removed device that never sat in a room takes no seat there once the room was told', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const phone = await linkTo(t, a)
  await waitUntil(async () => (await get(phone.me.team)).data.length === 1)

  await del(a.me.devices, phone.me.device.id)
  await toldOf(room, phone)
  await t.exception(open(phone.me.team, { id: room.id }))
  t.absent(await sits(room, phone), 'it has no seat')
})

test('devices: a room below the version that brings revoke loses the seats of a removed device as before, and is told nothing', async (t) => {
  const team = spec.handles.team
  const { since } = team.meta
  const routes = { ...since.routes, '@cero/revoke': team.meta.version + 1 }
  const meta = { ...team.meta, since: { ...since, routes } }
  const older = { ...spec, handles: { ...spec.handles, team: { ...team, meta } } }
  const testnet = await makeTestnet(t)
  const launch = async (opts) => {
    const me = await cero(await t.tmp(), older, { bootstrap: testnet.bootstrap, ...opts })
    t.teardown(() => me.close().catch(() => {}), { order: 5 })
    return { me }
  }
  const a = await launch()
  const room = await open(a.me.team, { name: 'clinic' })
  const linking = launch({ invite: await cero.invite(a.me) })
  await cero.accept(a.me, await asked(a.me))
  const phone = await linking
  const mine = await open(phone.me.team, { id: room.id })
  await waitUntil(() => mine.store.writable)
  await waitUntil(() => sits(room, phone))

  await del(a.me.devices, phone.me.device.id)
  await waitUntil(async () => !(await sits(room, phone)))
  t.pass('its seat went')
  t.alike(await room.store.told(a.me.id), { removed: [], standing: [] }, 'with nothing told')
})

test('devices: a root update tells the rooms a device has open', async (t) => {
  const a = await ceroOpen(t)
  const b = await ceroOpen(t, { testnet: a.testnet, phrase: await cero.phrase(a.me) })
  const phone = await linkTo(t, a)
  await seats(b.me, 3)
  const room = await open(b.me.team, { name: 'lab' })
  const before = room.store.length

  await del(a.me.devices, phone.me.device.id)
  const told = await toldOf(room, phone)
  t.is(told.standing.length, 2, 'both devices that stand')
  await b.me._pruneAll()
  t.is(room.store.length, before + 1, 'told once, by the device that has it open')
})

test('devices: two devices of the identity that tell a room at once leave the same row', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const b = await ceroOpen(t, { testnet: a.testnet, phrase: await cero.phrase(a.me) })
  const mine = await open(b.me.team, { id: room.id })
  await waitUntil(() => mine.store.writable)
  const phone = await linkTo(t, a)
  await seats(a.me, 3)
  await seats(b.me, 3)

  await del(a.me.devices, phone.me.device.id)
  const rows = [await toldOf(room, phone), await toldOf(mine, phone)]
  await Promise.all([a.me._pruneAll(), b.me._pruneAll()])
  const lengths = [room.store.length, mine.store.length]
  t.alike(rows[0], rows[1], 'the same on both')
  t.alike(rows[0].removed, [deviceKey(phone)])
  t.ok(names(rows[0].standing, deviceKey(a)) && names(rows[0].standing, deviceKey(b)))
  await Promise.all([a.me._pruneAll(), b.me._pruneAll()])
  t.alike([room.store.length, mine.store.length], lengths, 'and neither tells again')
  t.alike(await room.store.told(a.me.id), await mine.store.told(a.me.id))
})

test('devices: a reader in a room hears no error when its root removes a device, and the room is told nothing by it', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const errors = []
  const b = await ceroOpen(t, { testnet: a.testnet, onerror: (err) => errors.push(err) })
  const seen = await open(b.me.team, await cero.invite(room, { role: 'reader' }))
  const phone = await linkTo(t, b)
  await seats(b.me, 2)

  await del(b.me.devices, phone.me.device.id)
  await b.me._pruneAll()
  t.absent(seen.store.writable, 'a reader has no seat')
  t.alike(errors, [], 'its compare writes nothing')
  t.alike(await room.store.told(b.me.id), { removed: [], standing: [] })
})

test('devices: a room told what the root holds is not written to again at the next open', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const phone = await linkTo(t, a)
  await seats(a.me, 2)
  await del(a.me.devices, phone.me.device.id)
  await toldOf(room, phone)
  await a.me._pruneAll()

  const { id } = room
  await a.me.close()
  const again = await cero(a.dir, spec, { bootstrap: a.testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 1 })
  const { call } = Database.prototype
  let tellings = 0
  Database.prototype.call = function (op, data) {
    if (op === 'revoke') tellings++
    return call.call(this, op, data)
  }
  try {
    await open(again.team, { id })
    await again._pruneAll()
  } finally {
    Database.prototype.call = call
  }
  t.is(tellings, 0, 'the compare finds it told')
})

test('devices: a device its own root does not seat tells no room', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const phone = await linkTo(t, a)
  const mine = await open(phone.me.team, { id: room.id })
  await waitUntil(() => mine.store.writable)
  await waitUntil(() => sits(room, phone))

  // its root as a removal of it reaches the device before the rooms were told
  const root = phone.me.store
  const read = root.get.bind(root)
  const out = (row) => row.key && b4a.equals(row.key, deviceKey(phone))
  root.removals = async () => [deviceKey(phone)]
  root.get = async (name, query) => {
    const res = await read(name, query)
    return name === 'devices' ? { ...res, data: res.data.filter((row) => !out(row)) } : res
  }
  await phone.me._prune(mine)
  t.alike(await mine.store.told(phone.me.id), { removed: [], standing: [] }, 'it tells nothing')
  t.ok(await sits(mine, phone), 'and keeps its seat until a device that stands tells')
})

// ─── devices: the rooms nobody has open are told too ──────

async function relaunch(t, peer, opts = {}) {
  const me = await cero(peer.dir, spec, { bootstrap: peer.testnet.bootstrap, ...opts })
  t.teardown(() => me.close().catch(() => {}), { order: 1 })
  return me
}

// the root's pass over its closed rooms finished
const passed = (me) => waitUntil(async () => (await me.local.store.get('told')).data)

// the tellings written, the lists of the handles read and the rooms opened while `act` runs
async function tally(act, onrevoke = () => {}) {
  const seen = { tellings: 0, lists: 0, opened: 0 }
  const { call, get: read } = Database.prototype
  const ready = Handle.prototype._open
  Database.prototype.call = function (op, data) {
    if (op === 'revoke') {
      seen.tellings++
      onrevoke()
    }
    return call.call(this, op, data)
  }
  Database.prototype.get = function (name, query) {
    if (name === 'handles' && typeof query !== 'string') seen.lists++
    return read.call(this, name, query)
  }
  Handle.prototype._open = function () {
    if (this.parent) seen.opened++
    return ready.call(this)
  }
  try {
    await act()
  } finally {
    Object.assign(Database.prototype, { call, get: read })
    Handle.prototype._open = ready
  }
  return seen
}

// three rooms a device made, closed, and its phone linked
async function closedRooms(t) {
  const a = await ceroOpen(t)
  const ids = []
  for (const name of ['clinic', 'lab', 'ward']) ids.push((await open(a.me.team, { name })).id)
  const phone = await linkTo(t, a)
  await seats(a.me, 2)
  await a.me.close()
  return { a, ids, phone }
}

// each room, opened at a fresh launch, was told the phone is out: its open tells nothing
async function toldAtOpen(t, a, ids, phone) {
  const again = await relaunch(t, a)
  const seen = await tally(async () => {
    for (const id of ids) {
      const room = await open(again.team, { id })
      t.ok(names((await room.store.told(again.id)).removed, deviceKey(phone)), 'the room was told')
    }
    await again._pruneAll()
  })
  t.is(seen.tellings, 0, 'and its open tells nothing again')
}

test('devices: a device removed in the root while three rooms are closed is told to each, none of them handed to the app', async (t) => {
  const { a, ids, phone } = await closedRooms(t)
  const me = await relaunch(t, a)
  const handed = []
  me.on('handle', (h) => handed.push(h))
  const seen = await tally(async () => {
    await del(me.devices, phone.me.device.id)
    await passed(me)
  })
  t.is(seen.tellings, 3, 'each room told once')
  t.is(seen.lists, 1, 'from one list of the handles')
  t.alike(handed, [], 'none handed to the app')
  t.is(me.children.size + me._pending.size, 0, 'and none left open')
  await me.close()
  await toldAtOpen(t, a, ids, phone)
})
