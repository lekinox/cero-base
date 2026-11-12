import test from 'brittle'
import process from 'process'
import b4a from 'b4a'
import c from 'compact-encoding'
import z32 from 'z32'
import { rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import hid from 'hypercore-id-encoding'
import { encode, createNotification } from 'blind-push'

import { Identity } from '@cero-base/core/identity'
import { Invite } from '@cero-base/core/invite'
import { Database } from '@cero-base/core/database'
import { Storage } from '@cero-base/core/storage'
import { encodeId, decodeId } from '@cero-base/core/blobs/codec'

import { Handle, Ref } from '../../src/handle/index.js'
import { cero, schema, t as T } from '../../src/index.js'
import { build } from '../../src/build/index.js'
import { defs } from '../../src/build/internal.js'
import {
  put,
  set,
  get,
  del,
  open,
  rotate,
  accept,
  deny,
  receive,
  watch,
  after
} from '../../src/lib/operators.js'
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
  ceroOpen,
  addHandles,
  refusedAtClaim
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
  const { data: asking } = await get(peer.me.team, hid.encode(Invite.parse(invite).key))
  t.is(asking.state, 'asking', 'the join still asks')
  t.absent(asking.encryptionKey, 'the made-up keys are not kept')

  await accept(room, await nextRequest(room))
  const joined = await joining
  t.teardown(() => joined.close().catch(() => {}))
  // its device seats itself: the host has the member once that claim reached it
  t.ok(await waitUntil(async () => (await get(room.members, peer.identity.id)).data))
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

// a confirm invite to a host's room, and two devices of one identity
async function twins(t) {
  const testnet = await makeTestnet(t)
  const host = await openHandle(t, { testnet })
  const room = await open(host.me.team, { name: 'clinic' })
  const invite = await cero.invite(room, { confirm: true })
  const a = await openHandle(t, { testnet })
  const b = await openHandle(t, { testnet, identity: a.identity, key: a.me.store.key })
  await b.me.store.bootstrap({ recovering: true })
  const states = []
  const off = b.me.store.onUpdate('handles', async () => {
    const state = (await get(b.me.team, room.id)).data?.state
    if (state && states.at(-1) !== state) states.push(state)
  })
  t.teardown(off)
  return { testnet, room, invite, a, b, states }
}

test('join: a second device reads asking, joining and in, and carries the join to in once the asking device closes after joining', async (t) => {
  const { room, invite, a, b, states } = await twins(t)
  // the asking device stops once the keys are on its row
  a.me._enter = async () => {
    throw new Error('stopped')
  }
  const joining = open(a.me.team, invite).catch((e) => e)
  await waitUntil(() => states.includes('asking'))
  await accept(room, await nextRequest(room))
  t.is((await joining).message, 'stopped')
  await waitUntil(() => states.includes('joining'))
  await a.me.close()
  await waitUntil(() => states.includes('in'))
  t.alike(states, ['asking', 'joining', 'in'], 'the second device read every step')
  const seated = await open(b.me.team, { id: room.id })
  t.teardown(() => seated.close().catch(() => {}))
  t.ok(seated.store.writable, 'and took its seat')
})

test('join: a cancel from a second device ends the join on the first with CANCELLED, and its request goes from the room', async (t) => {
  const { room, invite, a, b, states } = await twins(t)
  const joining = open(a.me.team, invite).catch((e) => e)
  await waitUntil(() => states.includes('asking'))
  await nextRequest(room)
  t.ok(await cero.cancel(b.me, invite), 'no join of its own, the second device cancels it')
  t.is((await joining).code, 'CANCELLED')
  await waitUntil(() => a.me._joining.size === 0)
  t.pass('the first device stopped carrying it')
  await waitUntil(async () => (await get(room.requests)).data.length === 0)
  t.pass('the room no longer lists it')
})

test('join: a cancel takes the request back from the room, and an approve after it lets nobody in', async (t) => {
  const { room, invite, a } = await twins(t)
  const joining = open(a.me.team, invite).catch((e) => e)
  const request = await nextRequest(room)
  t.ok(await cero.cancel(a.me, invite))
  t.is((await joining).code, 'CANCELLED')
  await waitUntil(async () => (await get(room.requests)).data.length === 0)
  t.pass('the room no longer lists it')
  t.is((await accept(room, request).catch((e) => e))?.code, 'UNKNOWN', 'nothing left to approve')
})

test('join: an open that timed out completes later, and its row reaches in', async (t) => {
  const { room, invite, a } = await twins(t)
  const err = await a.me._join(invite, 'team', { timeout: 300 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT')
  await accept(room, await nextRequest(room))
  await waitUntil(async () => (await get(a.me.team, room.id)).data?.state === 'in')
  t.pass('in once answered')
})

test('join: an app closed at asking and launched again completes the join', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await openHandle(t, { testnet })
  const room = await open(host.me.team, { name: 'clinic' })
  const invite = await cero.invite(room, { confirm: true })
  const { me, dir } = await ceroOpen(t, { testnet })
  const joining = open(me.team, invite).catch((e) => e)
  const request = await nextRequest(room)
  await me.close()
  t.is((await joining).code, 'CLOSED')
  await accept(room, request)
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 5 })
  await waitUntil(async () => (await get(again.team, room.id)).data?.state === 'in')
  const joined = await open(again.team, invite)
  t.is(joined.id, room.id, 'the launch carried it in')
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

test('Handle: revoke takes the id a room.invites row holds as well as the code', async (t) => {
  const { room, join } = await hosted(t, 'revoked')
  const code = await cero.invite(room, { role: 'member', ttl: 60_000 })
  const { data: rows } = await get(room.invites)
  t.is(await cero.revoke(room, rows[0].id), true, 'revoked by its id')
  t.is(await cero.revoke(room, code), false, 'and the code finds nothing left')
  await t.exception.all(join(code), /DENIED/)
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

test('Handle: me.topics reads one row by id, as a collection does', async (t) => {
  const { me } = await ceroOpen(t)
  await open(me.team, { name: 'clinic' })
  await waitUntil(async () => (await get(me.topics)).data.length === 1)
  const [row] = (await get(me.topics)).data
  t.alike((await get(me.topics, row.id)).data, row, 'a topic by its id')
  t.alike((await get(me.topics, { name: 'clinic' })).data, [row], 'a filter still lists')
  t.is((await get(me.topics, 'unknown')).data, null, 'an unknown topic reads null')
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
  const once = before.map((length) => length + 2)
  t.alike(
    rooms.map((room) => room.store.length),
    once,
    'one revoke in each, and the rotation it carries'
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

test('devices: a removed device that never sat in a room holds no key the room writes under once it is told, and a device linked after rotates nothing', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const phone = await linkTo(t, a)
  const row = () => phone.me.store.get('handles', room.id).then((res) => res.data)
  await waitUntil(async () => (await row())?.encryptionKey)
  const held = (await row()).encryptionKey
  t.alike(held, room.store.encryptionKey, 'the root handed the phone the room key')

  await del(a.me.devices, phone.me.device.id)
  await toldOf(room, phone)
  await put(room.messages, { text: 'post' })
  t.is(room.store.keyring.seq, 1, 'the room writes under a key minted after the removal')

  const tablet = await linkTo(t, a)
  const told = () => room.store.told(room.identity.id)
  await waitUntil(async () => names((await told()).standing, deviceKey(tablet)))
  await put(room.messages, { text: 'later' })
  t.is(room.store.keyring.seq, 1, 'a room told only of a new device keeps its key')
})

test('devices: a removed device that never sat in a room, of a member who may not remove, is rotated out by one who may', async (t) => {
  const { room, join, testnet } = await hosted(t, 'clinic')
  const b = await join(await cero.invite(room))
  const phone = await linkTo(t, { me: b.me, testnet })
  const row = () => phone.me.store.get('handles', room.id).then((res) => res.data)
  await waitUntil(async () => (await row())?.encryptionKey)

  await del(b.me.devices, phone.me.device.id)
  await toldOf(b.room, phone)
  await waitUntil(() => room.store.keyring.seq === 1)
  t.pass('the host rotates')
})

test('devices: a room its root closes under as it is told is left untold, with no error', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const phone = await linkTo(t, a)
  await seats(a.me, 2)
  const call = room.store.call.bind(room.store)
  let calls = 0
  room.store.call = async (...args) => {
    calls++
    a.me.close()
    await waitUntil(() => room.store.closed)
    return call(...args)
  }
  const prune = a.me._prune.bind(a.me)
  const tells = []
  a.me._prune = (...args) => {
    tells.push(prune(...args))
    return tells.at(-1)
  }

  await del(a.me.devices, phone.me.device.id)
  await a.me.close()
  t.is(calls, 1, 'the revoke was on its way')
  const results = await Promise.allSettled(tells)
  t.alike(
    results.map((r) => r.value),
    tells.map(() => false),
    'and each tell settles untold'
  )
})

test('devices: a device removed in the root is cut from the rooms open there as the removal resolves, and reads nothing written next', async (t) => {
  const laptop = await ceroOpen(t)
  const room = await open(laptop.me.team, { name: 'clinic' })
  const phone = await linkTo(t, laptop)
  const mine = await open(phone.me.team, { id: room.id })
  await waitUntil(() => mine.store.writable)
  await waitUntil(() => sits(room, phone))
  await put(room.messages, { text: 'pre' })
  await waitUntil(async () => (await get(mine.messages)).data.length === 1)

  await del(phone.me.devices, laptop.me.device.id)
  t.is(mine.store.keyring.seq, 1, 'the room holds its new key as the removal resolves')
  await put(mine.messages, { text: 'post' })
  const texts = (await get(mine.messages)).data.map((row) => row.text)
  t.alike(texts.sort(), ['post', 'pre'], 'the phone reads it')
  const key = mine.store.keyring.current
  t.absent(room.store.keyring.entropy(key), 'under a key the laptop does not hold')
  const { data } = await get(room.messages)
  t.alike(
    data.map((row) => row.text),
    ['pre'],
    'and the laptop reads nothing written after'
  )
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
  t.is(room.store.length, before + 2, 'told once, by the device that has it open, and rotated')
})

test('devices: a room made after a removal holds it from its first batch, and rotates nothing when it is told', async (t) => {
  const a = await ceroOpen(t)
  const phone = await linkTo(t, a)
  await seats(a.me, 2)
  await del(a.me.devices, phone.me.device.id)
  await passed(a.me)

  const room = await open(a.me.team, { name: 'clinic' })
  const told = await room.store.told(a.me.id)
  t.ok(names(told.removed, deviceKey(phone)), 'the removal is in the room')
  t.ok(names(told.standing, deviceKey(a)), 'with the device that stands')
  await a.me._pruneAll()
  await a.me._tellClosed()
  await room.store.rotation._audit()
  t.is(room.store.keyring.seq, 0, 'and no key rotated')
})

test('devices: a room only the removed device and a closed one had opened is told by a device that never opened it', async (t) => {
  const laptop = await ceroOpen(t)
  const phone = await linkTo(t, laptop)
  const lab = await open(phone.me.team, { name: 'lab' })
  await waitUntil(async () => (await laptop.me.store.get('handles', lab.id)).data?.encryptionKey)
  t.absent(await laptop.me._loadKeyPair(lab.id), 'the laptop never opened it')

  await del(laptop.me.devices, phone.me.device.id)
  await passed(laptop.me)
  const told = await toldOf(lab, phone)
  t.ok(names(told.standing, deviceKey(laptop)), 'the room is told, by the laptop')
  await waitUntil(() => !lab.store.writable)
  t.pass('and the phone holds no seat there')
  t.is(laptop.me.children.size + laptop.me._pending.size, 0, 'the laptop left it closed')
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

test('devices: two devices of the identity that tell a room at the same moment rotate it at most twice, and both read on', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const b = await ceroOpen(t, { testnet: a.testnet, phrase: await cero.phrase(a.me) })
  const mine = await open(b.me.team, { id: room.id })
  await waitUntil(() => mine.store.writable)
  const phone = await linkTo(t, a)
  await seats(a.me, 3)
  await seats(b.me, 3)
  // each decides to carry a rotation before the other's telling reaches it
  let arrived = 0
  let go = () => {}
  const both = new Promise((resolve) => (go = resolve))
  for (const { rotation } of [room.store, mine.store]) {
    const staying = rotation._staying.bind(rotation)
    rotation._staying = async (ops) => {
      const devices = await staying(ops)
      if (++arrived === 2) go()
      await both
      return devices
    }
  }

  await del(a.me.devices, phone.me.device.id)
  await Promise.all([toldOf(room, phone), toldOf(mine, phone)])
  const seq = () => [room.store.keyring.seq, mine.store.keyring.seq]
  await waitUntil(() => seq()[0] > 0 && seq()[0] === seq()[1])
  await put(room.messages, { text: 'laptop' })
  await put(mine.messages, { text: 'desk' })
  const texts = async (h) => (await get(h.messages)).data.map((row) => row.text).sort()
  await waitUntil(async () => (await texts(room)).length === 2 && (await texts(mine)).length === 2)
  t.alike(await texts(room), await texts(mine), 'each reads what the other writes')
  t.comment(`rotations: ${seq()}`)
  t.ok(Math.max(...seq()) <= 2, 'under one rotation each at most')
})

const MOVES = {
  asking: ['joining', 'denied', 'expired', 'cancelled'],
  joining: ['in', 'denied'],
  in: ['leaving', 'removed'],
  leaving: ['left', 'removed']
}
const ENDED = ['left', 'removed', 'denied', 'expired', 'cancelled']
const STATES = [...Object.keys(MOVES), ...ENDED]

// a handles row as a join writes it, with no room behind it
const standing = (id, state, invite = 'first') => ({
  id,
  type: 'team',
  key: b4a.from(id.padEnd(32, '.').slice(0, 32)),
  state,
  invite
})

const refused = (write) =>
  write.then(
    () => false,
    (err) => err.code === 'REFUSED' || Promise.reject(err)
  )

const states = async (me) =>
  Object.fromEntries((await me.store.get('handles')).data.map((row) => [row.id, row.state]))

// past the device's own check, as a device with an older picture appends it
async function behind(me, row) {
  const { wrap } = await import('../../../core/src/database/envelope.js')
  await me.store.bee.append(wrap(me.store.version, spec.dispatch.encode('@cero/add-handle', row)))
}

test('handles: a row changes state as its table allows and no other way, on the device and once the view is applied again', async (t) => {
  const errors = []
  const { me, dir, testnet } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  const write = (row) => me.store.set('handles', row)
  const stale = []

  for (const from of STATES) {
    for (const to of STATES) {
      const id = `${from}-${to}`
      await write(standing(id, from))
      // under the invite the row has, which lets a denied one in
      const ok = from === to || MOVES[from]?.includes(to) || `${from}-${to}` === 'denied-joining'
      t.is(await refused(write({ id, state: to })), !ok, `${from} to ${to}`)
      if (!ok) stale.push(standing(id, to))
    }
  }
  for (const end of ENDED) {
    const id = `${end}-again`
    await write(standing(id, end))
    t.ok(await refused(write({ id, state: 'asking', invite: null })), `${end} to asking, no invite`)
    t.absent(await refused(write({ id, state: 'asking', invite: 'second' })), 'and with a new one')
    await write(standing(`${end}-gone`, end))
    await me.store.del('handles', `${end}-gone`)
    t.absent((await get(me.handles, `${end}-gone`)).data, `${end} is deleted`)
  }
  await write(standing('denied-other', 'denied'))
  t.ok(
    await refused(write({ id: 'denied-other', state: 'joining', invite: 'second' })),
    'denied to joining under another invite'
  )
  stale.push({ ...standing('denied-other', 'joining'), invite: 'second' })
  t.ok(await refused(write(standing('unknown', 'paused'))), 'a state the table does not have')

  const before = await states(me)
  for (const row of stale) {
    const seen = errors.length
    await behind(me, row)
    await waitUntil(() => errors.length > seen)
  }
  t.ok(errors.every((err) => err.code === 'REFUSED'))
  await write(standing('last', 'asking'))
  t.alike(await states(me), { ...before, last: 'asking' }, 'apply refuses what the device refuses')

  await me.close()
  const meta = { ...spec.meta, rules: spec.meta.rules + 1 }
  const again = await cero(dir, { ...spec, meta }, { bootstrap: testnet.bootstrap, onerror() {} })
  t.teardown(() => again.close().catch(() => {}), { order: 5 })
  t.is((await again.store.dispatcher.built(again.store.view))[1], meta.rules, 'applied again')
  const kept = Object.entries(before).filter(([, state]) => state !== 'cancelled')
  t.alike(
    await states(again),
    { ...Object.fromEntries(kept), last: 'asking' },
    'every row stands where it stood, past a cancelled one the launch deleted'
  )
})

test('handles: an ended row is deleted through its type, and one in, leaving, asking or joining is refused', async (t) => {
  const { me } = await ceroOpen(t)
  for (const state of ['in', 'leaving', 'asking', 'joining', 'denied']) {
    await me.store.set('handles', standing(state, state))
  }
  for (const state of ['in', 'leaving', 'asking', 'joining']) {
    t.ok(await refused(del(me.team, state)), `refused while ${state}`)
  }
  await del(me.team, 'denied')
  t.absent((await get(me.team, 'denied')).data, 'gone once it is over')
})

test('handles: a row written with no state is stored in, and takes the changes in takes', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  t.is((await me.store.get('handles', room.id)).data.state, 'in', 'a room is stored in')
  t.is((await get(me.team, room.id)).data.state, 'in', 'read by id')
  t.alike(
    (await get(me.team)).data.map((row) => row.state),
    ['in'],
    'in a list'
  )
  t.is((await get(me.handles, room.id)).data.state, 'in', 'and among every handle')
  const stream = watch(me.team, room.id)
  t.teardown(() => stream.destroy())
  const [seen] = await new Promise((resolve) => stream.once('data', (snap) => resolve([snap])))
  t.is(seen.data.state, 'in', 'and by a watch')

  t.ok(await refused(me.store.set('handles', { id: room.id, state: 'joining' })), 'not to joining')
  t.ok(await refused(me.store.set('handles', { id: room.id, state: 'left' })), 'nor straight out')
  await me.store.set('handles', { id: room.id, name: 'renamed' })
  t.is((await get(me.team, room.id)).data.state, 'in', 'another field changes and it stays')
  await me.store.set('handles', { id: room.id, state: 'leaving' })
  t.is((await get(me.team, room.id)).data.state, 'leaving', 'in to leaving')
})

test('handles: two devices of one identity that write conflicting states end on the same row', async (t) => {
  const errors = { a: [], b: [] }
  const a = await ceroOpen(t, { onerror: (err) => errors.a.push(err.code) })
  await a.me.store.set('handles', standing('room', 'asking'))
  const b = await ceroOpen(t, {
    testnet: a.testnet,
    phrase: a.me.identity.toPhrase(),
    onerror: (err) => errors.b.push(err.code)
  })
  await waitUntil(async () => (await get(b.me.handles, 'room')).data && b.me.store.writable)

  await b.me.network.suspend()
  await a.me.store.set('handles', { id: 'room', state: 'joining' })
  await b.me.store.set('handles', { id: 'room', state: 'cancelled', reason: 'app' })
  await b.me.network.resume()

  const read = async ({ me }) => (await get(me.handles, 'room')).data
  // apart, each stands where it wrote: the same state is both logs in one order
  const row = await waitUntil(async () => {
    const [mine, theirs] = [await read(a), await read(b)]
    return mine.state === theirs.state ? mine : null
  })
  t.is(row.reason, row.state === 'cancelled' ? 'app' : null, 'the first of the two stands, whole')
  await waitUntil(() => errors.a.includes('REFUSED') && errors.b.includes('REFUSED'))
  t.pass('and both devices refused the other')
  t.is((await read(b)).state, row.state, 'for good')
})

test('handles: the rows asking, joining and leaving among 500 handles are read through the index, never a list of every handle', async (t) => {
  const { me } = await ceroOpen(t)
  const unsettled = ['asking', 'joining', 'leaving']
  await me.store.tx(async (tx) => {
    for (let i = 0; i < 500; i++) {
      const state = i % 100 === 0 ? unsettled[(i / 100) % 3] : i % 2 ? 'in' : undefined
      await tx.set('handles', standing(`room-${i}`, state))
    }
  })

  const found = []
  for (const state of unsettled) found.push(...(await get(me.handles, { state })).data)
  t.alike(
    found.map((row) => row.id).sort(),
    ['room-0', 'room-100', 'room-200', 'room-300', 'room-400'],
    'the five of 500'
  )

  // the same reads, counted on the view they are made against
  const paths = []
  const view = {
    find(path, range) {
      paths.push(path)
      return me.store.view.find(path, range)
    }
  }
  for (const state of unsettled) await me.store._read(view, 'handles', { state })
  t.alike(paths, Array(3).fill('@cero/handles-state'), 'one read of the index for each state')
})

test('handles: a rename from a device whose copy of the row is behind on the state is not refused and does not change the state', async (t) => {
  const errors = []
  const { me } = await ceroOpen(t, { onerror: (err) => errors.push(err) })
  await me.store.set('handles', standing('room', 'asking'))

  const sent = []
  const write = me.store.write
  me.store.write = (ops) => (sent.push(...ops), write.call(me.store, ops))
  await me.store.set('handles', { id: 'room', name: 'first' })
  me.store.write = write
  t.absent(sent[0][1].state, 'a rename sends no state')
  t.is((await get(me.handles, 'room')).data.state, 'asking', 'and the row stands where it stood')

  await me.store.set('handles', { id: 'room', state: 'denied', reason: 'full', by: 'ana' })
  // the rename of a device that still reads asking
  await behind(me, { ...standing('room'), name: 'renamed' })
  const row = await waitUntil(async () => {
    const { data } = await get(me.handles, 'room')
    return data.name === 'renamed' || errors.length ? data : null
  })
  t.is(row.name, 'renamed', 'the rename lands')
  t.alike([row.state, row.reason, row.by, row.invite], ['denied', 'full', 'ana', 'first'])
  t.alike(errors, [], 'and nothing was refused')
})

test('handles: a list is the rooms the identity is in, a state named lists the others, and an id reads any', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  for (const state of ['asking', 'left', 'denied']) {
    await me.store.set('handles', standing(state, state))
  }

  const ids = (res) => res.data.map((row) => row.id)
  t.alike(ids(await get(me.team)), [room.id], 'by type')
  t.alike(ids(await get(me.handles)), [room.id], 'among every handle')
  t.alike(ids(await get(me.team, { state: 'left' })), ['left'], 'a state named')
  t.alike(ids(await get(me.handles, { state: 'asking' })), ['asking'], 'among every handle')
  t.is((await get(me.team, 'denied')).data.state, 'denied', 'an id whatever its state')

  const stream = watch(me.team)
  t.teardown(() => stream.destroy())
  const seen = await new Promise((resolve) => stream.once('data', resolve))
  t.alike(ids(seen), [room.id], 'and by a watch')
})

test('handles: a page of one type among 500 with some left reads the rooms in through the index, with the exact total', async (t) => {
  const { me } = await ceroOpen(t)
  const teams = await addHandles(me, 250, 0, 'team')
  await addHandles(me, 250, 250, 'club')
  const gone = teams.filter((id, i) => i % 10 === 0)
  await me.store.tx(async (tx) => {
    for (const id of gone) {
      await tx.set('handles', { id, state: 'leaving' })
      await tx.set('handles', { id, state: 'left' })
    }
  })

  const reads = []
  const read = me.store._read
  me.store._read = function (view, name, query) {
    const find = (path, range) => (reads.push([path, range.limit]), view.find(path, range))
    return read.call(this, { find }, name, query)
  }
  const page = await get(me.team, { limit: 50, total: true })
  me.store._read = read
  t.is(page.data.length, 50, 'a page of 50')
  t.ok(
    page.data.every((row) => row.state === 'in'),
    'of rooms in'
  )
  t.is(page.total, 250 - gone.length, 'the exact total')
  t.alike(
    reads,
    [
      ['@cero/handles-type', 50],
      ['@cero/handles-type', undefined]
    ],
    'the page and its count from the index'
  )
})

test('handles: a row is deleted while in or leaving, never while asking or joining', async (t) => {
  const { me } = await ceroOpen(t)
  for (const state of ['asking', 'joining']) {
    await me.store.set('handles', standing(state, state))
    t.ok(await refused(me.store.del('handles', state)), `not while ${state}`)
    t.is((await get(me.handles, state)).data.state, state, 'it stays')
  }
  const room = await open(me.team, { name: 'clinic' })
  await me.store.set('handles', standing('named', 'in'))
  await me.store.set('handles', standing('leaving', 'leaving'))
  for (const id of [room.id, 'named', 'leaving']) {
    await me.store.del('handles', id)
    t.absent((await get(me.handles, id)).data, 'gone')
  }
})

test('handles: a launch deletes a cancelled row, and a denied, expired, removed or left one once it is over 30 days old', async (t) => {
  const { me, dir, testnet } = await ceroOpen(t)
  const relaunch = async (was) => {
    await was.close()
    const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
    t.teardown(() => again.close().catch(() => {}), { order: 5 })
    return again
  }
  const day = 24 * 60 * 60 * 1000
  const aged = async (store, id, days) => {
    const { data: row } = await store.get('handles', id)
    const at = Date.now() - days * day
    await store.call('add-handle', { ...row, updatedAt: at })
    t.is((await store.get('handles', id)).data.updatedAt, at, `${id} written ${days} days ago`)
  }
  await me.store.set('handles', standing('cancelled', 'cancelled'))
  await me.store.set('handles', { ...standing('denied', 'denied'), reason: 'full' })
  await me.store.set('handles', { ...standing('month', 'denied'), reason: 'full' })
  await aged(me.store, 'month', 29)
  for (const state of ['expired', 'removed', 'left']) {
    await me.store.set('handles', standing(state, state))
    await aged(me.store, state, 31)
  }

  const next = await relaunch(me)
  const read = async (id) => (await get(next.handles, id)).data
  t.absent(await read('cancelled'), 'a cancel is gone')
  for (const state of ['expired', 'removed', 'left']) {
    t.absent(await read(state), `${state} is gone`)
  }
  const denied = await read('denied')
  t.alike(
    [denied?.state, denied?.reason],
    ['denied', 'full'],
    'a denied row stays, with its reason'
  )
  t.is((await read('month'))?.state, 'denied', 'a denied row 29 days old stays')
  await aged(next.store, 'denied', 31)

  const last = await relaunch(next)
  t.absent((await get(last.handles, 'denied')).data, 'and is gone over 30 days old')
  t.ok((await get(last.handles, 'month')).data, 'the younger one stays')
})

test('handles: a cancel no peer took goes at a launch once it is over 30 days old', async (t) => {
  const { me, dir, testnet } = await ceroOpen(t)
  const retract = Handle.prototype._retract
  Handle.prototype._retract = async () => true
  t.teardown(() => {
    Handle.prototype._retract = retract
  })
  const at = Date.now() - 31 * 24 * 60 * 60 * 1000
  await me.store.set('handles', standing('young', 'cancelled'))
  await me.store.set('handles', standing('old', 'cancelled'))
  const { data: row } = await me.store.get('handles', 'old')
  await me.store.call('add-handle', { ...row, updatedAt: at })
  await me.close()

  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 5 })
  t.ok((await get(again.handles, 'young')).data, 'a cancel still owed stays')
  t.absent((await get(again.handles, 'old')).data, 'and goes over 30 days old')
})

test('Handle: a page of one type reads through its index the rows, in the order, that filtering every handle gives', async (t) => {
  const { me } = await ceroOpen(t)
  for (const [type, count] of Object.entries({ team: 7, club: 5, room: 6 })) {
    await addHandles(me, count, 0, type)
  }
  await addHandles(me, 4, 7, 'team')
  await me.store.set('handles', { id: (await me.store.get('handles')).data[0].id, name: 'renamed' })
  const every = (await me.store.get('handles')).data
  const filtered = every.filter((row) => row.type === 'team').sort((a, b) => a.index - b.index)
  const ids = (rows) => rows.map((row) => row.id)

  const reads = []
  const read = me.store.get.bind(me.store)
  me.store.get = (name, query) => {
    if (name === 'handles') reads.push(query)
    return read(name, query)
  }
  t.alike(ids((await get(me.team)).data), ids(filtered), 'the whole list')
  t.alike(ids((await get(me.team, { limit: 4 })).data), ids(filtered.slice(0, 4)), 'a page')
  const back = await get(me.team, { limit: 4, reverse: true, total: true })
  t.alike(ids(back.data), ids(filtered.slice(-4).reverse()), 'a page from the end')
  t.is(back.total, filtered.length, 'and the count of the type')
  const after = filtered[2].id
  const past = filtered.filter((row) => row.id > after)
  t.alike(ids((await get(me.team, { gt: after })).data), ids(past), 'a range of ids')

  const stream = watch(me.team, { limit: 3, reverse: true })
  t.teardown(() => stream.destroy())
  const [first] = await new Promise((resolve) => stream.once('data', (res) => resolve([res])))
  t.alike(ids(first.data), ids(filtered.slice(-3).reverse()), 'a watch of the type')
  t.ok(
    reads.every((query) => query.type === 'team'),
    'each read asks the store for the type'
  )
})

const builds = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '.build-typed')
process.on('exit', () => rmSync(builds, { recursive: true, force: true }))

test('Handle: a store written before the index of the handles by type lists its rooms by type', async (t) => {
  const sch = schema({
    room: { notes: T.collection({ text: T.string }) },
    club: { notes: T.collection({ text: T.string }) }
  })
  // the spec as a release with no such index built it
  const shipped = async (dir) => {
    rmSync(dir, { recursive: true, force: true })
    const { indexes } = defs.main.handles
    delete defs.main.handles.indexes
    try {
      await build(dir, sch, { extensions: [] })
    } finally {
      defs.main.handles.indexes = indexes
    }
  }
  const load = async (dir) => (await import(pathToFileURL(join(dir, 'index.js')).href)).spec
  await shipped(join(builds, 'before'))
  const before = await load(join(builds, 'before'))

  const testnet = await makeTestnet(t)
  const store = await t.tmp()
  const opts = { bootstrap: testnet.bootstrap, extensions: [] }
  const first = await cero(store, before, opts)
  for (const n of [1, 2, 3]) {
    await open(first.room, { name: `room ${n}` })
    await open(first.club, { name: `club ${n}` })
  }
  await first.close()

  // the app's next build, over the spec it shipped
  await shipped(join(builds, 'now'))
  await build(join(builds, 'now'), sch, { extensions: [] })
  const now = await load(join(builds, 'now'))
  t.not(now.database.versions.db, before.database.versions.db, 'the index changes the database')
  const me = await cero(store, now, opts)
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const page = await get(me.room, { limit: 2, reverse: true, total: true })
  t.alike(
    page.data.map((row) => row.name),
    ['room 3', 'room 2'],
    'the rooms written before it'
  )
  t.is(page.total, 3)
  t.alike(
    (await get(me.club)).data.map((row) => row.name),
    ['club 1', 'club 2', 'club 3']
  )
})

test('handles: a join denied after its keys arrived keeps no key on its row and no topics row, and a push about it is not verified', async (t) => {
  const { me: owner, testnet } = await ceroOpen(t)
  const room = await open(owner.team, { name: 'clinic' })
  await put(room.messages, { text: 'hi' })
  const { me } = await ceroOpen(t, { testnet })
  const topic = b4a.toHex(room.store.discoveryKey)
  const invite = await cero.invite(room)
  const withdraw = async () => {
    await waitUntil(async () => (await me.local.store.get('topics', topic)).data)
    const promised = await waitUntil(
      async () => (await get(room.requests)).data.find((r) => r.promised) || null
    )
    await deny(room, promised, 'not you')
  }
  const err = await refusedAtClaim(t, me, me.team, invite, withdraw)
  t.is(err.code, 'DENIED')
  const { data: row } = await get(me.team, room.id)
  t.is(row.state, 'denied')
  t.absent(row.encryptionKey, 'no key on its row')
  t.absent(row.epochs, 'nor its epochs')
  await me._indexing
  t.absent((await me.local.store.get('topics', topic)).data, 'no topics row')
  const payload = encode(
    await createNotification(room.store.bee.local, {
      roomKey: room.store.key,
      extra: b4a.from('messages')
    })
  )
  t.is(await receive(me, payload), null, 'a push about it is not verified')
})

test('handles: a topics row is kept for a handle in or joining, and dropped once it leaves', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  const topic = b4a.toHex(room.store.discoveryKey)
  await waitUntil(async () => (await me.local.store.get('topics', topic)).data)
  await me.store.set('handles', { id: room.id, state: 'leaving' })
  await waitUntil(async () => !(await me.local.store.get('topics', topic)).data)
  t.ok((await get(me.team, room.id)).data.encryptionKey, 'its row still has the key')
})

