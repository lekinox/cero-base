import test from 'brittle'
import b4a from 'b4a'
import z32 from 'z32'

import { Database } from '../../src/database/index.js'
import { Identity } from '../../src/identity/index.js'
import { Network } from '../../src/network/index.js'
import { wrap } from '../../src/database/envelope.js'
import { makeStore, makeTestnet, randomTopic, waitForConnection } from '../helpers/index.js'
import hid from 'hypercore-id-encoding'
import { genId, admission, ownership } from '../../src/lib/utils.js'
import { spec } from '../fixtures/spec/index.js'

test.configure({ timeout: 60000 })

async function bootstrapped(t, opts = {}) {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = opts.identity || (await Identity.generate())
  const db = new Database({ store, identity, spec, ...opts })
  await db.ready()
  await db.bootstrap({ name: 'first', isMobile: false })
  t.teardown(() => db.close().catch(() => {}), { order: 5 })
  return { db, store, identity }
}

// ─── add-writer: signature verification ───────────────────────────────────

test('add-writer with a forged signature is rejected (no device row, writer not admitted)', async (t) => {
  const { db, identity } = await bootstrapped(t)
  const intruder = Identity.randomKeyPair()
  const forgedSig = b4a.alloc(64)

  await db.call('add-writer', {
    master: identity.publicKey,
    writer: intruder.publicKey,
    sig: forgedSig,
    name: 'attacker',
    isMobile: false
  })

  const { data: device } = await db.get('devices', z32.encode(intruder.publicKey))
  t.absent(device, 'no device row was created')
})

// ─── writer/member authorization ──────────────────────────────────────────

