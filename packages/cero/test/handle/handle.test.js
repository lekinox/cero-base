import test from 'brittle'
import b4a from 'b4a'

import { Identity } from '@cero-base/core/identity'

import { Handle, Ref } from '../../src/handle/index.js'
import { put, set, get, del, open, rotate, watch, changes, after } from '../../src/lib/operators.js'
import { spec } from '../fixtures/spec/index.js'
import {
  makeStore,
  makeTestnet,
  makeNet,
  waitForConnection,
  waitUntil,
  fetch
} from '../helpers/index.js'

// ─── Phase 4: root getter, fileServer, blobs, files ops ─────────────────────

test.configure({ timeout: 90000 })

const teamSpec = spec.handles.team

async function ceroOpen(t, opts = {}) {
  const { store } = await makeStore(t)
  const identity = opts.identity || (await Identity.generate())
  const testnet = opts.testnet || (await makeTestnet(t))
  const net = await makeNet(t, testnet)
  const discovery = net.join(identity.topic)
  await discovery.flush()
  const me = new Handle({ store, identity, network: net, spec, ...opts })
  await me.ready()
  if (!opts.key) await me.bootstrap({ name: opts.name || null })
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

// ─── admission guards (B3.2) ──────────────────────────────────────────────

test('open: accept:false survives a reopen — the gate does not re-arm', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'gated', accept: false })
  t.is(room.pair.listenerCount('candidate'), 0, 'created with no auto-accept')

  const id = room.id
  await room.close()
  const again = await open(me.team, { id, accept: false })
  t.is(again.pair.listenerCount('candidate'), 0, 'still gated after a reopen')

  await again.close()
  const armed = await open(me.team, { id })
  t.ok(armed.pair.listenerCount('candidate') > 0, 'and re-arms when the caller asks for it')
})

test('accept: rejects an expired invite', async (t) => {
  const { me } = await ceroOpen(t)
  const candidate = {
    userData: b4a.alloc(64),
    invite: { expired: true, role: 'member' },
    confirm: async () => {}
  }
  await t.exception.all(me.accept(candidate), /expired/i)
})

test('accept: rejects a role exceeding the invite role', async (t) => {
  const { me } = await ceroOpen(t)
  const candidate = {
    userData: b4a.alloc(64),
    invite: { expired: false, role: 'member' },
    confirm: async () => {}
  }
  await t.exception.all(me.accept(candidate, { role: 'owner' }), /exceeds/i)
})

test('accept: rejects a role that is not a rank, before any key is revealed', async (t) => {
  const { me } = await ceroOpen(t)
  let confirmed = false
  const candidate = {
    userData: b4a.alloc(64),
    invite: { expired: false, role: '' },
    confirm: async () => {
      confirmed = true
    }
  }
  // an app role name grants nothing at apply — it must fail loudly here
  await t.exception.all(me.accept(candidate, { role: 'volunteer' }), /not a rank/i)
  t.absent(confirmed, 'refused before confirm() handed over the keys')
})