// one identity on two devices, both seated in a host's room
async function seatedTwins(t) {
  const testnet = await makeTestnet(t)
  const host = await openHandle(t, { testnet })
  const room = await open(host.me.team, { name: 'clinic' })
  const invite = await cero.invite(room)
  const a = await openHandle(t, { testnet })
  const b = await openHandle(t, { testnet, identity: a.identity, key: a.me.store.key })
  await b.me.store.bootstrap({ recovering: true })
  const onA = await open(a.me.team, invite)
  await waitUntil(async () => (await get(b.me.team, room.id)).data?.encryptionKey)
  const onB = await open(b.me.team, { id: room.id })
  t.teardown(() => onB.close().catch(() => {}))
  const states = (me) => {
    const seen = []
    const off = me.store.onUpdate('handles', async () => {
      const state = (await get(me.team, room.id)).data?.state
      if (state && seen.at(-1) !== state) seen.push(state)
    })
    t.teardown(off)
    return seen
  }
  return { host, room, a, b, onA, onB, states }
}

test('leave: the row reads leaving, then is gone on every device of the identity once the room holds the removal', async (t) => {
  const { room, a, b, onA, states } = await seatedTwins(t)
  const seen = [states(a.me), states(b.me)]
  await cero.leave(onA)
  for (const me of [a.me, b.me]) {
    await waitUntil(async () => !(await get(me.team, room.id)).data)
  }
  for (const s of seen) t.alike(s, ['leaving'], 'leaving, then gone')
  t.is(await room.store.removed(a.identity.id), 'left', 'the room holds her leaving')
})