async function withRole(t, role) {
  const { db, identity } = await bootstrapped(t)
  await db.call('add-member', {
    id: identity.id,
    key: db.writerKey,
    role,
    name: 'me',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  return { db, identity }
}

function addWriterOp(identity, appenderKey, dbKey) {
  const writer = Identity.randomKeyPair()
  return {
    op: {
      master: identity.publicKey,
      writer: writer.publicKey,
      sig: identity.sign(admission(dbKey, writer.publicKey, appenderKey)),
      name: 'w',
      isMobile: false
    },
    writer
  }
}

test('add-writer: a reader cannot admit a writer', async (t) => {
  const { db, identity } = await withRole(t, 'reader')
  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await t.exception(db.call('add-writer', op), /REFUSED/, 'a reader cannot admit')
  t.absent(
    (await db.get('devices', z32.encode(writer.publicKey))).data,
    'a reader cannot self-promote / admit'
  )
})

test('add-writer: a member can admit a writer', async (t) => {
  const { db, identity } = await withRole(t, 'member')
  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', op)
  t.ok((await db.get('devices', z32.encode(writer.publicKey))).data, 'a writer may admit')
})

test('add-writer: genesis (empty members table) is allowed', async (t) => {
  const { db, identity } = await bootstrapped(t) // no member yet → genesis
  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', op)
  t.ok(
    (await db.get('devices', z32.encode(writer.publicKey))).data,
    'room creation admits the genesis writer'
  )
})

// an admission signature binds the db key, so one captured in room A
// cannot verify in room B
test('admission signed for another db is rejected (domain separation)', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const foreign = b4a.alloc(32, 7)

  const writer = Identity.randomKeyPair()
  await db.call('add-writer', {
    master: identity.publicKey,
    writer: writer.publicKey,
    sig: identity.sign(admission(foreign, writer.publicKey, db.writerKey)),
    name: 'replayed',
    isMobile: false
  })
  t.absent(
    (await db.get('devices', z32.encode(writer.publicKey))).data,
    'cross-db add-writer replay rejected'
  )

  const claimed = Identity.randomKeyPair()
  await db.call('claim-writer', {
    identity: identity.publicKey,
    writer: claimed.publicKey,
    sig: identity.sign(ownership(foreign, claimed.publicKey)),
    name: 'replayed',
    isMobile: false
  })
  t.absent(
    (await db.get('devices', z32.encode(claimed.publicKey))).data,
    'cross-db claim-writer replay rejected'
  )
})

// ─── role hierarchy: can only grant a role you hold ───────────────────────

function inviteOp(role) {
  return {
    id: genId(),
    key: Identity.randomKeyPair().publicKey,
    role,
    name: 'v',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

test('add-member: an admin cannot invite an owner', async (t) => {
  const { db } = await withRole(t, 'admin')
  const v = inviteOp('owner')
  await t.exception(db.call('add-member', v), /REFUSED/)
  t.absent((await db.get('members', v.id)).data, 'admin cannot grant owner')
})

test('add-member: a member cannot invite an admin', async (t) => {
  const { db } = await withRole(t, 'member')
  const v = inviteOp('admin')
  await t.exception(db.call('add-member', v), /REFUSED/)
  t.absent((await db.get('members', v.id)).data, 'member cannot grant admin')
})

test('add-member: a reader cannot invite a member', async (t) => {
  const { db } = await withRole(t, 'reader')
  const v = inviteOp('member')
  await t.exception(db.call('add-member', v), /REFUSED/)
  t.absent((await db.get('members', v.id)).data, 'reader has no invite')
})

test('add-member: an admin can invite a member', async (t) => {
  const { db } = await withRole(t, 'admin')
  const v = inviteOp('member')
  await db.call('add-member', v)
  t.ok((await db.get('members', v.id)).data, 'admin can grant member')
})

test('set-member: an admin cannot promote a member to owner', async (t) => {
  const { db } = await withRole(t, 'admin')
  const v = inviteOp('member')
  await db.call('add-member', v)
  t.ok((await db.get('members', v.id)).data, 'member invited')

  await t.exception(db.call('set-member', { ...v, role: 'owner' }), /REFUSED/)
  t.is((await db.get('members', v.id)).data.role, 'member', 'role not escalated to owner')
})

test('del-member: only an owner can evict (a member cannot)', async (t) => {
  const victimMember = async (db) => {
    const v = await Identity.generate()
    await db.call('add-member', {
      id: v.id,
      key: Identity.randomKeyPair().publicKey,
      role: 'member',
      name: 'v',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    return v
  }

  const w = await withRole(t, 'member')
  const v1 = await victimMember(w.db)
  await t.exception(w.db.call('del-member', { id: v1.id }), /REFUSED/)
  t.ok((await w.db.get('members', v1.id)).data, 'a member could not evict')

  const o = await withRole(t, 'owner')
  const v2 = await victimMember(o.db)
  await o.db.call('del-member', { id: v2.id })
  t.absent((await o.db.get('members', v2.id)).data, 'an owner evicted the member')
})

test('claim-writer: a reader cannot claim writership', async (t) => {
  const { db, identity } = await withRole(t, 'reader')
  const newWriter = Identity.randomKeyPair()
  await db.call('claim-writer', {
    identity: identity.publicKey,
    writer: newWriter.publicKey,
    sig: identity.sign(ownership(db.key, newWriter.publicKey)),
    name: 'x',
    isMobile: false
  })
  t.absent(
    (await db.get('devices', z32.encode(newWriter.publicKey))).data,
    'a reader cannot claim writership'
  )
})

// ─── del-member: removal hierarchy ────────────────────────────────────────

test('del-member: an admin cannot evict a peer admin', async (t) => {
  const { db } = await withRole(t, 'admin')
  const v = inviteOp('admin')
  await db.call('add-member', v)
  t.ok((await db.get('members', v.id)).data, 'peer admin added')

  await t.exception(db.call('del-member', { id: v.id }), /REFUSED/)
  t.ok((await db.get('members', v.id)).data, 'an admin could not evict a peer admin')
})

// ─── del-writer: removal hierarchy + self-removal ─────────────────────────

function delWriterOp(writer) {
  return {
    master: Identity.randomKeyPair().publicKey,
    writer,
    sig: b4a.alloc(64),
    name: null,
    isMobile: false
  }
}

test("del-writer: a member cannot remove another member's writer", async (t) => {
  const { db } = await withRole(t, 'member')
  const v = inviteOp('member')
  await db.call('add-member', v)
  await t.exception(db.call('del-writer', delWriterOp(v.key)), /REFUSED/)
  t.ok((await db.get('devices', z32.encode(v.key))).data, 'a member could not remove the writer')
})

test("del-writer: an owner removes a member's writer", async (t) => {
  const { db } = await withRole(t, 'owner')
  const v = inviteOp('member')
  await db.call('add-member', v)
  await db.call('del-writer', delWriterOp(v.key))
  t.absent((await db.get('devices', z32.encode(v.key))).data, 'owner removed the writer')
})

test('del-writer: a member can remove its own writer (self)', async (t) => {
  const { db, identity } = await withRole(t, 'member')
  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', op)
  await db.call('del-writer', delWriterOp(writer.publicKey))
  t.absent((await db.get('devices', z32.encode(writer.publicKey))).data, 'self-removal allowed')
})

// ─── fast-forward trust ───────────────────────────────────────────────────

// autobee trusts every fast-forward candidate unless a hook says otherwise —
// a removed device could serve a stale or forked head and we would boot onto it
test('fast-forward: a head is only trusted while its writer is a device', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const live = addWriterOp(identity, db.writerKey, db.key)
  const gone = addWriterOp(identity, db.writerKey, db.key)

  await db.call('add-writer', live.op)
  await db.call('add-writer', gone.op)
  await db.call('del-writer', delWriterOp(gone.writer.publicKey))

  const trusted = (key) => db.bee.trusted.isTrusted(key, db.view)

  t.ok(await trusted(db.writerKey), 'our own writer is trusted')
  t.ok(await trusted(live.writer.publicKey), 'an admitted device is trusted')
  t.absent(await trusted(gone.writer.publicKey), 'a removed device is refused')
  t.absent(await trusted(Identity.randomKeyPair().publicKey), 'an unknown writer is refused')
})

test('fast-forward: an empty reference trusts only the genesis writer', async (t) => {
  const { db: other } = await bootstrapped(t)

  // a fresh db pre-bootstrap: its view has no device rows yet
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = await Identity.generate()
  const fresh = new Database({ store, identity, spec })
  await fresh.ready()
  t.teardown(() => fresh.close().catch(() => {}), { order: 5 })

  t.ok(
    await fresh.bee.trusted.isTrusted(fresh.key, fresh.view),
    'genesis writer vouches for itself pre-devices'
  )
  t.absent(
    await fresh.bee.trusted.isTrusted(other.writerKey, fresh.view),
    'any other writer stays refused against an empty view'
  )
})

// ─── claim-writer: signature verification ─────────────────────────────────

test('claim-writer with a forged signature is rejected', async (t) => {
  const { db, identity } = await bootstrapped(t)
  await db.call('add-member', {
    id: identity.id,
    key: db.writerKey,
    role: 'owner',
    name: 'me',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const newWriter = Identity.randomKeyPair()
  const forgedSig = b4a.alloc(64)

  await db.call('claim-writer', {
    identity: identity.publicKey,
    writer: newWriter.publicKey,
    sig: forgedSig,
    name: 'second-device',
    isMobile: false
  })

  const { data: device } = await db.get('devices', z32.encode(newWriter.publicKey))
  t.absent(device, 'forged claim-writer did not admit a writer')
})

test('claim-writer without a matching member is rejected even with valid signature', async (t) => {
  const { db, identity } = await bootstrapped(t)
  const newWriter = Identity.randomKeyPair()
  const sig = identity.sign(ownership(db.key, newWriter.publicKey))

  await db.call('claim-writer', {
    identity: identity.publicKey,
    writer: newWriter.publicKey,
    sig,
    name: 'orphan',
    isMobile: false
  })

  const { data: device } = await db.get('devices', z32.encode(newWriter.publicKey))
  t.absent(device, 'no member entry means no admission')
})

// ─── encryption: wrong key cannot read ────────────────────────────────────

test("opening a bee with the wrong encryption key cannot decode another peer's rows", async (t) => {
  const { store: storeA } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const idA = await Identity.generate()
  const a = new Database({
    store: storeA,
    identity: idA,
    spec,
    encryptionKey: Identity.randomBytes(32)
  })
  await a.ready()
  t.teardown(() => a.close().catch(() => {}), { order: 5 })
  await a.bootstrap({ name: 'a' })
  await a.put('messages', { text: 'secret' })

  const { store: storeB } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const idB = await Identity.generate()
  const wrongKey = Identity.randomBytes(32)
  const b = new Database({
    store: storeB,
    identity: idB,
    spec,
    key: a.key,
    encryptionKey: wrongKey
  })
  await b.ready()
  t.teardown(() => b.close().catch(() => {}), { order: 5 })

  await b.bee.update()
  const { data } = await b.get('messages')
  t.is(data.length, 0, 'b sees no messages — cannot decrypt with the wrong key')
})

// ─── identity verification: tamper detection ──────────────────────────────

test('Identity.verify rejects a signature signed over different bytes', async (t) => {
  const id = await Identity.generate()
  const original = b4a.from('hello world')
  const tampered = b4a.from('hello WORLD')
  const sig = id.sign(original)
  t.ok(Identity.verify(id.publicKey, original, sig), 'valid')
  t.absent(Identity.verify(id.publicKey, tampered, sig), 'tamper rejected')
})

// ─── collection writes require WRITE at apply, on every peer ──────────────

test("collections: a demoted writer cannot overwrite or delete another member's row", async (t) => {
  const { db, identity } = await withRole(t, 'owner')

  // admit a second member, then demote them to reader (they keep the writer
  // seat — set-member does not revoke it, which is exactly why apply must gate)
  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', { ...op, ts: Date.now() })
  const memberId = hid.encode(writer.publicKey)
  const row = { id: memberId, key: writer.publicKey, name: 'b', createdAt: 1, updatedAt: 1 }
  await db.call('add-member', { ...row, role: 'member' })
  await db.call('set-member', { ...row, role: 'reader', updatedAt: Date.now() })
  t.is((await db.get('members', memberId)).data.role, 'reader', 'demoted')
  t.ok((await db.get('devices', memberId)).data, 'but still holds a writer seat')

  const { data: mine } = await db.put('messages', { text: 'owner-phi' })

  // the demoted writer's ops are applied here with their key as the signer
  const asDemoted = (verb, payload) =>
    db.dispatcher
      .dispatch(db.spec.dispatch.encode(`@${db.ns}/${verb}`, payload), {
        view: db.view,
        host: {},
        key: writer.publicKey,
        dbKey: db.key
      })
      .then(
        () => null,
        (err) => err
      )

  const overwrite = await asDemoted('set-messages', { id: mine.id, text: 'tampered' })
  t.is(overwrite?.code, 'REFUSED', 'overwrite refused at apply')
  t.is((await db.get('messages', mine.id)).data.text, 'owner-phi', 'and the row is untouched')

  const del = await asDemoted('del-messages', { id: mine.id })
  t.is(del?.code, 'REFUSED', 'delete refused at apply')
  t.ok((await db.get('messages', mine.id)).data, 'and the row survives')
})

test('collections: memberId is derived from the signer, never merged off the wire', async (t) => {
  const { db, identity } = await withRole(t, 'owner')

  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', { ...op, ts: Date.now() })
  const attacker = hid.encode(writer.publicKey)
  await db.call('add-member', {
    id: attacker,
    key: writer.publicKey,
    role: 'member',
    name: 'b',
    createdAt: 1,
    updatedAt: 1
  })

  const { data: mine } = await db.put('messages', { text: 'owner-phi' })

  // a real writer edits the row and claims the edit was the owner's
  await db.dispatcher.dispatch(
    db.spec.dispatch.encode(`@${db.ns}/set-messages`, {
      id: mine.id,
      text: 'edited',
      memberId: identity.id
    }),
    { view: db.view, host: {}, key: writer.publicKey, dbKey: db.key }
  )

  const { data: after } = await db.get('messages', mine.id)
  t.is(after.text, 'edited', 'the edit itself is allowed — they may write')
  t.is(after.memberId, attacker, 'but it is credited to the signer, not the victim')
})

// ─── set-member takes an intent, not a row ────────────────────────────────

test('set-member: a member cannot rename another member or overwrite their key', async (t) => {
  const { db, identity } = await withRole(t, 'owner')

  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', { ...op, ts: Date.now() })
  const attacker = hid.encode(writer.publicKey)
  await db.call('add-member', {
    id: attacker,
    key: writer.publicKey,
    role: 'member',
    name: 'b',
    createdAt: 1,
    updatedAt: 1
  })

  const { data: before } = await db.get('members', identity.id)

  await db.dispatcher.dispatch(
    db.spec.dispatch.encode(`@${db.ns}/set-member`, {
      id: identity.id,
      key: writer.publicKey, // try to swap the owner's admitted key for our own
      role: 'owner',
      name: 'PWNED',
      createdAt: 1,
      updatedAt: Date.now()
    }),
    { view: db.view, host: { removeWriter: () => {} }, key: writer.publicKey, dbKey: db.key }
  )

  const { data: after } = await db.get('members', identity.id)
  t.is(after.name, before.name, 'the name is untouched')
  t.alike(after.key, before.key, 'and so is the key the member was admitted with')
})

test('set-member: a member may still rename itself', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  await db.call('set-member', {
    id: identity.id,
    key: db.writerKey,
    role: 'owner',
    name: 'renamed',
    createdAt: 1,
    updatedAt: Date.now()
  })
  t.is((await db.get('members', identity.id)).data.name, 'renamed')
})

// ─── `own` collections: the author's rows are the author's ────────────────

test("own: a member cannot edit or delete another member's row", async (t) => {
  const { db, identity } = await withRole(t, 'owner')

  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', { ...op, ts: Date.now() })
  await db.call('add-member', {
    id: hid.encode(writer.publicKey),
    key: writer.publicKey,
    role: 'member',
    name: 'b',
    createdAt: 1,
    updatedAt: 1
  })

  const { data: mine } = await db.put('records', { text: 'owner-note' })

  const asAttacker = (verb, payload) =>
    db.dispatcher
      .dispatch(db.spec.dispatch.encode(`@${db.ns}/${verb}`, payload), {
        view: db.view,
        host: {},
        key: writer.publicKey,
        dbKey: db.key
      })
      .then(
        () => null,
        (err) => err
      )

  t.is(
    (await asAttacker('set-records', { id: mine.id, text: 'x' }))?.code,
    'REFUSED',
    'edit refused'
  )
  t.is((await asAttacker('del-records', { id: mine.id }))?.code, 'REFUSED', 'delete refused')
  // `add` on an existing id is an overwrite — it must not slip past `own`
  t.is(
    (await asAttacker('add-records', { id: mine.id, text: 'x' }))?.code,
    'REFUSED',
    'add-as-overwrite refused'
  )
  t.is((await db.get('records', mine.id)).data.text, 'owner-note', 'the row is untouched')
})

test('own: the author edits its own row, and REMOVE moderates the rest', async (t) => {
  const { db, identity } = await withRole(t, 'owner')

  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', { ...op, ts: Date.now() })
  await db.call('add-member', {
    id: hid.encode(writer.publicKey),
    key: writer.publicKey,
    role: 'member',
    name: 'b',
    createdAt: 1,
    updatedAt: 1
  })

  const asMember = (verb, payload) =>
    db.dispatcher.dispatch(db.spec.dispatch.encode(`@${db.ns}/${verb}`, payload), {
      view: db.view,
      host: {},
      key: writer.publicKey,
      dbKey: db.key
    })

  const id = genId()
  await asMember('add-records', { id, text: 'theirs' })
  await asMember('set-records', { id, text: 'edited by its author' })
  t.is((await db.get('records', id)).data.text, 'edited by its author', 'the author may edit')

  // the owner holds REMOVE, so moderation still works
  await db.dispatcher.dispatch(db.spec.dispatch.encode(`@${db.ns}/del-records`, { id }), {
    view: db.view,
    host: {},
    key: db.writerKey,
    dbKey: db.key
  })
  t.absent((await db.get('records', id)).data, 'an owner may moderate it away')
})

// ─── a batch is atomic at apply ───────────────────────────────────────────

test('apply: one refused op discards its whole batch, on every peer', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })
  await a.db.call('add-member', {
    id: a.db.identity.id,
    key: a.db.writerKey,
    role: 'owner',
    name: 'a',
    createdAt: 1,
    updatedAt: 1
  })

  const bIdentity = await Identity.generate()
  const b = await makeNetworked(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  await a.db.addWriter(b.db.keyPair.publicKey)
  await waitUntil(() => b.db.writable)
  await a.db.call('add-member', {
    id: bIdentity.id,
    key: b.db.writerKey,
    role: 'member',
    name: 'b',
    createdAt: 1,
    updatedAt: 1
  })

  const { data: owned } = await a.db.put('records', { text: 'owner-note' })
  await waitUntil(async () => (await b.db.get('records', owned.id)).data)

  // A modified peer skips its own dry-run, so the batch reaches apply. The
  // ALLOWED op goes first: it has already written into the transaction by the
  // time the refusal lands, which is the only way to observe the discard.
  b.db._dryRun = async () => true
  await b.db.write([
    ['add-records', { id: 'sibling', text: 'legit', createdAt: 1, updatedAt: 1 }],
    ['set-records', { id: owned.id, text: 'tampered' }]
  ])

  // let the batch replicate and apply on A
  await waitUntil(
    async () => ((await a.db.get('records', 'sibling')).data ? true : null),
    3000
  ).catch(() => null)

  t.is(
    (await a.db.get('records', owned.id)).data.text,
    'owner-note',
    'the refused op changed nothing'
  )
  t.absent((await a.db.get('records', 'sibling')).data, 'its sibling was discarded with it — on A')
  t.absent((await b.db.get('records', 'sibling')).data, 'and on B, the writer itself')
})

test('apply: a discarded batch admits no writer — host effects roll back with the rows', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })
  await a.db.call('add-member', {
    id: a.db.identity.id,
    key: a.db.writerKey,
    role: 'owner',
    name: 'a',
    createdAt: 1,
    updatedAt: 1
  })

  const bIdentity = await Identity.generate()
  const b = await makeNetworked(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)
  await a.db.addWriter(b.db.keyPair.publicKey)
  await waitUntil(() => b.db.writable)
  await a.db.call('add-member', {
    id: bIdentity.id,
    key: b.db.writerKey,
    role: 'member',
    name: 'b',
    createdAt: 1,
    updatedAt: 1
  })
  const { data: owned } = await a.db.put('records', { text: 'owner-note' })
  await waitUntil(async () => (await b.db.get('records', owned.id)).data)

  // B may admit a writer (INVITE) — and in the same batch touches a row it
  // may not. The batch is discarded. `addWriter` is a host call, not a row:
  // if it is not rolled back with the rows, the joiner is a writer with no
  // device row, which the WRITE gate reads as "not yet enrolled" and admits.
  const joiner = Identity.randomKeyPair()
  b.db._dryRun = async () => true
  await b.db.write([
    [
      'add-writer',
      {
        master: bIdentity.publicKey,
        writer: joiner.publicKey,
        sig: bIdentity.sign(admission(a.db.key, joiner.publicKey, b.db.writerKey)),
        ts: Date.now()
      }
    ],
    ['set-records', { id: owned.id, text: 'tampered' }]
  ])

  // B applies its own append first — no network in the way
  await b.db.bee.update()
  t.absent(
    await b.db.bee.system.get(joiner.publicKey, { unflushed: true }),
    'not admitted on the writer that sent the batch'
  )

  // a marker appended after the batch: once A has it, A has applied the batch too
  const { data: marker } = await b.db.put('messages', { text: 'after' })
  await waitUntil(async () => (await a.db.get('messages', marker.id)).data)

  t.absent(
    await a.db.bee.system.get(joiner.publicKey, { unflushed: true }),
    'the joiner was never admitted as a writer'
  )
  t.absent((await a.db.get('devices', hid.encode(joiner.publicKey))).data, 'and has no device row')
  t.is(
    (await a.db.get('records', owned.id)).data.text,
    'owner-note',
    'the refused edit did nothing'
  )
})