test('invite: refuses a role that is not a rank', async (t) => {
  const { me } = await ceroOpen(t)
  const room = await open(me.team, { name: 'capped' })
  await t.exception(room.invite({ role: 'volunteer' }), /not a rank/i)
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

// ─── lifecycle ────────────────────────────────────────────────────────────

test('Handle: opens and closes', async (t) => {
  const { me } = await ceroOpen(t)
  t.is(me.opened, true)
  t.ok(me.pair, 'pair instance attached')
  await me.close()
  t.is(me.closed, true)
})

// ─── ref attachment ───────────────────────────────────────────────────────

test('Handle: attaches user + builtin + handle-kind refs', async (t) => {
  const { me } = await ceroOpen(t)
  t.ok(me.profile instanceof Ref, 'user single')
  t.ok(me.messages instanceof Ref, 'user collection')
  t.ok(me.members instanceof Ref, 'builtin members')
  t.ok(me.devices instanceof Ref, 'builtin devices')
  t.ok(me.team instanceof Ref, 'handle-kind ref')
  t.is(me.team.kind, 'handle')
})

test('Handle: ref carries handle + name + kind', async (t) => {
  const { me } = await ceroOpen(t)
  t.is(me.messages.handle, me)
  t.is(me.messages.name, 'messages')
  t.is(me.messages.kind, 'collection')
})

// ─── bootstrap ────────────────────────────────────────────────────────────

test('Handle: bootstrap on fresh', async (t) => {
  const { store } = await makeStore(t)
  const identity = await Identity.generate()
  const net = await makeNet(t, await makeTestnet(t))
  const me = new Handle({ store, identity, network: net, spec })
  await me.ready()
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  await me.bootstrap({ name: 'desktop' })
  t.is(me.store.writable, true)
  t.is((await get(me.members)).data.length, 1, 'bootstrap enrolls the owner')
})

// ─── operators ────────────────────────────────────────────────────────────

test('Handle: put/get on a collection', async (t) => {
  const { me } = await ceroOpen(t)
  await me.bootstrap()
  const { data: row } = await put(me.messages, { text: 'hi' })
  t.ok(row.id)
  t.is(row.text, 'hi')
  const { data: list } = await get(me.messages)
  t.is(list.length, 1)
})

test('Handle: operators reject CLOSED after close', async (t) => {
  const { me } = await ceroOpen(t)
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
  const { me } = await ceroOpen(t)
  await me.bootstrap()
  await set(me.profile, { name: 'jb' })
  const { data } = await get(me.profile)
  t.is(data.name, 'jb')
})

test('Handle: a named child names the room, not the creator device', async (t) => {
  const { me } = await ceroOpen(t)
  await me.bootstrap({ name: 'my-laptop' })
  const team = await open(me.team, { name: 'General' })
  t.teardown(() => team.close().catch(() => {}))

  t.is(team.name, 'General', 'the child handle carries the room name')

  const { data: devices } = await get(team.devices)
  t.is(devices.length, 1, 'just the creator device')
  t.absent(devices[0].name, 'creator device is NOT mislabeled with the room name')
})

test('Handle: t.extend adds a field to the member builtin', async (t) => {
  const { me } = await ceroOpen(t)
  await me.bootstrap()
  const avatar = b4a.from([7, 8, 9])
  await me.store.call('add-member', {
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

test('Handle: second device claims and syncs', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()

  const a = await ceroOpen(t, { testnet, identity })
  await a.me.bootstrap({ name: 'a' })
  await a.me.store.call('add-member', {
    id: identity.id,
    key: a.me.store.writerKey, // writer hypercore key — backlinks device → member
    role: 'owner',
    name: 'a',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  await put(a.me.messages, { text: 'from-a' })

  const b = await ceroOpen(t, { testnet, identity, key: a.me.store.key })

  await waitForConnection(a.net)
  await waitForConnection(b.net)

  await b.me.bootstrap({ recovering: true })
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
  const testnet = await makeTestnet(t)

  const { store: hostStore } = await makeStore(t)
  const hostId = await Identity.generate()
  const hostNet = await makeNet(t, testnet, hostId)
  const room = new Handle({
    store: hostStore,
    identity: hostId,
    network: hostNet,
    spec: teamSpec,
    namespace: 'cero/team',
    keyPair: Identity.randomKeyPair()
  })
  await room.ready()
  t.teardown(() => room.close().catch(() => {}))

  await room.bootstrap({ name: 'host' })
  await put(room.messages, { text: 'host-msg' })

  room.pair.on('candidate', async (cand) => {
    try {
      await room.accept(cand, { role: 'reader' })
    } catch (e) {
      t.fail('candidate accept failed: ' + e.message)
    }
  })

  const inviteStr = await room.invite({ role: 'reader' })
  const readerId = await Identity.generate()
  const { store: readerStore } = await makeStore(t)
  const readerNet = await makeNet(t, testnet, readerId)

  const reader = await Handle.join(inviteStr, {
    network: readerNet,
    identity: readerId,
    store: readerStore,
    spec: teamSpec,
    namespace: 'cero/team',
    timeout: 20_000
  })
  await reader.ready()
  t.teardown(() => reader.close().catch(() => {}))

  await waitForConnection(hostNet)
  await waitForConnection(readerNet)

  await waitUntil(async () => {
    const { data } = await get(reader.messages)
    return data.length > 0 ? true : null
  })
  const { data: list } = await get(reader.messages)
  t.is(list[0].text, 'host-msg', 'reader can read host messages')

  await t.exception.all(() => put(reader.messages, { text: 'should fail' }), /not writable/i)
})

test('Handle: rotate cuts a removed member off from new data, late joiners read everything', async (t) => {
  const testnet = await makeTestnet(t)

  const { store: hostStore } = await makeStore(t)
  const hostId = await Identity.generate()
  const hostNet = await makeNet(t, testnet, hostId)
  const room = new Handle({
    store: hostStore,
    identity: hostId,
    network: hostNet,
    spec: teamSpec,
    namespace: 'cero/team',
    keyPair: Identity.randomKeyPair(),
    encryptionKey: Identity.randomBytes(32)
  })
  await room.ready()
  t.teardown(() => room.close().catch(() => {}))
  await room.bootstrap({ name: 'host' })
  await room.store.call('add-member', {
    id: hostId.id,
    key: room.store.writerKey,
    role: 'owner',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  room.pair.on('candidate', (cand) => room.accept(cand).catch((e) => t.fail(e.message)))

  const joinRoom = async (name) => {
    const id = await Identity.generate()
    const { store } = await makeStore(t)
    const net = await makeNet(t, testnet, id)
    const h = await Handle.join(await room.invite(), {
      network: net,
      identity: id,
      store,
      spec: teamSpec,
      namespace: 'cero/team',
      timeout: 20_000
    })
    await h.ready()
    t.teardown(() => h.close().catch(() => {}))
    return { h, id, net }
  }

  await put(room.messages, { text: 'before' })
  const stays = await joinRoom('stays')
  const leaves = await joinRoom('leaves')
  await waitForConnection(hostNet)

  const sees = (h, text) =>
    waitUntil(async () => {
      const { data } = await get(h.messages)
      return data.some((r) => r.text === text) ? true : null
    })
  await sees(stays.h, 'before')
  await sees(leaves.h, 'before')

  await del(room.members, leaves.id.id)
  const { epoch } = await rotate(room)
  t.is(epoch, 1, 'operator opens epoch 1')
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

  const late = await joinRoom('late')
  await sees(late.h, 'before')
  await sees(late.h, 'after')
  // the join itself may trigger a self-healing rotation, so epoch 1 is a lower bound
  t.ok(
    late.h.store.keyring.all().some((e) => e.epoch === 1),
    'join delivered the rotation epoch via confirm'
  )
})

test('Handle: files rotate with the room — cross-member reads, epoch cutoff, legacy passthrough', async (t) => {
  const testnet = await makeTestnet(t)

  const { store: hostStore } = await makeStore(t)
  const hostId = await Identity.generate()
  const hostNet = await makeNet(t, testnet, hostId)
  const room = new Handle({
    store: hostStore,
    identity: hostId,
    network: hostNet,
    spec: teamSpec,
    namespace: 'cero/team',
    keyPair: Identity.randomKeyPair(),
    encryptionKey: Identity.randomBytes(32)
  })
  await room.ready()
  t.teardown(() => room.close().catch(() => {}))
  await room.bootstrap({ name: 'host' })
  await room.store.call('add-member', {
    id: hostId.id,
    key: room.store.writerKey,
    role: 'owner',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  room.pair.on('candidate', (cand) => room.accept(cand).catch((e) => t.fail(e.message)))

  // the reader is a proper root + child room: its ROOT key differs from the
  // room key, which is exactly the shape where blob cores must resolve with
  // the room's key (registering them under the root key serves garbage)
  const m = await ceroOpen(t, { testnet })
  await m.me.bootstrap({ name: 'member-root' })
  const member = await open(m.me.team, await room.invite())
  t.teardown(() => member.close().catch(() => {}))
  await waitForConnection(hostNet)
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

  const a = await ceroOpen(t, { testnet })
  await a.me.bootstrap({ name: 'a-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))

  const joinAsRoot = async () => {
    const peer = await ceroOpen(t, { testnet })
    await peer.me.bootstrap({ name: 'peer-root' })
    const child = await open(peer.me.team, await room.invite())
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
  t.is(epoch, 1, 'nested child rotates through the operator')
  await put(room.messages, { text: 'after' })

  // late joiner through a nested child reads everything (confirm delivery)
  const c = await joinAsRoot()
  await sees(c.room, 'before')
  await sees(c.room, 'after')
  t.is(c.room.store.keyring.seq, 1, 'nested late joiner received the epoch at join')

  const { data: bSees } = await get(b.room.messages)
  t.alike(
    bSees.map((r) => r.text),
    ['before'],
    'removed nested member frozen at the cut'
  )

  // reopen the rotated child by id via the parent's handles row — the row
  // carries only key+encryptionKey, so epochs must prime from local userData
  const roomId = room.id
  await room.close()
  const reopened = await open(a.me.team, { id: roomId })
  t.teardown(() => reopened.close().catch(() => {}))
  t.is(reopened.store.keyring.seq, 1, 'reopened child primed its keyring from userData')
  const { data: reread } = await get(reopened.messages)
  t.alike(reread.map((r) => r.text).sort(), ['after', 'before'], 'reopened child reads every era')
})

// ─── nested rotation: healer, files, devices, watch ────────────────────────

async function nestedRoom(t, testnet) {
  const a = await ceroOpen(t, { testnet })
  await a.me.bootstrap({ name: 'owner-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))
  const joinAsRoot = async () => {
    const peer = await ceroOpen(t, { testnet })
    await peer.me.bootstrap({ name: 'peer-root' })
    const child = await open(peer.me.team, await room.invite())
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
  t.pass('healer re-keyed the nested child on its own')

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
  const identity = await Identity.generate()

  const a = await ceroOpen(t, { testnet, identity })
  await a.me.bootstrap({ name: 'device-1' })
  await a.me.store.call('add-member', {
    id: identity.id,
    key: a.me.store.writerKey,
    role: 'owner',
    name: 'a',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const room = await open(a.me.team, { name: 'clinic' })
  t.teardown(() => room.close().catch(() => {}))
  await put(room.messages, { text: 'before' })
  await rotate(room)
  await put(room.messages, { text: 'after' })

  const b = await ceroOpen(t, { testnet, identity, key: a.me.store.key })
  await waitForConnection(a.net)
  await waitForConnection(b.net)
  await b.me.bootstrap({ recovering: true })

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

test('Handle: subscriptions are rotation-transparent — changes, hooks, removed stays silent', async (t) => {
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
  const changeStream = changes(b.room.messages)
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
  t.pass('changes() stream delivered post-rotation rows without resubscribing')

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
  const feed = changes(observer.room.members)
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
  t.pass('observer received the removal as a changes delete event')

  await waitUntil(() => (snapshots.some((s) => !s.includes(victim.identity.id)) ? true : null))
  t.pass('the removed member was notified of their own removal before the cut')
  t.absent(own.destroyed, 'and their stream stays open — silent, not broken')
})

test('Handle: removal fires unwritable on the victim and onApply on observers', async (t) => {
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
  // none, so onApply is what tells an observer about a removal
  const applied = []
  const off = observer.room.store.onApply(({ op, name, row }) => {
    if (op === 'del' && name === 'member') applied.push(row.id)
  })
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
  t.pass('observer saw the replicated removal via onApply')
  t.absent(afterFired, 'after() does not fire on membership rows')
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
  const bob2 = await open(bob.me.team, await room.invite())
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
  const invite = await room.invite() // minted at epoch 0
  await rotate(room)
  await put(room.messages, { text: 'after' })

  const peer = await ceroOpen(t, { testnet })
  await peer.me.bootstrap({ name: 'late' })
  const joined = await open(peer.me.team, invite) // redeemed at epoch 1
  t.teardown(() => joined.close().catch(() => {}))
  await waitForConnection(a.net)

  await sees(joined, 'before')
  await sees(joined, 'after')
  t.is(joined.store.keyring.seq, 1, 'confirm delivered the epochs current at accept time')
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

  // the member removes THEMSELVES (allowed) — the admin's healer must re-key
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
  const a = await ceroOpen(t, { testnet })
  await a.me.bootstrap({ name: 'root' })
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

test('Handle: invite + Handle.join + atomic admission', async (t) => {
  const testnet = await makeTestnet(t)

  const { store: hostStore } = await makeStore(t)
  const hostId = await Identity.generate()
  const hostNet = await makeNet(t, testnet, hostId)
  const room = new Handle({
    store: hostStore,
    identity: hostId,
    network: hostNet,
    spec: teamSpec,
    namespace: 'cero/team',
    keyPair: Identity.randomKeyPair()
  })
  await room.ready()
  t.teardown(() => room.close().catch(() => {}))

  await room.bootstrap({ name: 'host' })
  await put(room.messages, { text: 'from-host' })

  room.pair.on('candidate', async (cand) => {
    try {
      await room.accept(cand, { role: 'member' })
    } catch (e) {
      t.fail('candidate accept failed: ' + e.message)
    }
  })

  const inviteStr = await room.invite({ role: 'member', expiresIn: 60_000 })

  const joinerId = await Identity.generate()
  const { store: joinerStore } = await makeStore(t)
  const joinerNet = await makeNet(t, testnet, joinerId)

  const joiner = await Handle.join(inviteStr, {
    network: joinerNet,
    identity: joinerId,
    store: joinerStore,
    spec: teamSpec,
    namespace: 'cero/team',
    timeout: 20_000
  })
  await joiner.ready()
  t.teardown(() => joiner.close().catch(() => {}))

  await waitForConnection(hostNet)
  await waitForConnection(joinerNet)
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
  const testnet = await makeTestnet(t)

  const { store: hostStore } = await makeStore(t)
  const hostId = await Identity.generate()
  const hostNet = await makeNet(t, testnet, hostId)
  const room = new Handle({
    store: hostStore,
    identity: hostId,
    network: hostNet,
    spec: teamSpec,
    namespace: 'cero/team-revoke',
    keyPair: Identity.randomKeyPair()
  })
  await room.ready()
  t.teardown(() => room.close().catch(() => {}))

  await room.bootstrap({ name: 'host' })

  const inviteStr = await room.invite({ role: 'member', expiresIn: 60_000 })
  t.is(await room.revoke(inviteStr), true, 'revoke returns true the first time')
  t.is(await room.revoke(inviteStr), false, 'revoke returns false the second time')

  const joinerId = await Identity.generate()
  const { store: joinerStore } = await makeStore(t)
  const joinerNet = await makeNet(t, testnet, joinerId)

  await t.exception.all(
    Handle.join(inviteStr, {
      network: joinerNet,
      identity: joinerId,
      store: joinerStore,
      spec: teamSpec,
      namespace: 'cero/team-revoke-joiner',
      timeout: 2000
    }),
    /TIMEOUT|timed out/i
  )
})

// ─── Phase 4: root getter + coreKey→handle registry ──────────────────────────

test('Handle: root getter — root returns self, child returns the root', async (t) => {
  const { me } = await ceroOpen(t)
  await me.bootstrap({ name: 'desktop' })
  t.is(me.root, me, 'root handle is its own root')

  const child = await me._create('team', { name: 'T' })
  t.teardown(() => child.close().catch(() => {}))
  t.is(child.root, me, 'child resolves to the top handle')
  t.is(child.parent, me, 'parent is still the direct parent')
})

test('Handle: root owns the coreKey→encryptionKey registry', async (t) => {
  const { me } = await ceroOpen(t)
  await me.bootstrap({ name: 'desktop' })
  const child = await me._create('team', { name: 'T' })

  const key = child.store.key
  const hex = b4a.toString(key, 'hex')
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
  const { me, identity } = await ceroOpen(t)
  await me.bootstrap({ name: 'desktop' })

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
  const { me } = await ceroOpen(t)
  await me.bootstrap({ name: 'desktop' })

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

  const stranger = await Identity.generate()
  t.is(me._resolveCore(stranger.publicKey, {}), null, 'unknown core → null (404)')
})

test('Handle: fileServer closes with the root', async (t) => {
  const { me } = await ceroOpen(t)
  await me.bootstrap({ name: 'desktop' })
  const fs = me.fileServer
  t.ok(fs.port > 0)
  await me.close()
  t.is(me._fileServer, null, 'fileServer dropped on close')
})

// ─── Phase 4: blobs ───────────────────────────────────────────────────────────

test('Handle: blobs — lazy, per-handle, round-trips bytes', async (t) => {
  const { me } = await ceroOpen(t)
  await me.bootstrap({ name: 'desktop' })

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
  const { me } = await bootstrapWithMember(t)

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

async function bootstrapWithMember(t) {
  const { me, identity } = await ceroOpen(t)
  await me.bootstrap({ name: 'desktop' })
  const ts = Date.now()
  await me.store.call('add-member', {
    id: identity.id,
    key: me.store.writerKey,
    role: 'owner',
    name: null,
    createdAt: ts,
    updatedAt: ts
  })
  return { me, identity }
}

test('files: set(profile, { avatar: file.id }) → get(profile) yields avatar as a resolved file', async (t) => {
  const { me } = await bootstrapWithMember(t)

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
  const { me } = await bootstrapWithMember(t)

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

test('files: a reader cannot add a file', async (t) => {
  const testnet = await makeTestnet(t)

  const { store: hostStore } = await makeStore(t)
  const hostId = await Identity.generate()
  const hostNet = await makeNet(t, testnet, hostId)
  const room = new Handle({
    store: hostStore,
    identity: hostId,
    network: hostNet,
    spec: teamSpec,
    namespace: 'cero/team-files',
    keyPair: Identity.randomKeyPair()
  })
  await room.ready()
  t.teardown(() => room.close().catch(() => {}))

  await room.bootstrap({ name: 'owner' })

  room.pair.on('candidate', async (cand) => {
    try {
      await room.accept(cand, { role: 'reader' })
    } catch (e) {
      t.fail('candidate accept failed: ' + e.message)
    }
  })

  const inviteStr = await room.invite({ role: 'reader' })
  const readerId = await Identity.generate()
  const { store: readerStore } = await makeStore(t)
  const readerNet = await makeNet(t, testnet, readerId)

  const reader = await Handle.join(inviteStr, {
    network: readerNet,
    identity: readerId,
    store: readerStore,
    spec: teamSpec,
    namespace: 'cero/team-files-reader',
    timeout: 20_000
  })
  await reader.ready()
  t.teardown(() => reader.close().catch(() => {}))

  await waitForConnection(hostNet)
  await waitForConnection(readerNet)
  await waitUntil(async () => {
    const { data } = await get(reader.members)
    return data.length > 0 ? true : null
  })

  await t.exception.all(
    put(reader.files, { data: b4a.from('nope'), type: 'text/plain', name: 'x.txt' }),
    /not writable/i,
    'a reader is refused'
  )
  const { data } = await get(reader.files)
  t.is(data.length, 0, 'no file row landed')
})

test('changes: deltas flow with file fields resolved on both sides', async (t) => {
  const { me } = await bootstrapWithMember(t)

  const stream = changes(me.profile)
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
  const { me } = await ceroOpen(t)
  await me.bootstrap()

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