test('leave: an app closed while leaving goes on at the next launch', async (t) => {
  const { me: host, testnet } = await ceroOpen(t)
  const room = await open(host.team, { name: 'clinic' })
  const { me, dir } = await ceroOpen(t, { testnet })
  const joined = await open(me.team, await cero.invite(room))
  await waitUntil(async () => (await get(room.members, me.identity.id)).data)
  me._carryOn = async () => {}
  await cero.leave(joined)
  t.is((await get(me.team, room.id)).data.state, 'leaving')
  await me.close()
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 5 })
  await waitUntil(async () => !(await get(again.team, room.id)).data)
  t.is(await room.store.removed(me.identity.id), 'left', 'the launch carried it out')
})

test('removed: a removal by an admin reads removed with her id in by, and the row keeps no key', async (t) => {
  const { host, room, a, b } = await seatedTwins(t)
  await del(room.members, a.identity.id)
  for (const me of [a.me, b.me]) {
    const row = await waitUntil(async () => {
      const { data } = await get(me.team, room.id)
      return data?.state === 'removed' ? data : null
    })
    t.is(row.by, host.identity.id, 'by the admin')
    t.absent(row.encryptionKey, 'no key')
  }
})

test('removed: a device removed from a room opens it with a new invite: the open is refused, and its identity stays in', async (t) => {
  const { room, a, b, onA, onB, states } = await seatedTwins(t)
  const seen = states(a.me)
  await del(room.devices, hid.encode(onB.store.writerKey))
  await waitUntil(() => !onB.store.writable || null)

  const err = await open(b.me.team, await cero.invite(room)).catch((e) => e)
  t.is(err?.code, 'DENIED', 'the open is refused')
  t.is(err?.reason, 'removed')
  t.is((await get(a.me.team, room.id)).data.state, 'in', 'the row stays in on her other device')
  t.ok(
    seen.every((state) => state === 'in'),
    'and never moved'
  )
  await put(onA.messages, { text: 'still here' })
  await waitUntil(async () => (await get(room.messages)).data.some((m) => m.text === 'still here'))
  t.pass('her other device still writes in the room')
  const wrong = await a.me._join(await cero.invite(room), 'ward').catch((e) => e)
  t.is(wrong?.code, 'INVALID', 'an open as another type is refused')
  t.is((await get(a.me.team, room.id)).data.state, 'in', 'and writes no state')
})