test('apply: an undecodable node skips alone — it must not take the batch with it', async (t) => {
  const { db } = await withRole(t, 'owner')

  // One batch, one writer: garbage followed by a perfectly good op. Garbage is
  // also what a newer peer's op looks like to an older one, so aborting here
  // would mean an old peer drops a batch its neighbour applies — a fork. It has
  // to skip alone, which is why only REFUSED aborts.
  const good = wrap(
    db.version,
    db.spec.dispatch.encode(`@${db.ns}/add-messages`, {
      id: 'survivor',
      text: 'alive',
      createdAt: 1,
      updatedAt: 1
    })
  )
  await db.bee.append([b4a.from('garbage'), good])

  const row = await waitUntil(async () => (await db.get('messages', 'survivor')).data)
  t.is(row.text, 'alive', 'the valid sibling applied despite its poisoned batch-mate')
})

// ─── invite rows: members mint, moderators alter and revoke ─────────────

async function withMember(t) {
  const { db, identity } = await withRole(t, 'owner')
  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', { ...op, ts: Date.now() })
  await db.call('add-member', {
    id: hid.encode(writer.publicKey),
    key: writer.publicKey,
    role: 'member',
    name: 'b',
    createdAt: 1,
    updatedAt: 1
  })
  const as = (verb, payload) =>
    db.dispatcher
      .dispatch(db.spec.dispatch.encode(`@${db.ns}/${verb}`, payload), {
        view: db.view,
        host: {},
        key: writer.publicKey,
        dbKey: db.key
      })
      .then(
        () => null,
        (err) => err
      )
  return { db, as }
}