test('leave: a room left is joined again with a new invite, and a row at removed is deleted by the app', async (t) => {
  const { room, a, onA } = await seatedTwins(t)
  await cero.leave(onA)
  await waitUntil(async () => !(await get(a.me.team, room.id)).data)
  // a code minted after she left brings her back
  const back = await open(a.me.team, await cero.invite(room))
  t.teardown(() => back.close().catch(() => {}))
  t.is((await get(a.me.team, room.id)).data.state, 'in', 'in again')
  await waitUntil(async () => (await get(room.members, a.identity.id)).data)
  await del(room.members, a.identity.id)
  await waitUntil(async () => (await get(a.me.team, room.id)).data?.state === 'removed')
  await a.me.store.del('handles', room.id)
  t.absent((await get(a.me.team, room.id)).data, 'deleted')
})

test('status: owed is true while this device waits for the keys it asked for, and false once it holds them', async (t) => {
  const { host, room, join } = await hosted(t, 'keys')
  const joined = await join(await cero.invite(room))
  t.is((await get(joined.room.status)).data.owed, false)
  const seen = []
  cero.watch(joined.room.status).on('data', ({ data }) => seen.push(data.owed))

  // the next key sealed to the host's device alone, and a write under it
  const { data: devices } = await room.store.get('devices')
  const own = devices.filter((d) => d.memberId === host.identity.id)
  await room.store.rotation._rotate(false, own)
  await put(room.messages, { text: 'under' })
  await waitUntil(async () => seen.includes(true) || null)
  t.pass('owed once it asked')
  await waitUntil(async () => (await get(joined.room.messages)).data.length === 1 || null)
  await waitUntil(async () => (await get(joined.room.status)).data.owed === false || null)
  t.pass('and not once it was sent them, and reads what was written under them')
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
  const seen = { tellings: 0, lists: 0, opened: 0, rooms: [] }
  const { call, get: read } = Database.prototype
  const ready = Handle.prototype._open
  Database.prototype.call = function (op, data) {
    if (op === 'revoke') {
      seen.tellings++
      onrevoke(this)
    }
    return call.call(this, op, data)
  }
  Database.prototype.get = function (name, query) {
    // the joins and leaves are read through the index by state, never as a list of every handle
    if (name === 'handles' && typeof query !== 'string' && query?.state === undefined) seen.lists++
    return read.call(this, name, query)
  }
  Handle.prototype._open = function () {
    if (this.parent) {
      seen.opened++
      seen.rooms.push(this)
    }
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
  t.is(seen.lists, 0, 'and reads no list of the handles')
  t.alike(handed, [], 'none handed to the app')
  t.is(me.children.size + me._pending.size, 0, 'and none left open')
  await me.close()
  await toldAtOpen(t, a, ids, phone)
})

test('devices: a close while the pass tells rooms resolves with every room it opened closed, and the next launch goes on', async (t) => {
  const { a, ids, phone } = await closedRooms(t)
  const errors = []
  const me = await relaunch(t, a, { onerror: (err) => errors.push(err) })
  let closing = null
  const first = await tally(
    async () => {
      await del(me.devices, phone.me.device.id)
      await waitUntil(() => closing !== null)
      await closing
    },
    () => (closing ??= me.close())
  )
  t.ok(first.rooms.length > 0, 'the pass had rooms open')
  t.ok(
    first.rooms.every((room) => room.closed && room.store.closed),
    'every one closed, its store too, when the close resolves'
  )
  t.alike(errors, [], 'nothing reported')

  const seen = await tally(async () => {
    const again = await relaunch(t, a)
    await passed(again)
    await again.close()
  })
  t.ok(seen.opened > 0, 'the next launch goes on with nothing changed')
  await toldAtOpen(t, a, ids, phone)
})

test('devices: a launch with nothing changed since its rooms were told reads no list of the handles and opens none', async (t) => {
  const { a, phone } = await closedRooms(t)
  const me = await relaunch(t, a)
  await del(me.devices, phone.me.device.id)
  await passed(me)
  await me.close()

  const seen = await tally(async () => {
    const again = await relaunch(t, a)
    await again._telling
  })
  t.is(seen.lists, 0, 'no list of the handles')
  t.is(seen.opened, 0, 'no room opened')
})

test('devices: a room this device holds no writer in is opened by its pass, which seats it there, and not again at the next pass', async (t) => {
  const a = await ceroOpen(t)
  const room = await open(a.me.team, { name: 'clinic' })
  const b = await ceroOpen(t, { testnet: a.testnet, phrase: await cero.phrase(a.me) })
  const phone = await linkTo(t, a)
  await seats(b.me, 3)
  await waitUntil(async () => (await b.me.store.get('handles', room.id)).data)

  const seen = await tally(async () => {
    await del(a.me.devices, phone.me.device.id)
    await passed(b.me)
    await toldOf(room, phone)
  })
  t.is(seen.opened, 1, 'the device without a writer there opens it')
  t.is(seen.lists, 0, 'through the index by state')
  t.ok(await sits(room, b), 'and takes a seat')
  await b.me.close()
  const again = await tally(async () => {
    const next = await relaunch(t, b)
    await next._telling
  })
  t.is(again.opened, 0, 'the next launch opens none')
})

test('devices: a rename after a removal was told opens no room this device holds no writer in', async (t) => {
  const a = await ceroOpen(t)
  const b = await ceroOpen(t, { testnet: a.testnet, phrase: await cero.phrase(a.me) })
  const phone = await linkTo(t, a)
  await seats(b.me, 3)
  await del(a.me.devices, phone.me.device.id)
  await passed(b.me)
  const room = await open(a.me.team, { name: 'clinic' })
  await waitUntil(async () => (await b.me.store.get('handles', room.id)).data)

  const seen = await tally(async () => {
    await set(b.me.profile, { name: 'bo' })
    await waitUntil(async () => (await get(room.members, a.me.id)).data?.name === 'bo')
    await b.me._telling
  })
  t.is(seen.opened, 0, 'the room made after the removal stays closed there')
})

test('devices: a room whose telling throws is told at the next pass, and only it', async (t) => {
  const { a, phone } = await closedRooms(t)
  const errors = []
  const me = await relaunch(t, a, { onerror: (err) => errors.push(err) })
  let attempts = 0
  let failing = null
  await tally(
    async () => {
      await del(me.devices, phone.me.device.id)
      await waitUntil(() => attempts >= 3)
      await me._telling
    },
    (store) => {
      attempts++
      failing ??= store.key
      if (b4a.equals(store.key, failing)) throw new Error('lost')
    }
  )
  t.ok(errors.length > 0, 'the failure reported')
  await me.close()

  const seen = await tally(async () => {
    const again = await relaunch(t, a)
    await again._telling
    await passed(again)
  })
  t.is(seen.opened, 1, 'the next pass opens the room it failed')
  t.is(seen.tellings, 1, 'and tells it')
})

test('devices: a room open when the pass runs is told by its open and not again by the pass', async (t) => {
  const { a, ids, phone } = await closedRooms(t)
  const me = await relaunch(t, a)
  const room = await open(me.team, { id: ids[0] })
  await waitUntil(() => room.store.writable)
  const seen = await tally(async () => {
    await del(me.devices, phone.me.device.id)
    await passed(me)
    await me._pruneAll()
  })
  t.is(seen.tellings, 3, 'each room told once')
  t.is(seen.opened, 2, 'the pass opens the closed ones')
  await me.close()

  const again = await tally(async () => {
    const next = await relaunch(t, a)
    await next._telling
  })
  t.is(again.opened, 0, 'and the next launch opens none')
})

test('profile: a rename reaches the member row of a room closed on this device, a member there reads it, and a launch with nothing changed reads no list of its rooms', async (t) => {
  const a = await ceroOpen(t, { keepOpen: 0 })
  await set(a.me.profile, { name: 'alice' })
  const room = await open(a.me.team, { name: 'clinic' })
  const { me: b } = await ceroOpen(t, { testnet: a.testnet })
  const theirs = await open(b.team, await cero.invite(room, { role: 'member' }))
  const named = (want) =>
    waitUntil(async () => (await get(theirs.members, a.me.identity.id)).data?.name === want)
  await named('alice')
  await room.close()
  t.is(a.me.children.size, 0, 'the room is closed here')

  const seen = await tally(async () => {
    await set(a.me.profile, { name: 'alice north' })
    await named('alice north')
  })
  t.is(seen.opened, 1, 'the pass opened the closed room')
  t.is(seen.lists, 0, 'and read no list of the handles')
  await a.me.close()

  let listed = 0
  const { get: read } = Storage.prototype
  Storage.prototype.get = function (name, query) {
    if (name === 'handle-keypairs' && typeof query !== 'string') listed++
    return read.call(this, name, query)
  }
  try {
    const next = await relaunch(t, a)
    await next._telling
    await next.close()
  } finally {
    Storage.prototype.get = read
  }
  t.is(listed, 0, 'a launch with nothing changed reads no list of its rooms')
})

test('handles: a room the identity is in is not deleted through its type', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'clinic' })
  t.ok(await refused(del(me.team, room.id)), 'refused while in')
  t.ok((await get(me.team, room.id)).data, 'the row stays')
})