const inviteRow = (id, extra = {}) => ({
  id,
  invite: b4a.alloc(8, 1),
  publicKey: b4a.alloc(32, 2),
  role: 'member',
  createdAt: 1,
  ...extra
})

test('add-invite: a member may mint, but an existing invite is never overwritten', async (t) => {
  const { db, as } = await withMember(t)
  await db.call('add-invite', inviteRow('inv', { role: 'admin' }))

  t.absent(await as('add-invite', inviteRow('fresh')), 'a member mints its own invite')
  t.ok((await db.get('invites', 'fresh')).data, 'and the row landed')

  const err = await as('add-invite', inviteRow('inv', { publicKey: b4a.alloc(32, 9) }))
  t.is(err?.code, 'REFUSED', 'an existing id is refused')
  t.alike(
    (await db.get('invites', 'inv')).data.publicKey,
    b4a.alloc(32, 2),
    'and the row is untouched'
  )
})

test('del-invite / set-invite: revoking or altering a shared invite needs REMOVE', async (t) => {
  const { db, as } = await withMember(t)
  await db.call('add-invite', inviteRow('inv', { reuse: true }))

  t.is((await as('del-invite', { id: 'inv' }))?.code, 'REFUSED', 'a member cannot revoke')
  t.is((await as('set-invite', inviteRow('inv', { role: 'reader' })))?.code, 'REFUSED', 'nor alter')
  t.is((await db.get('invites', 'inv')).data?.role, 'member', 'the row is untouched')

  await db.call('del-invite', { id: 'inv' })
  t.absent((await db.get('invites', 'inv')).data, 'an owner revokes it')
})

test('del-invite: a single-use invite is consumed by whichever member served the join', async (t) => {
  const { db, as } = await withMember(t)
  await db.call('add-invite', inviteRow('once'))
  await db.call('add-invite', inviteRow('many', { reuse: true }))

  t.absent(await as('del-invite', { id: 'once' }), 'a member consumes the single-use invite')
  t.absent((await db.get('invites', 'once')).data, 'and it is gone')
  t.is(
    (await as('del-invite', { id: 'many' }))?.code,
    'REFUSED',
    'but cannot revoke a reusable one'
  )
  t.ok((await db.get('invites', 'many')).data, 'which stays')
})

// ─── admission is one decision: no grant, no writer ───────────────────────

test('add-writer: a rank the inviter cannot grant admits nobody', async (t) => {
  const { db, identity } = await withRole(t, 'member') // a plain member invites

  const joiner = Identity.randomKeyPair()
  const writerKey = joiner.publicKey
  const joinerMemberId = hid.encode(writerKey)

  // one transaction: admit the core, grant the rank. A member may do the
  // first and not the second — and the refusal discards both
  await t.exception(
    db.tx(async (tx) => {
      await tx.call('add-writer', {
        master: identity.publicKey,
        writer: writerKey,
        sig: identity.sign(admission(db.key, writerKey, db.writerKey)),
        memberId: joinerMemberId,
        ts: Date.now()
      })
      await tx.call('add-member', {
        id: joinerMemberId,
        key: writerKey,
        role: 'owner',
        name: 'j',
        createdAt: 1,
        updatedAt: 1
      })
    }),
    /REFUSED/,
    'refused out loud, at the caller'
  )

  t.absent((await db.get('devices', hid.encode(writerKey))).data, 'no device row')
  t.absent((await db.get('members', joinerMemberId)).data, 'no member row')
  t.absent(await db.bee.system.get(writerKey, { unflushed: true }), 'and no writer was admitted')
})