test('join: a cancel made just before the app closes takes the request back after it launches again', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await openHandle(t, { testnet })
  const room = await open(host.me.team, { name: 'clinic' })
  const invite = await cero.invite(room, { confirm: true })
  const { me, dir } = await ceroOpen(t, { testnet })
  const joining = open(me.team, invite).catch((e) => e)
  const request = await nextRequest(room)
  await cero.suspend(host.me)
  t.ok(await cero.cancel(me, invite))
  t.is((await joining).code, 'CANCELLED')
  await me.close()
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 5 })
  const row = (await get(again.team, room.id)).data
  t.is(row?.state, 'cancelled', 'its row stays while the room is owed the cancel')
  await cero.resume(host.me)
  await waitUntil(async () => (await get(room.requests)).data.length === 0, 10000).catch(() => {})
  t.is((await accept(room, request).catch((e) => e))?.code, 'UNKNOWN', 'nothing left to approve')
  await waitUntil(async () => !(await again.local.store.get('handle-keypairs', room.id)).data)
  t.pass('and its writer goes once the room holds it')
})

test('join: a cancel held after the app asked again under another invite leaves that join its writer', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await openHandle(t, { testnet })
  const room = await open(host.me.team, { name: 'clinic' })
  const first = await cero.invite(room, { confirm: true })
  const second = await cero.invite(room, { confirm: true })
  const { me, dir } = await ceroOpen(t, { testnet })
  const joining = open(me.team, first).catch((e) => e)
  const request = await nextRequest(room)
  await cero.suspend(host.me)
  t.ok(await cero.cancel(me, first))
  t.is((await joining).code, 'CANCELLED')
  open(me.team, second).catch(() => {})
  const asked = async () => (await me.local.store.get('handle-keypairs', room.id)).data
  await waitUntil(async () => (await asked())?.invite === second)
  await cero.resume(host.me)
  const next = await nextRequest(room, request)
  await waitUntil(async () => !(await get(room.requests)).data.some((r) => r.id === request.id))
  t.is((await asked())?.invite, second, 'the writer of the join under the other invite stays')
  await me.close()
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 5 })
  await accept(room, next)
  await waitUntil(async () => (await get(again.team, room.id)).data?.state === 'in')
  t.pass('and it lands after a launch')
})