test('add-writer: a writer for a member that does not exist is refused', async (t) => {
  const { db, identity } = await withRole(t, 'member')
  const joiner = Identity.randomKeyPair()
  const op = {
    master: identity.publicKey,
    writer: joiner.publicKey,
    sig: identity.sign(admission(db.key, joiner.publicKey, db.writerKey)),
    memberId: hid.encode(joiner.publicKey),
    ts: Date.now()
  }
  await t.exception(db.call('add-writer', op), /REFUSED/, 'no member row, no writer')
  t.absent((await db.get('devices', hid.encode(joiner.publicKey))).data, 'no device row either')
})

// ─── add-device: the writer→role mapping is unauthenticated ───────────────

test('add-device: a writer cannot re-point its device row at another member', async (t) => {
  const { db, identity } = await bootstrapped(t)
  const ownerMemberId = identity.id

  // admit a second writer as a plain member
  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', { ...op, ts: Date.now() })
  const attackerMemberId = hid.encode(writer.publicKey)
  await db.call('add-member', {
    id: attackerMemberId,
    key: writer.publicKey,
    role: 'member',
    name: 'attacker',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const deviceId = hid.encode(writer.publicKey)
  t.is(
    (await db.get('devices', deviceId)).data.memberId,
    attackerMemberId,
    'device starts bound to its own member'
  )

  // the escalation attempt: re-point the device row at the owner's member id
  await db.call('add-device', { id: deviceId, memberId: ownerMemberId, updatedAt: Date.now() })

  t.is(
    (await db.get('devices', deviceId)).data.memberId,
    attackerMemberId,
    'memberId is not taken off the wire — the binding add-writer made stands'
  )
  t.not(
    (await db.get('devices', deviceId)).data.memberId,
    ownerMemberId,
    'no escalation: the writer still resolves to its own member'
  )
})

// ─── demotion: does lowering a role revoke the writer? ────────────────────

test('set-member: demoting below WRITE revokes the writer seat', async (t) => {
  const { db, identity } = await withRole(t, 'owner')

  // admit a second member as a writer
  const { op, writer } = addWriterOp(identity, db.writerKey, db.key)
  await db.call('add-writer', { ...op, ts: Date.now() })
  const memberId = hid.encode(writer.publicKey)
  await db.call('add-member', {
    id: memberId,
    key: writer.publicKey,
    role: 'member',
    name: 'b',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  t.ok((await db.get('devices', hid.encode(writer.publicKey))).data, 'admitted as a writer')

  // demote them to reader, watching what the demotion asks the host to revoke
  const revoked = []
  await db.dispatcher.dispatch(
    db.spec.dispatch.encode(`@${db.ns}/set-member`, {
      id: memberId,
      key: writer.publicKey,
      role: 'reader',
      name: 'b',
      createdAt: 1,
      updatedAt: Date.now()
    }),
    {
      view: db.view,
      host: { removeWriter: (k) => revoked.push(z32.encode(k)) },
      key: db.writerKey,
      dbKey: db.key
    }
  )

  t.is((await db.get('members', memberId)).data.role, 'reader', 'the role row says reader')
  t.ok(revoked.includes(z32.encode(writer.publicKey)), 'and the writer seat was revoked')

  // the device row stays: it is how a key resolves to a member, and deleting it
  // would leave the demoted writer unresolvable — which the apply-time WRITE
  // gate reads as "not yet enrolled" and lets through
  t.ok((await db.get('devices', hid.encode(writer.publicKey))).data, 'the device row stays')
})

// ─── add-file: WRITE gate ─────────────────────────────────────────────────

test('add-file: a reader cannot add a file', async (t) => {
  const { db } = await withRole(t, 'reader')
  const id = genId()
  await t.exception(db.call('add-file', { id, name: 'shot.png' }), /REFUSED/)
  t.absent((await db.get('files', id)).data, 'a reader has no WRITE — add-file rejected')
})

test('add-file: a member (WRITE) can add a file', async (t) => {
  const { db, identity } = await withRole(t, 'member')
  const id = genId()
  await db.call('add-file', { id, name: 'shot.png' })
  const { data } = await db.get('files', id)
  t.ok(data, 'a member with WRITE added the file row')
  t.is(data.name, 'shot.png', 'name persisted')
  t.is(data.memberId, identity.id, 'memberId stamped from the signer→member backlink')
})

// ─── poison ops: malformed nodes must not crash peers ─────────────────────

async function makeNetworked(t, testnet, opts = {}) {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = opts.identity || (await Identity.generate())
  const network = new Network({ bootstrap: testnet.bootstrap })
  await network.ready()
  const discovery = network.join(opts.topic)
  await discovery.flush()
  const db = new Database({ store, identity, network, spec, ...opts })
  await db.ready()
  t.teardown(
    async () => {
      try {
        await db.close()
      } catch {}
      try {
        await discovery.destroy()
      } catch {}
      try {
        await network.close()
      } catch {}
    },
    { order: 5 }
  )
  return { db, identity, network }
}

async function waitUntil(fn, { timeout = 15000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('waitUntil: condition not met before timeout')
}

test('poison op: garbage bytes from an admitted writer are skipped on every peer', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const aErrs = []
  const bErrs = []

  const a = await makeNetworked(t, testnet, { topic, onerror: (err) => aErrs.push(err) })
  await a.db.bootstrap({ name: 'a' })

  const bIdentity = await Identity.generate()
  const b = await makeNetworked(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey,
    onerror: (err) => bErrs.push(err)
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  await a.db.addWriter(b.db.keyPair.publicKey)
  await waitUntil(() => b.db.writable)

  await b.db.bee.append(b4a.from('garbage'))
  const { data: row } = await b.db.put('messages', { text: 'alive' })

  const onB = await waitUntil(async () => (await b.db.get('messages', row.id)).data)
  const onA = await waitUntil(async () => (await a.db.get('messages', row.id)).data)
  t.is(onB.text, 'alive', 'B skipped the poison node and applied the next valid op')
  t.is(onA.text, 'alive', 'A skipped the poison node and applied the next valid op')
  t.ok(bErrs.length > 0, 'B surfaced the skip via onerror')
  t.ok(aErrs.length > 0, 'A surfaced the skip via onerror')
})

// a replicated action with no local route must surface: silently skipping it
// diverges this peer from everyone that ran the handler
test('missing route: a replicated action surfaces via onerror, apply continues', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const bErrs = []

  const a = await makeNetworked(t, testnet, {
    topic,
    spec: spec.handles.team,
    routes: { promote: async () => {} }
  })
  await a.db.bootstrap({ name: 'a' })

  const bIdentity = await Identity.generate()
  const b = await makeNetworked(t, testnet, {
    identity: bIdentity,
    topic,
    spec: spec.handles.team,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey,
    onerror: (err) => bErrs.push(err)
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  await a.db.call('promote', { memberId: 'm', role: 'admin' })
  const { data: row } = await a.db.put('messages', { text: 'alive' })

  const onB = await waitUntil(async () => (await b.db.get('messages', row.id)).data)
  t.is(onB.text, 'alive', 'B kept applying past the routeless action')
  t.ok(
    bErrs.some((e) => e.code === 'UNKNOWN'),
    'B surfaced the missing route via onerror'
  )
})

test('poison op: wrong-length key/sig fields are skipped, not crashed', async (t) => {
  const { db, identity } = await bootstrapped(t)
  const intruder = Identity.randomKeyPair()

  await db.call('add-writer', {
    master: identity.publicKey,
    writer: intruder.publicKey,
    sig: b4a.alloc(10),
    name: 'x',
    isMobile: false
  })
  t.absent(
    (await db.get('devices', z32.encode(intruder.publicKey))).data,
    'short sig skipped without admitting'
  )

  await db.call('add-writer', {
    master: b4a.alloc(16),
    writer: intruder.publicKey,
    sig: b4a.alloc(64),
    name: 'x',
    isMobile: false
  })
  t.absent(
    (await db.get('devices', z32.encode(intruder.publicKey))).data,
    'short master skipped without admitting'
  )

  await db.call('claim-writer', {
    identity: b4a.alloc(8),
    writer: intruder.publicKey,
    sig: b4a.alloc(64),
    name: 'x',
    isMobile: false
  })
  t.absent(
    (await db.get('devices', z32.encode(intruder.publicKey))).data,
    'short claim identity skipped without admitting'
  )

  const memberId = genId()
  await db.call('add-member', {
    id: memberId,
    key: b4a.alloc(4),
    role: 'member',
    name: 'v',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  t.absent((await db.get('members', memberId)).data, 'short member key skipped without inserting')

  const { data } = await db.put('messages', { text: 'alive' })
  t.ok((await db.get('messages', data.id)).data, 'db still applies valid ops after poison ops')
})
