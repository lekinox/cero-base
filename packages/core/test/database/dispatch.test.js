import test from 'brittle'
import b4a from 'b4a'
import z32 from 'z32'
import crypto from 'hypercore-crypto'
import c from 'compact-encoding'

import { Database } from '../../src/database/index.js'
import { Identity } from '../../src/identity/index.js'
import { Network } from '../../src/network/index.js'
import { wrap } from '../../src/database/envelope.js'
import { chainOf, leftId, linkOf } from '../../src/database/dispatch.js'
import { wraps } from '../../src/database/encryption.js'
import {
  makeStore,
  makeTestnet,
  randomTopic,
  waitForConnection,
  makePeer,
  waitFor,
  withRole,
  admit,
  unchecked
} from '../helpers/index.js'
import hid from 'hypercore-id-encoding'
import { genId } from '../../src/lib/ids.js'
import { admission, joining } from '../../src/lib/utils.js'
import { getEncoding } from '../../src/lib/spec/index.js'
import { Invite } from '../../src/pairing/invite.js'
import { sealJoin } from '../../src/pairing/index.js'
import { Mailbox } from '../../src/mailbox/index.js'
import { encodeId } from '../../src/blobs/codec.js'
import { spec } from '../fixtures/spec/index.js'

test.configure({ timeout: 60000 })

async function bootstrapped(t, opts = {}) {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = opts.identity || (await Identity.create())
  const db = new Database({
    store,
    identity,
    spec,
    encryptionKey: Identity.randomBytes(32),
    ...opts
  })
  await db.ready()
  await db.bootstrap({ name: 'first', isMobile: false })
  t.teardown(() => db.close().catch(() => {}), { order: 5 })
  return { db, store, identity }
}

// ─── add-writer: signature verification ───────────────────────────────────

test('add-writer with a forged proof is rejected (no device row, writer not admitted)', async (t) => {
  const { db, identity } = await bootstrapped(t)
  const intruder = Identity.randomKeyPair()

  await db.call('add-writer', {
    master: identity.publicKey,
    writer: intruder.publicKey,
    proof: b4a.alloc(64),
    name: 'attacker',
    isMobile: false
  })

  const { data: device } = await db.get('devices', z32.encode(intruder.publicKey))
  t.absent(device, 'no device row was created')
})

test("add-writer: a proof another identity signed seats nothing, the master's rank aside", async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const stranger = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const { seated, host } = seating()
  const op = {
    master: identity.publicKey,
    writer,
    proof: stranger.sign(admission(db.key, writer, writer)),
    ts: 1
  }
  t.is(await apply(db, writer, 'add-writer', op, host), null, 'ignored')
  t.alike(seated, [], 'no seat')
  t.absent((await db.get('devices', hid.encode(writer))).data, 'no row')
})

// ─── writer/member authorization ──────────────────────────────────────────

// another device of `identity`, with a writer of its own to seat
function linked(identity) {
  const device = Identity.randomKeyPair()
  const proof = identity.link(device.publicKey)
  return {
    identity: Identity.from({ ...identity, device, proof }),
    writer: Identity.randomKeyPair()
  }
}

// a second member: an identity whose device keypair is also its writer, so one keypair seats
// it and signs for it
async function second(role, extra = {}) {
  const writer = Identity.randomKeyPair()
  const identity = await Identity.create({ device: writer })
  return {
    identity,
    writer,
    id: identity.id,
    row: { id: identity.id, key: writer.publicKey, role, name: 'b', ...extra }
  }
}

const noHost = { addWriter: async () => {}, removeWriter: async () => {} }

// applies an op as if `key` appended it, straight into the view: null, or the refusal
function apply(db, key, verb, payload, host = noHost) {
  return db.dispatcher
    .dispatch(db.spec.dispatch.encode(`@${db.ns}/${verb}`, payload), {
      view: db.view,
      host,
      key,
      dbKey: db.key
    })
    .then(
      () => null,
      (err) => err
    )
}

// a member's device seats itself, as claim() does from its own core
function seat(db, { identity, writer }) {
  return apply(db, writer.publicKey, 'add-writer', {
    master: identity.publicKey,
    writer: writer.publicKey,
    proof: identity.sign(admission(db.key, writer.publicKey, writer.publicKey)),
    ts: Date.now()
  })
}

test("add-writer: a reader's other device takes no seat", async (t) => {
  const { db, identity } = await withRole(t, 'reader')
  const phone = linked(identity)
  t.is((await seat(db, phone))?.code, 'REFUSED', 'a reader cannot seat a device')
  t.absent((await db.get('devices', phone.writer.id)).data, 'no row')
})

test("add-writer: a member's other device seats itself", async (t) => {
  const { db, identity } = await withRole(t, 'member')
  const phone = linked(identity)
  t.is(await seat(db, phone), null)
  const { data: device } = await db.get('devices', phone.writer.id)
  t.is(device?.memberId, identity.id, 'seated under the member')
  t.alike(device.key, phone.identity.device.publicKey, 'with the device key its chain ends at')
})

test('add-writer: a self-admission with no member row is refused, its proof valid', async (t) => {
  const { db } = await withRole(t, 'owner')
  const stranger = await second('member')
  t.is((await seat(db, stranger))?.code, 'REFUSED')
  t.absent(
    (await db.get('devices', hid.encode(stranger.writer.publicKey))).data,
    'no member, no seat'
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
    proof: identity.sign(admission(foreign, writer.publicKey, db.writerKey)),
    name: 'replayed',
    isMobile: false
  })
  t.absent(
    (await db.get('devices', z32.encode(writer.publicKey))).data,
    'cross-db add-writer replay rejected'
  )
})

test('admission signed for another appender is rejected (appender binding)', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const wrongAppender = b4a.alloc(32, 9)

  const writer = Identity.randomKeyPair()
  await db.call('add-writer', {
    master: identity.publicKey,
    writer: writer.publicKey,
    proof: identity.sign(admission(db.key, writer.publicKey, wrongAppender)),
    name: 'replayed',
    isMobile: false
  })
  t.absent(
    (await db.get('devices', z32.encode(writer.publicKey))).data,
    'admission signed for different appender rejected'
  )
})

// ─── role hierarchy: can only grant a role you hold ───────────────────────

function inviteOp(role) {
  return {
    id: hid.encode(Identity.randomKeyPair().publicKey),
    key: Identity.randomKeyPair().publicKey,
    role,
    name: 'v',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

test('add-member: past genesis nobody adds a member, whatever the rank', async (t) => {
  const { db } = await withRole(t, 'owner')
  const v = inviteOp('reader')
  await t.exception(db.call('add-member', v), /REFUSED/)
  t.absent((await db.get('members', v.id)).data, 'members come in through a join')
})

test('set-member: an admin cannot promote a member to owner', async (t) => {
  const v = inviteOp('member')
  const { db } = await withRole(t, 'admin', { members: [v] })

  await t.exception(db.call('set-member', { ...v, role: 'owner' }), /REFUSED/)
  t.is((await db.get('members', v.id)).data.role, 'member', 'role not escalated to owner')
})

test('del-member: only an owner can evict (a member cannot)', async (t) => {
  const v1 = inviteOp('member')
  const w = await withRole(t, 'member', { members: [v1] })
  await t.exception(w.db.call('del-member', { id: v1.id }), /REFUSED/)
  t.ok((await w.db.get('members', v1.id)).data, 'a member could not evict')

  const v2 = inviteOp('member')
  const o = await withRole(t, 'owner', { members: [v2] })
  await o.db.call('del-member', { id: v2.id })
  t.absent((await o.db.get('members', v2.id)).data, 'an owner evicted the member')
})

// ─── del-member: removal hierarchy ────────────────────────────────────────

test('del-member: an admin cannot evict a peer admin', async (t) => {
  const v = inviteOp('admin')
  const { db } = await withRole(t, 'admin', { members: [v] })

  await t.exception(db.call('del-member', { id: v.id }), /REFUSED/)
  t.ok((await db.get('members', v.id)).data, 'an admin could not evict a peer admin')
})

test('del-member: anyone removes themselves, whatever their rank', async (t) => {
  for (const role of ['owner', 'admin', 'member', 'reader']) {
    const { db, identity } = await withRole(t, role, { members: [inviteOp('owner')] })
    await db.del('members', identity.id)
    t.absent((await db.get('members', identity.id)).data, `a ${role} left`)
  }
})

test('del-member: the last owner of a room others are in cannot leave it', async (t) => {
  const { db, identity } = await withRole(t, 'owner', { members: [inviteOp('admin')] })
  const err = await db.del('members', identity.id).catch((e) => e)
  t.is(err?.code, 'INVALID', 'refused at the writer')
  t.ok(/make another member an owner/.test(err?.message), 'names the way out')
  const forged = await apply(db, db.writerKey, 'del-member', { id: identity.id })
  t.is(forged?.code, 'INVALID', 'and at apply')
  t.is((await db.get('members', identity.id)).data?.role, 'owner', 'still the owner')
})

test('del-member: every row one removal drops derives a row of its own', async (t) => {
  const { db } = await withRole(t, 'owner', {
    after: { del: ({ name, id, put }) => put('messages', { text: `gone ${name} ${id}` }) }
  })
  const other = await Identity.create()
  const tx = db.view.transaction()
  const ts = Date.now()
  const member = { id: other.id, key: crypto.randomBytes(32), role: 'member', createdAt: ts }
  await tx.insert(`@${db.ns}/members`, member)
  for (let i = 0; i < 2; i++) {
    const id = hid.encode(crypto.randomBytes(32))
    const device = { id, memberId: other.id, createdAt: ts, key: crypto.randomBytes(32) }
    await tx.insert(`@${db.ns}/devices`, device)
  }
  const value = db.spec.dispatch.encode(`@${db.ns}/del-member`, { id: other.id })
  const ctx = { view: tx, host: noHost, key: db.writerKey, dbKey: db.key, seed: crypto.hash(value) }
  await db.dispatcher.dispatch(value, ctx)
  const rows = await tx.find(`@${db.ns}/messages`, {}).toArray()
  await tx.close()
  t.is(rows.length, 3, 'two devices and the member, a row each')
})

test('mint: a derived row never lands on an id another member already wrote', async (t) => {
  const victim = await second('member')
  const squatter = await second('member')
  const { db } = await withRole(t, 'owner', {
    members: [victim.row, squatter.row],
    after: {
      put: ({ name, put }) =>
        name === 'messages' ? put('records', { text: 'derived' }) : undefined
    }
  })
  const value = db.spec.dispatch.encode(`@${db.ns}/add-messages`, {
    id: 'mine',
    text: 'hi',
    createdAt: 2,
    updatedAt: 2
  })
  const seed = crypto.hash(value)
  const next = z32.encode(crypto.hash([seed, c.encode(c.uint, 0)]).subarray(0, 16))
  await seat(db, squatter)
  const squat = { id: next, text: 'squat', createdAt: 1, updatedAt: 1 }
  t.is(await apply(db, squatter.writer.publicKey, 'add-records', squat), null, 'the squat lands')

  await seat(db, victim)
  const tx = db.view.transaction()
  const ctx = { view: tx, host: noHost, key: victim.writer.publicKey, dbKey: db.key, seed }
  const err = await db.dispatcher.dispatch(value, ctx).then(
    () => null,
    (err) => err
  )
  t.is(err?.code, undefined, 'the write is not refused')
  t.ok(await tx.get(`@${db.ns}/messages`, { id: 'mine' }), 'and lands')
  const rows = await tx.find(`@${db.ns}/records`, {}).toArray()
  await tx.close()
  const derived = rows.find((r) => r.text === 'derived')
  t.ok(derived, 'with its derived row')
  t.not(derived?.id, next, 'under another id')
})

// ─── del-writer: removal hierarchy + self-removal ─────────────────────────

function delWriterOp(writer) {
  return {
    master: Identity.randomKeyPair().publicKey,
    writer,
    proof: b4a.alloc(64),
    name: null,
    isMobile: false
  }
}

test("del-writer: a member cannot remove another member's writer", async (t) => {
  const b = await second('member')
  const { db } = await withRole(t, 'member', { members: [b.row] })
  await seat(db, b)
  const err = await apply(db, db.writerKey, 'del-writer', delWriterOp(b.writer.publicKey))
  t.is(err?.code, 'REFUSED')
  t.ok((await db.get('devices', b.writer.id)).data, 'a member could not remove the writer')
})

test("del-writer: an owner removes a member's writer", async (t) => {
  const v = inviteOp('member')
  const { db } = await withRole(t, 'owner', { members: [v] })
  await db.call('del-writer', delWriterOp(v.key))
  t.absent((await db.get('devices', z32.encode(v.key))).data, 'owner removed the writer')
})

test('del-writer: a member can remove its own writer (self)', async (t) => {
  const { db, identity } = await withRole(t, 'member')
  const phone = linked(identity)
  await seat(db, phone)
  t.is(await apply(db, db.writerKey, 'del-writer', delWriterOp(phone.writer.publicKey)), null)
  t.absent((await db.get('devices', phone.writer.id)).data, 'self-removal allowed')
})

test("del-writer: a removed device's key stays out: no new writer, no device it attests, no join", async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  // minted first: a write through db rebuilds the view without the seats applied straight into it
  const invite = await minted(db, { reuse: true })
  const phone = linked(identity)
  await seat(db, phone)
  await apply(db, db.writerKey, 'del-writer', delWriterOp(phone.writer.publicKey))
  // the chain is static, so the removal is kept beside the members' and read on every admission
  const again = { identity: phone.identity, writer: Identity.randomKeyPair() }
  t.is((await seat(db, again))?.code, 'REFUSED', 'not with a fresh writer')
  t.absent((await db.get('devices', again.writer.id)).data)
  const child = linked(phone.identity)
  t.is((await seat(db, child))?.code, 'REFUSED', 'nor a device it attests')
  const writer = Identity.randomKeyPair().publicKey
  const join = joinOp(db, invite, { identity: phone.identity, writer })
  t.is(await apply(db, writer, 'join', join), null)
  t.is((await refusal(db, hid.encode(writer)))?.reason, 'removed', 'a join by it is turned away')
})

// a host that keeps the writers apply adds and removes
function recording() {
  const calls = []
  return {
    calls,
    addWriter: async (key) => void calls.push(['add', hid.encode(key)]),
    removeWriter: async (key) => void calls.push(['remove', hid.encode(key)])
  }
}

test('del-writer: a writer with no device row is unseated by one who may remove, and no one else', async (t) => {
  const stray = Identity.randomKeyPair().publicKey
  const { db } = await withMember(t, 'member')
  const host = recording()
  t.is(await apply(db, db.writerKey, 'del-writer', delWriterOp(stray), host), null)
  t.alike(host.calls, [['remove', hid.encode(stray)]], 'the owner takes the seat')

  const { db: member } = await withRole(t, 'member')
  const refused = recording()
  const err = await apply(member, member.writerKey, 'del-writer', delWriterOp(stray), refused)
  t.is(err?.code, 'REFUSED', 'a member may not')
  t.alike(refused.calls, [])
})

test('del-device: an unknown id is nothing, and another member device is not a member to take', async (t) => {
  const { db, as } = await withMember(t, 'member')
  const host = recording()
  t.is(await apply(db, db.writerKey, 'del-device', { id: genId() }, host), null, 'unknown')
  t.alike(host.calls, [], 'no seat moves')

  const owner = hid.encode(db.writerKey)
  t.is((await as('del-device', { id: owner }))?.code, 'REFUSED', "the owner's device")
  t.ok((await db.get('devices', owner)).data, 'stays')
})

// the record the room keeps of a removal
const removal = (db, id) => db.view.get(`@${db.ns}/removals`, { id })

test('removal: its record says who: the admin who removed her, herself when she left, her identity for a device of hers', async (t) => {
  const v = inviteOp('member')
  const { db, owner, id, as } = await withMember(t, 'admin', [v])
  t.is(await as('del-member', { id: v.id }), null)
  t.is((await removal(db, v.id))?.by, id, 'removed by the admin')

  const phone = linked(owner)
  await seat(db, phone)
  t.is(await apply(db, db.writerKey, 'del-writer', delWriterOp(phone.writer.publicKey)), null)
  const key = hid.encode(phone.identity.device.publicKey)
  t.is((await removal(db, key))?.by, owner.id, 'a device, by the identity whose other device did')

  t.is(await as('del-member', { id }), null)
  t.is((await removal(db, leftId(id)))?.by, id, 'a leave, by herself')
})

test('removal: who removed is the same on every device, and after the view is applied again', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const a = await makePeer(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })
  const room = { topic, key: a.db.key, encryptionKey: a.db.encryptionKey }
  const b = await makePeer(t, testnet, { ...room, identity: await Identity.create() })
  const c = await makePeer(t, testnet, { ...room, identity: await Identity.create() })
  await admit(a.db, b.db, 'admin')
  await admit(a.db, c.db)
  await waitFor(() => b.db.writable && c.db.writable)
  await waitFor(async () => (await b.db.get('members', c.identity.id)).data)

  await b.db.del('members', c.identity.id)
  await waitFor(async () => removal(a.db, c.identity.id))
  await b.db.del('members', b.identity.id)
  const left = leftId(b.identity.id)
  await waitFor(async () => removal(a.db, left))
  const rows = async (db) => [await removal(db, c.identity.id), await removal(db, left)]
  const seen = await rows(a.db)
  t.alike(
    seen.map((row) => row.by),
    [b.identity.id, b.identity.id],
    'the owner reads who'
  )
  t.alike(await rows(b.db), seen, 'as the device that wrote them does')
  await a.db._rebuild()
  t.alike(await rows(a.db), seen, 'and the same log gives the same records')
})

test('del-member: a rule on a removal sees her devices, and a refused one leaves them and her seat', async (t) => {
  const { db, id, writer, member } = await withMember(t, 'member')
  await seat(db, { identity: member, writer })
  const seen = []
  let refuse = true
  db.before('del', async (ctx) => {
    if (ctx.name !== 'members') return
    const { data } = await ctx.get('devices')
    seen.push(data.filter((d) => d.memberId === id).length)
    return refuse ? false : undefined
  })
  const host = recording()
  const err = await apply(db, db.writerKey, 'del-member', { id }, host)
  t.is(err?.rule, 'hook', 'refused')
  t.ok((await db.get('devices', writer.id)).data, 'her device stays')
  t.alike(host.calls, [], 'and her seat')

  refuse = false
  t.is(await apply(db, db.writerKey, 'del-member', { id }, host), null)
  t.alike(seen, [1, 1], 'each time the rule saw her device')
  t.ok(
    host.calls.some(([op, key]) => op === 'remove' && key === writer.id),
    'then she is unseated'
  )
})

test("del-device: a member cannot remove another member's device; its own it can", async (t) => {
  const b = await second('member')
  const { db, identity } = await withRole(t, 'member', { members: [b.row] })
  await seat(db, b)
  t.is((await apply(db, db.writerKey, 'del-device', { id: b.writer.id }))?.code, 'REFUSED')
  t.ok((await db.get('devices', b.writer.id)).data, 'its device stays')

  const phone = linked(identity)
  await seat(db, phone)
  t.is(await apply(db, db.writerKey, 'del-device', { id: phone.writer.id }), null)
  t.absent((await db.get('devices', phone.writer.id)).data, 'its own device goes')
})

// ─── fast-forward trust ───────────────────────────────────────────────────

// autobee trusts every fast-forward candidate unless a hook says otherwise —
// a removed device could serve a stale or forked head and we would boot onto it
test('fast-forward: a head is only trusted while its writer is a device', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const live = linked(identity)
  const gone = linked(identity)

  await seat(db, live)
  await seat(db, gone)
  await apply(db, db.writerKey, 'del-writer', delWriterOp(gone.writer.publicKey))

  const trusted = (key) => db.bee.trusted.isTrusted(key, db.view)

  t.ok(await trusted(db.writerKey), 'our own writer is trusted')
  t.ok(await trusted(live.writer.publicKey), 'an admitted device is trusted')
  t.absent(await trusted(gone.writer.publicKey), 'a removed device is refused')
  t.absent(await trusted(Identity.randomKeyPair().publicKey), 'an unknown writer is refused')
})

test("fast-forward: a reader's device is never trusted", async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await minted(db, { role: 'reader' })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', joinOp(db, invite, { identity, writer }))
  t.is((await db.get('devices', hid.encode(writer))).data?.memberId, identity.id, 'it has a row')
  t.absent(await db.bee.trusted.isTrusted(writer, db.view), 'a reader is never trusted')
})

test("fast-forward: a demoted member's device is no longer trusted", async (t) => {
  const b = await second('member', { createdAt: 1, updatedAt: 1 })
  const { db } = await withRole(t, 'owner', { members: [b.row] })
  await seat(db, b)
  await apply(db, db.writerKey, 'set-member', { ...b.row, role: 'reader', updatedAt: 2 })
  t.ok((await db.get('devices', b.writer.id)).data, 'its device row stays')
  t.absent(await db.bee.trusted.isTrusted(b.writer.publicKey, db.view), 'but is not trusted')
})

test("fast-forward: only an admin's or an owner's device is trusted", async (t) => {
  const member = await second('member', { createdAt: 1, updatedAt: 1 })
  const admin = await second('admin', { createdAt: 1, updatedAt: 1 })
  const { db } = await withRole(t, 'owner', { members: [member.row, admin.row] })
  await seat(db, member)
  await seat(db, admin)
  t.absent(
    await db.bee.trusted.isTrusted(member.writer.publicKey, db.view),
    "a member's device is not trusted"
  )
  t.ok(await db.bee.trusted.isTrusted(admin.writer.publicKey, db.view), "an admin's is")
})

test('fast-forward: a core with no member cannot write itself a device row', async (t) => {
  const { db } = await withRole(t, 'owner')
  const stranger = Identity.randomKeyPair().publicKey
  const id = hid.encode(stranger)
  t.is((await apply(db, stranger, 'add-device', { id, updatedAt: 1 }))?.code, 'REFUSED')
  t.is((await apply(db, stranger, 'set-device', { id, updatedAt: 1 }))?.code, 'REFUSED')
  t.absent((await db.get('devices', id)).data, 'no row')
  t.absent(await db.bee.trusted.isTrusted(stranger, db.view), 'and no trust')
})

test('fast-forward: an empty reference trusts only the genesis writer', async (t) => {
  const { db: other } = await bootstrapped(t)

  // a fresh db pre-bootstrap: its view has no device rows yet
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = await Identity.create()
  const fresh = new Database({ store, identity, spec, encryptionKey: Identity.randomBytes(32) })
  await fresh.ready()
  t.teardown(() => fresh.close().catch(() => {}), { order: 5 })

  t.ok(
    await fresh.bee.trusted.isTrusted(fresh.key, fresh.view),
    'the genesis writer is trusted before any device'
  )
  t.absent(
    await fresh.bee.trusted.isTrusted(other.writerKey, fresh.view),
    'any other writer stays refused against an empty view'
  )
})

// the bound on a trust read: 2 s, as _isTrusted arms it
function bounds(t) {
  const armed = []
  const { setTimeout: set, clearTimeout: clear } = globalThis
  globalThis.setTimeout = (fn, ms, ...args) => {
    const timer = set(fn, ms, ...args)
    if (ms === 2000) armed.push(timer)
    return timer
  }
  const cleared = new Set()
  globalThis.clearTimeout = (timer) => {
    cleared.add(timer)
    return clear(timer)
  }
  const restore = () => {
    globalThis.setTimeout = set
    globalThis.clearTimeout = clear
  }
  t.teardown(restore)
  return { armed, cleared, restore }
}

test('fast-forward: a trust read that settles clears its bound', async (t) => {
  const { db } = await withRole(t, 'owner')
  const { armed, cleared, restore } = bounds(t)
  const trusted = await db._isTrusted(db.writerKey, db.view)
  restore()
  t.ok(trusted, 'the owner device is trusted')
  t.ok(armed.length > 0, 'each read was bounded')
  t.ok(
    armed.every((timer) => cleared.has(timer)),
    'and no bound is left armed'
  )
})

test('fast-forward: a trust read that never settles keeps no process alive', async (t) => {
  const { db } = await withRole(t, 'owner')
  const { armed, restore } = bounds(t)
  const stuck = { get: () => new Promise(() => {}) }
  let trusted = null
  db._isTrusted(db.writerKey, stuck).then((v) => (trusted = v))
  restore()
  t.is(armed.length, 1, 'the read is bounded')
  t.absent(armed[0].hasRef(), 'by a timer that holds no ref')
  // the poll holds the process open, the bound does not
  await waitFor(() => trusted !== null)
  t.is(trusted, false, 'untrusted once the bound passes')
})

// ─── encryption: wrong key cannot read ────────────────────────────────────

test("opening a bee with the wrong encryption key cannot decode another peer's rows", async (t) => {
  const { store: storeA } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const idA = await Identity.create()
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
  const idB = await Identity.create()
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

test('Identity.verify rejects a proof signed over different bytes', async (t) => {
  const id = await Identity.create()
  const original = b4a.from('hello world')
  const tampered = b4a.from('hello WORLD')
  const proof = id.sign(original)
  t.ok(Identity.verify(proof, original, id.publicKey), 'valid')
  t.absent(Identity.verify(proof, tampered, id.publicKey), 'tamper rejected')
})

// ─── collection writes require WRITE at apply, on every peer ──────────────

test("collections: a demoted writer cannot overwrite or delete another member's row", async (t) => {
  // a second member, then demoted to reader (they keep the writer
  // seat — set-member does not revoke it, which is exactly why apply must gate)
  const b = await second('member', { createdAt: 1, updatedAt: 1 })
  const { db } = await withRole(t, 'owner', { members: [b.row] })
  const { data: mine } = await db.put('messages', { text: 'owner-phi' })
  await seat(db, b)
  await apply(db, db.writerKey, 'set-member', { ...b.row, role: 'reader', updatedAt: Date.now() })
  t.is((await db.get('members', b.id)).data.role, 'reader', 'demoted')
  t.ok((await db.get('devices', b.writer.id)).data, 'but still holds a writer seat')

  // the demoted writer's ops are applied here with their key as the signer
  const asDemoted = (verb, payload) => apply(db, b.writer.publicKey, verb, payload)

  const overwrite = await asDemoted('set-messages', { id: mine.id, text: 'tampered' })
  t.is(overwrite?.code, 'REFUSED', 'overwrite refused at apply')
  t.is((await db.get('messages', mine.id)).data.text, 'owner-phi', 'and the row is untouched')

  const del = await asDemoted('del-messages', { id: mine.id })
  t.is(del?.code, 'REFUSED', 'delete refused at apply')
  t.ok((await db.get('messages', mine.id)).data, 'and the row survives')
})

test('collections: memberId is derived from the signer, never merged off the wire', async (t) => {
  const b = await second('member')
  const { db, identity } = await withRole(t, 'owner', { members: [b.row] })
  const { data: mine } = await db.put('messages', { text: 'owner-phi' })
  await seat(db, b)

  // a real writer edits the row and claims the edit was the owner's
  await apply(db, b.writer.publicKey, 'set-messages', {
    id: mine.id,
    text: 'edited',
    memberId: identity.id
  })

  const { data: after } = await db.get('messages', mine.id)
  t.is(after.text, 'edited', 'the edit itself is allowed — they may write')
  t.is(after.memberId, b.id, 'but it is credited to the signer, not the victim')
})

// ─── set-member takes an intent, not a row ────────────────────────────────

test('set-member: a member cannot rename another member or overwrite their key', async (t) => {
  const b = await second('member')
  const { db, identity } = await withRole(t, 'owner', { members: [b.row] })
  await seat(db, b)

  const { data: before } = await db.get('members', identity.id)

  await apply(db, b.writer.publicKey, 'set-member', {
    id: identity.id,
    key: b.writer.publicKey, // try to swap the owner's admitted key for our own
    role: 'owner',
    name: 'PWNED',
    createdAt: 1,
    updatedAt: Date.now()
  })

  const { data: after } = await db.get('members', identity.id)
  t.is(after.name, before.name, 'the name is untouched')
  t.alike(after.key, before.key, 'and so is the key the member was admitted with')
})

test('set-member: on another member row with no change of role nothing lands and no rule runs', async (t) => {
  const b = await second('member')
  const { db, identity } = await withRole(t, 'owner', { members: [b.row] })
  await seat(db, b)
  let ran = 0
  db.before('set', (ctx) => {
    if (ctx.name === 'members') ran++
  })
  const { data: before } = await db.get('members', identity.id)
  const touch = { id: identity.id, key: before.key, role: 'owner', updatedAt: before.updatedAt + 5 }

  await apply(db, b.writer.publicKey, 'set-member', touch)
  await apply(db, Identity.randomKeyPair().publicKey, 'set-member', touch)

  const { data: after } = await db.get('members', identity.id)
  t.is(
    after.updatedAt,
    before.updatedAt,
    'her row keeps its time, from a member and from a core with no seat'
  )
  t.is(ran, 0, 'and no rule on members ran')
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

test('set-member: a member renaming itself keeps the key it was admitted with', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const { data: me } = await db.get('members', identity.id)
  const other = Identity.randomKeyPair().publicKey
  t.is(await apply(db, db.writerKey, 'set-member', { ...me, key: other, name: 'renamed' }), null)
  const { data: after } = await db.get('members', identity.id)
  t.is(after.name, 'renamed')
  t.alike(after.key, me.key, 'the key never comes off the wire')
})

// ─── `own` collections: the author's rows are the author's ────────────────

test("own: a member cannot edit or delete another member's row", async (t) => {
  const b = await second('member')
  const { db } = await withRole(t, 'owner', { members: [b.row] })
  await seat(db, b)

  const { data: mine } = await db.put('records', { text: 'owner-note' })

  const asAttacker = (verb, payload) => apply(db, b.writer.publicKey, verb, payload)

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

test("own: a hook's ctx write is judged as its op's writer", async (t) => {
  const b = await second('member')
  const after = {
    put: (ctx) => {
      if (ctx.name === 'messages') return ctx.set('records', { id: 'owners', text: ctx.row.text })
    }
  }
  const { db } = await withRole(t, 'owner', { members: [b.row], after })
  await db.put('records', { id: 'owners', text: 'owner-note' })
  await seat(db, b)

  const err = await apply(db, b.writer.publicKey, 'add-messages', { id: genId(), text: 'tampered' })
  t.is(err?.code, 'REFUSED', 'the member may not overwrite it through a hook either')
  t.is((await db.get('records', 'owners')).data.text, 'owner-note', 'the row is untouched')
})

test('own: the author edits its own row, and REMOVE moderates the rest', async (t) => {
  const b = await second('member')
  const { db } = await withRole(t, 'owner', { members: [b.row] })
  await seat(db, b)

  const asMember = (verb, payload) => apply(db, b.writer.publicKey, verb, payload)

  const id = genId()
  await asMember('add-records', { id, text: 'theirs' })
  await asMember('set-records', { id, text: 'edited by its author' })
  t.is((await db.get('records', id)).data.text, 'edited by its author', 'the author may edit')

  // the owner holds REMOVE, so moderation still works
  await apply(db, db.writerKey, 'del-records', { id })
  t.absent((await db.get('records', id)).data, 'an owner may moderate it away')
})

// ─── a batch is atomic at apply ───────────────────────────────────────────

test('apply: one refused op discards its whole batch, on every peer', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()

  const a = await makePeer(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })

  const bIdentity = await Identity.create()
  const b = await makePeer(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  await admit(a.db, b.db, 'member')
  await waitFor(() => b.db.writable)

  const { data: owned } = await a.db.put('records', { text: 'owner-note' })
  await waitFor(async () => (await b.db.get('records', owned.id)).data)

  // A modified peer skips its own dry-run, so the batch reaches apply. The
  // ALLOWED op goes first: it has already written into the transaction by the
  // time the refusal lands, which is the only way to observe the discard.
  unchecked(b.db)
  await b.db.write([
    ['add-records', { id: 'sibling', text: 'legit', createdAt: 1, updatedAt: 1 }],
    ['set-records', { id: owned.id, text: 'tampered' }]
  ])

  // let the batch replicate and apply on A
  await waitFor(
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

  const a = await makePeer(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })

  const bIdentity = await Identity.create()
  const b = await makePeer(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)
  await admit(a.db, b.db, 'member')
  await waitFor(() => b.db.writable)
  const { data: owned } = await a.db.put('records', { text: 'owner-note' })
  await waitFor(async () => (await b.db.get('records', owned.id)).data)

  // B may admit a writer (INVITE) — and in the same batch touches a row it
  // may not. The batch is discarded. `addWriter` is a host call, not a row:
  // if it is not rolled back with the rows, the joiner is a writer with no
  // device row, which the WRITE gate reads as "not yet enrolled" and admits.
  const joiner = Identity.randomKeyPair()
  unchecked(b.db)
  await b.db.write([
    [
      'add-writer',
      {
        master: bIdentity.publicKey,
        writer: joiner.publicKey,
        proof: bIdentity.sign(admission(a.db.key, joiner.publicKey, b.db.writerKey)),
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
  await waitFor(async () => (await a.db.get('messages', marker.id)).data)

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

  const row = await waitFor(async () => (await db.get('messages', 'survivor')).data)
  t.is(row.text, 'alive', 'the valid sibling applied despite its poisoned batch-mate')
})

// ─── invite rows: members mint, moderators alter and revoke ─────────────

// the owner, plus a second member at `role` with its own writer; `as` applies an op signed by it
async function withMember(t, role = 'member', others = []) {
  const b = await second(role)
  const { db, identity } = await withRole(t, 'owner', { members: [b.row, ...others] })
  // seated right before each op: a write through db rebuilds the view without it, and a
  // reader has no seat to claim
  const as = async (verb, payload) => {
    await seat(db, b)
    return apply(db, b.writer.publicKey, verb, payload)
  }
  const sign = (message) => b.identity.sign(message)
  return { db, owner: identity, id: b.id, writer: b.writer, member: b.identity, as, sign }
}

const inviteRow = (id, extra = {}) => ({
  id,
  role: 'member',
  createdAt: 1,
  ...extra
})

test('add-invite: a member may mint, but an existing invite is never overwritten', async (t) => {
  const { db, as } = await withMember(t)
  await db.call('add-invite', inviteRow('inv', { role: 'admin' }))

  t.absent(await as('add-invite', inviteRow('fresh')), 'a member mints its own invite')
  t.ok((await db.get('invites', 'fresh')).data, 'and the row landed')

  const err = await as('add-invite', inviteRow('inv', { role: 'reader' }))
  t.is(err?.code, 'REFUSED', 'an existing id is refused')
  t.is((await db.get('invites', 'inv')).data.role, 'admin', 'and the row is untouched')

  const blank = await as('add-invite', inviteRow('blank', { role: '' }))
  t.is(blank?.code, 'REFUSED', 'an invite without a rank is refused')
})

test('add-invite: a reader mints none, not even at its own rank', async (t) => {
  const { db } = await withRole(t, 'reader')
  const err = await apply(db, db.writerKey, 'add-invite', inviteRow('mine', { role: 'reader' }))
  t.is(err?.code, 'REFUSED')
  t.absent((await db.get('invites', 'mine')).data, 'no invite')
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

test('del-invite: a member cannot revoke, not even a single-use invite', async (t) => {
  const { db, as } = await withMember(t)
  await db.call('add-invite', inviteRow('once'))
  t.is((await as('del-invite', { id: 'once' }))?.code, 'REFUSED')
  t.ok((await db.get('invites', 'once')).data, 'a join spends it, in apply')
})

// ─── joins: the joiner's own core asks in, apply admits ─────────────────

const Join = getEncoding('@cero/join')

// an invite the database holds; the seed stays with whoever joins with it
async function minted(db, record = {}) {
  const invite = Invite.create({ key: db.key, address: db.address })
  await db.call('add-invite', inviteRow(b4a.toHex(invite.id), record))
  return invite
}

// the join a joiner's writer appends: proven by the invite, signed by the identity's device, sealed
// to the room
function joinOp(
  db,
  invite,
  { identity, writer, signature, proof, address = db.address, reply = crypto.randomBytes(32) }
) {
  const join = {
    invite: invite.id,
    reply,
    signature: signature ?? invite.prove(writer),
    proof: proof ?? identity.sign(joining(db.key, invite.id, writer, reply)),
    ts: 1
  }
  return { box: crypto.encrypt(c.encode(Join, join), address) }
}

// a join the room turned away, until a member answered it
const refusal = (db, id) => db.view.get(`@${db.ns}/refusals`, { id })
// an invite spent or revoked, kept so its joins are told why
const spent = (db, id) => db.view.get(`@${db.ns}/spent`, { id })

function seating() {
  const seated = []
  const host = {
    addWriter: async (key) => void seated.push(hid.encode(key)),
    removeWriter: noHost.removeWriter
  }
  return { seated, host }
}

test('join: apply admits the member, seats its writer and spends the invite', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await minted(db)
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const { seated, host } = seating()
  t.is(await apply(db, writer, 'join', joinOp(db, invite, { identity, writer }), host), null)
  t.is((await db.get('members', identity.id)).data?.role, 'member')
  const { data: device } = await db.get('devices', hid.encode(writer))
  t.is(device?.memberId, identity.id)
  t.alike(device?.key, identity.device.publicKey, 'with the device key its proof ends at')
  t.alike(seated, [hid.encode(writer)], 'the device seats itself: the join is in its own core')
  t.absent((await db.get('invites', b4a.toHex(invite.id))).data, 'single-use: spent')
  const { data: owed } = await db.get('requests', hid.encode(writer))
  t.is(owed?.admitted, true, 'and it is owed its keys until a member delivers them')
})

test('join: removing a member drops the keys it was still owed', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await minted(db)
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', joinOp(db, invite, { identity, writer }))
  t.is(await apply(db, db.writerKey, 'del-member', { id: identity.id }), null)
  t.absent((await db.get('requests', hid.encode(writer))).data)
})

test('join: a reader gets a device record, no seat', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await minted(db, { role: 'reader' })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const { seated, host } = seating()
  t.is(await apply(db, writer, 'join', joinOp(db, invite, { identity, writer }), host), null)
  t.is((await db.get('members', identity.id)).data?.role, 'reader')
  t.is((await db.get('devices', hid.encode(writer))).data?.memberId, identity.id)
  t.alike(seated, [], 'a promotion seats it from its record')
})

test('join: a forged join admits nobody', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await minted(db, { reuse: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const other = Invite.create({ key: db.key, address: db.address })
  const forged = {
    'without the invite signature': joinOp(db, invite, {
      identity,
      writer,
      signature: other.prove(writer)
    }),
    'with a proof over other bytes': joinOp(db, invite, {
      identity,
      writer,
      proof: identity.sign(b4a.alloc(32))
    }),
    'with a chain that signs nothing': joinOp(db, invite, {
      identity,
      writer,
      proof: identity.proof
    }),
    'not sealed to this database': joinOp(db, invite, {
      identity,
      writer,
      address: crypto.encryptionKeyPair().publicKey
    }),
    'with an invite the database does not hold': joinOp(db, other, { identity, writer })
  }
  for (const [why, op] of Object.entries(forged)) {
    t.is(await apply(db, writer, 'join', op), null, `${why}: skipped, not refused`)
  }
  const elsewhere = Identity.randomKeyPair().publicKey
  t.is(await apply(db, elsewhere, 'join', joinOp(db, invite, { identity, writer })), null)
  t.absent((await db.get('members', identity.id)).data, 'nobody admitted')
  t.absent((await db.get('devices', hid.encode(elsewhere))).data, 'a join proves only its own core')
})

// an invite with an address of its own: its row holds the secret
async function addressed(db, record = {}) {
  const secret = crypto.randomBytes(32)
  const invite = Invite.create({ key: db.key, address: Mailbox.getAddress(secret) })
  await db.call('add-invite', inviteRow(b4a.toHex(invite.id), { secret, ...record }))
  return invite
}

// the join on it: sealed to the invite's address, naming the invite in the clear
const named = (db, invite, opts) => ({
  ...joinOp(db, invite, { address: invite.address, ...opts }),
  invite: invite.id
})

test('join: one that names its invite opens with the secret on its row, live or spent', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db)
  const id = b4a.toHex(invite.id)
  const { secret } = (await db.get('invites', id)).data
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  t.is(await apply(db, writer, 'join', named(db, invite, { identity, writer })), null)
  const { data: owed } = await db.get('requests', hid.encode(writer))
  t.is(owed?.promised, true, 'let in')
  t.is(owed.invite, id, 'owed its keys, under it')
  t.alike((await spent(db, id))?.secret, secret, 'spent, the secret stays')

  const other = await Identity.create()
  const late = Identity.randomKeyPair().publicKey
  const reply = crypto.randomBytes(32)
  await apply(db, late, 'join', named(db, invite, { identity: other, writer: late, reply }))
  const refused = await refusal(db, hid.encode(late))
  t.is(refused?.reason, 'spent', 'a join on the spent one still opens, and hears why')
  t.is(refused?.invite, id, 'under the invite whose secret proves the answer')
  t.absent((await db.get('members', other.id)).data, 'and admits nobody')
})

test("join: one that names an invite is skipped where its row holds no secret, or isn't there", async (t) => {
  const { db } = await withRole(t, 'owner')
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  // the invite as a device that lacks its row has it, and as one whose row kept no secret
  const absent = Invite.create({ key: db.key, address: Mailbox.getAddress(crypto.randomBytes(32)) })
  const bare = await addressed(db, { secret: null, reuse: true })
  const joins = {
    'no row': named(db, absent, { identity, writer }),
    'a row with no secret': named(db, bare, { identity, writer }),
    "a row with no secret, sealed to the room's address": named(db, bare, {
      identity,
      writer,
      address: db.address
    })
  }
  for (const [why, op] of Object.entries(joins)) {
    t.is(await apply(db, writer, 'join', op), null, `${why}: skipped, not refused`)
  }
  t.absent((await db.get('members', identity.id)).data, 'nobody admitted')
  t.absent(await refusal(db, hid.encode(writer)), 'nor answered')

  const kept = await addressed(db)
  const unnamed = joinOp(db, kept, { identity, writer, address: kept.address })
  t.is(await apply(db, writer, 'join', unnamed), null)
  t.absent((await db.get('members', identity.id)).data, "one that names none is the room's to open")
})

test('join: one on an invite whose row holds a secret is skipped unless it names it', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db)
  const id = b4a.toHex(invite.id)
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  // sealed to the room's address, as a join on an invite with none of its own
  const unnamed = () => joinOp(db, invite, { identity, writer })
  t.is(await apply(db, writer, 'join', unnamed()), null, 'skipped, not refused')
  t.absent((await db.get('members', identity.id)).data, 'on a live one: nobody admitted')
  t.ok((await db.get('invites', id)).data, 'and the invite is not spent')

  await db.call('del-invite', { id })
  t.ok((await spent(db, id))?.secret, 'revoked, its row keeps the secret')
  t.is(await apply(db, writer, 'join', unnamed()), null)
  t.absent(await refusal(db, hid.encode(writer)), 'on a spent one: not answered')
  await apply(db, writer, 'join', named(db, invite, { identity, writer }))
  t.is((await refusal(db, hid.encode(writer)))?.reason, 'revoked', 'named, it hears why')
})

test('join: one whose box holds another invite than it names is skipped', async (t) => {
  const { db } = await withRole(t, 'owner')
  const one = await addressed(db, { reuse: true })
  const two = await addressed(db, { reuse: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  // a join on `two`, sealed to the address of `one` and naming it
  const crossed = { ...joinOp(db, two, { identity, writer, address: one.address }), invite: one.id }
  t.is(await apply(db, writer, 'join', crossed), null, 'skipped, not refused')
  t.absent((await db.get('members', identity.id)).data, 'nobody admitted')
  t.absent((await db.get('requests', hid.encode(writer))).data)

  t.is(await apply(db, writer, 'join', named(db, two, { identity, writer })), null)
  t.ok(
    (await db.get('requests', hid.encode(writer))).data?.promised,
    'named as its box says, it is let in'
  )
})

// a device of `identity` seats itself from its writer's own core, as claim() does
const claimed = (db, identity, writer, host) =>
  apply(
    db,
    writer,
    'add-writer',
    {
      master: identity.publicKey,
      writer,
      proof: identity.sign(admission(db.key, writer, writer)),
      ts: 2
    },
    host
  )

const promise = async (db, writer) => (await db.get('requests', hid.encode(writer))).data

test('promise: a join on an invite with its own address writes no member and no seat until its device claims', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db)
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const { seated, host } = seating()
  t.is(await apply(db, writer, 'join', named(db, invite, { identity, writer }), host), null)
  t.absent((await db.get('members', identity.id)).data, 'no member')
  t.absent((await db.get('devices', hid.encode(writer))).data, 'no device')
  t.alike(seated, [], 'no seat')
  const owed = await promise(db, writer)
  t.is(owed?.promised, true, 'a promise')
  t.is(owed.admitted, true, 'no longer waiting for a member')
  t.is(owed.role, 'member', "at the invite's role")
  t.absent((await db.get('invites', b4a.toHex(invite.id))).data, 'single-use: spent')

  const put = []
  db.after('put', (ctx) => void put.push(ctx.name))
  t.is(await claimed(db, identity, writer, host), null)
  const { data: member } = await db.get('members', identity.id)
  t.is(member?.role, 'member', 'the member, once its device claimed')
  t.alike(member.key, writer)
  const { data: device } = await db.get('devices', hid.encode(writer))
  t.is(device?.memberId, identity.id)
  t.alike(device.key, identity.device.publicKey, 'with the device key its proof ends at')
  t.alike(seated, [hid.encode(writer)], 'seated')
  t.alike(put, ['members', 'devices'], "the hooks a join's rows fire")
  t.ok(await promise(db, writer), 'the promise stays for an inviter to settle')
  t.is(await apply(db, db.writerKey, 'del-request', { id: hid.encode(writer) }), null)
  t.absent(await promise(db, writer))
  t.is((await db.get('members', identity.id)).data?.role, 'member', 'settled, the member stays')
})

test("promise: a reader's completes with a member row and no seat", async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db, { role: 'reader' })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const { seated, host } = seating()
  await apply(db, writer, 'join', named(db, invite, { identity, writer }), host)
  t.is((await promise(db, writer))?.role, 'reader')
  t.is(await claimed(db, identity, writer, host), null)
  t.is((await db.get('members', identity.id)).data?.role, 'reader')
  t.is((await db.get('devices', hid.encode(writer))).data?.memberId, identity.id, 'a device row')
  t.alike(seated, [], 'no writer seat')
})

test("promise: one made to a member is kept by her other device at the role she holds: a reader's gets its device row and no seat, a writer's its seat", async (t) => {
  const b = await second('member')
  const { db } = await withRole(t, 'owner', { members: [b.row] })
  const invite = await addressed(db, { reuse: true })
  const identity = await Identity.create()
  const first = Identity.randomKeyPair().publicKey
  const { seated, host } = seating()
  const once = await addressed(db, { role: 'reader' })
  await apply(db, first, 'join', named(db, once, { identity, writer: first }), host)
  t.is(await claimed(db, identity, first, host), null)
  t.is(await apply(db, db.writerKey, 'del-request', { id: hid.encode(first) }), null)
  const { data: reader } = await db.get('members', identity.id)
  t.is(reader?.role, 'reader')

  const phone = linked(identity)
  const writer = phone.writer.publicKey
  await apply(db, writer, 'join', named(db, invite, { identity: phone.identity, writer }), host)
  t.is((await promise(db, writer))?.role, 'member', 'a reader already, her device is promised')
  t.is(await claimed(db, phone.identity, writer, host), null, 'and keeps it')
  const { data: device } = await db.get('devices', hid.encode(writer))
  t.is(device?.memberId, identity.id, 'a device row')
  t.alike(device?.key, phone.identity.device.publicKey, 'with the device key its chain ends at')
  t.alike(seated, [], 'no seat at a role that cannot write')
  t.alike((await db.get('members', identity.id)).data, reader, 'her row as it was, its role too')

  t.is(await seat(db, b), null)
  const tablet = linked(b.identity)
  const other = tablet.writer.publicKey
  await apply(db, other, 'join', named(db, invite, { identity: tablet.identity, writer: other }))
  t.ok((await promise(db, other))?.promised)
  t.is(await claimed(db, tablet.identity, other, host), null)
  t.is((await db.get('devices', hid.encode(other))).data?.memberId, b.id)
  t.alike(seated, [hid.encode(other)], "a writer's other device is seated")

  const stranger = await Identity.create()
  const stray = Identity.randomKeyPair().publicKey
  await apply(db, stray, 'join', named(db, invite, { identity: stranger, writer: stray }), host)
  t.is(await claimed(db, stranger, stray, host), null)
  t.is((await db.get('members', stranger.id)).data?.role, 'member', 'a stranger, at its role')
  t.alike(seated, [hid.encode(other), hid.encode(stray)])
})

test("promise: one made for a reader's device is kept by that device alone: another device of hers, nothing promised to it, is refused", async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db, { reuse: true })
  const identity = await Identity.create()
  const first = Identity.randomKeyPair().publicKey
  const once = await addressed(db, { role: 'reader' })
  await apply(db, first, 'join', named(db, once, { identity, writer: first }))
  t.is(await claimed(db, identity, first), null)
  t.is(await apply(db, db.writerKey, 'del-request', { id: hid.encode(first) }), null)

  const promised = linked(identity)
  const writer = promised.writer.publicKey
  await apply(db, writer, 'join', named(db, invite, { identity: promised.identity, writer }))
  t.ok((await promise(db, writer))?.promised, 'a device of hers is promised')

  const other = linked(identity)
  t.is((await seat(db, other))?.code, 'REFUSED', 'another, its chain valid, stands on nothing')
  t.absent((await db.get('devices', hid.encode(other.writer.publicKey))).data, 'no device row')
  t.is(await seat(db, promised), null, 'the device it was made for keeps it')
  t.is((await db.get('devices', hid.encode(writer))).data?.memberId, identity.id)

  const stranger = await Identity.create()
  const stray = Identity.randomKeyPair().publicKey
  await apply(db, stray, 'join', named(db, invite, { identity: stranger, writer: stray }))
  const phone = linked(stranger)
  t.is(await seat(db, phone), null, 'no member yet, any device of hers keeps what she was promised')
  t.is((await db.get('members', stranger.id)).data?.role, 'member')
})

test('promise: another device of the identity completes it at the earliest role, and the one that joined then seats itself', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db, { role: 'reader', reuse: true })
  const later = await addressed(db, { reuse: true })
  const identity = await Identity.create()
  const first = Identity.randomKeyPair().publicKey
  const other = Identity.randomKeyPair().publicKey
  await apply(db, first, 'join', named(db, invite, { identity, writer: first }))
  await apply(db, other, 'join', named(db, later, { identity, writer: other }))
  t.is((await promise(db, other))?.role, 'member', 'a second promise, at another role')

  const phone = linked(identity)
  const { seated, host } = seating()
  t.is(await seat(db, phone), null, 'a device that never joined claims')
  t.is((await db.get('members', identity.id)).data?.role, 'reader', 'at the first promise')
  t.is((await db.get('devices', phone.writer.id)).data?.memberId, identity.id, 'and is seated')
  t.ok(await promise(db, first), 'the promises stay')
  t.ok(await promise(db, other))

  const { data: record } = await db.get('members', identity.id)
  await apply(db, db.writerKey, 'set-member', { ...record, role: 'member', updatedAt: 3 })
  t.is(await claimed(db, identity, first, host), null, 'the device that joined, as any device')
  t.is((await db.get('devices', hid.encode(first))).data?.memberId, identity.id)
  t.alike(seated, [hid.encode(first)])
})

test('promise: accepting a waiting join on an invite with its own address promises at the accepted role', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db, { confirm: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  const { seated, host } = seating()
  await apply(db, writer, 'join', named(db, invite, { identity, writer }))
  t.absent((await promise(db, writer))?.promised, 'waiting')
  t.is((await claimed(db, identity, writer, host))?.code, 'REFUSED', 'a claim before it is let in')
  t.is(await apply(db, db.writerKey, 'accept', { id, role: 'reader' }, host), null)
  const owed = await promise(db, writer)
  t.is(owed?.promised, true)
  t.is(owed.role, 'reader', 'at the accepted role')
  t.absent((await db.get('members', identity.id)).data, 'no member')
  t.absent((await db.get('devices', id)).data, 'no seat')
  t.absent((await db.get('invites', b4a.toHex(invite.id))).data, 'spent')
  t.is(await apply(db, db.writerKey, 'accept', { id, role: 'member' }), null, 'again: nothing')
  t.is((await promise(db, writer))?.role, 'reader')

  t.is(await claimed(db, identity, writer, host), null)
  t.is((await db.get('members', identity.id)).data?.role, 'reader')
  t.alike(seated, [])
})

test("promise: an accept with a proof promises with the chain, which the linked device's seat keeps", async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const invite = await addressed(db, { confirm: true, reuse: true })
  const open = await addressed(db, { reuse: true })
  const device = Identity.randomKeyPair()
  const bare = await Identity.bare(device)
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  await apply(db, writer, 'join', named(db, invite, { identity: bare, writer }))
  const proof = identity.link(device.publicKey)
  const { seated, host } = seating()
  t.is(await apply(db, db.writerKey, 'accept', { id, proof }, host), null)
  const owed = await promise(db, writer)
  t.is(owed?.promised, true)
  t.alike(owed.proof, proof, 'with the chain its reply will carry')
  t.alike(owed.identity, identity.publicKey, "under the accepter's identity")
  t.is(owed.role, 'owner')
  t.absent((await db.get('devices', id)).data, 'no seat')
  t.alike(seated, [])

  // another device of the same identity, let in by an invite
  const tablet = linked(identity)
  const other = tablet.writer.publicKey
  await apply(db, other, 'join', named(db, open, { identity: tablet.identity, writer: other }))
  t.ok((await promise(db, other))?.promised)

  const phone = Identity.from({ ...identity, device, proof })
  t.is(await claimed(db, phone, writer, host), null)
  const { data: row } = await db.get('devices', id)
  t.is(row?.memberId, identity.id, 'seated under the accepter')
  t.alike(row.key, device.publicKey)
  t.alike(row.proof, proof, 'its seat keeps the chain')
  t.alike(seated, [id])
  t.is((await db.get('members')).data.length, 1, 'no member was added')
  t.ok(await promise(db, writer), 'its promise stays for an inviter to settle')

  t.is(await seat(db, tablet), null, 'a device promised with no chain seats itself')
  t.absent((await db.get('devices', tablet.writer.id)).data?.proof, 'and its seat carries none')
})

test('promise: a revoked invite withdraws the promises made under it, and a removal takes her own', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db, { reuse: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', named(db, invite, { identity, writer }))
  t.is(await apply(db, db.writerKey, 'del-invite', { id: b4a.toHex(invite.id) }), null)
  t.absent(await promise(db, writer), 'revoking its invite withdraws the promise')
  t.is((await refusal(db, hid.encode(writer)))?.reason, 'revoked', 'and tells her why')
  t.is((await claimed(db, identity, writer))?.code, 'REFUSED', 'a claim made after finds nothing')
  t.absent((await db.get('members', identity.id)).data, 'no member')

  const stranger = await Identity.create()
  const stray = Identity.randomKeyPair().publicKey
  t.is((await claimed(db, stranger, stray))?.code, 'REFUSED', 'no promise, no member: refused')

  // a member's other device, promised, when the member is removed
  const b = await second('member')
  const mine = b.writer.publicKey
  const again = await addressed(db, { reuse: true })
  await apply(db, mine, 'join', named(db, again, { identity: b.identity, writer: mine }))
  t.is(await claimed(db, b.identity, mine), null)
  const tablet = linked(b.identity)
  const other = tablet.writer.publicKey
  await apply(db, other, 'join', named(db, again, { identity: tablet.identity, writer: other }))
  t.ok((await promise(db, other))?.promised)
  t.is(await apply(db, db.writerKey, 'del-member', { id: b.id }), null)
  t.absent(await promise(db, other), 'her promise goes with her')
  t.is((await claimed(db, tablet.identity, other))?.code, 'REFUSED', 'and brings nobody back')
  t.absent((await db.get('members', b.id)).data)
})

// ─── a removal spends the invites that let in on their own ───────────────

const live = async (db, invite) => (await db.get('invites', b4a.toHex(invite.id))).data

test('removal: one by a member who may remove spends the invites that let in on their own, and a join under one is turned away', async (t) => {
  const { db } = await withRole(t, 'owner')
  const open = await addressed(db, { reuse: true })
  const once = await addressed(db)
  const asked = await addressed(db, { reuse: true, confirm: true })
  const plain = await minted(db, { reuse: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', named(db, open, { identity, writer }))
  t.is(await claimed(db, identity, writer), null)
  t.is(await apply(db, db.writerKey, 'del-member', { id: identity.id }), null)
  t.ok(await live(db, plain), 'one with no address of its own is left as it was')
  t.absent(await live(db, open), 'the reusable one she holds')
  t.absent(await live(db, once), 'and one nobody used yet')
  const kept = await spent(db, b4a.toHex(open.id))
  t.is(kept?.reason, 'removed')
  t.ok(kept?.secret, 'its secret stays, so a join under it is still opened')
  t.ok(await live(db, asked), 'one that waits for an accept stays')

  const again = Identity.randomKeyPair().publicKey
  await apply(db, again, 'join', named(db, open, { identity, writer: again }))
  t.absent(await promise(db, again), 'her join with it lets nobody in')
  t.is((await refusal(db, hid.encode(again)))?.reason, 'removed', 'and hears why')
  t.is((await claimed(db, identity, again))?.code, 'REFUSED')

  const other = await Identity.create()
  const next = Identity.randomKeyPair().publicKey
  await apply(db, next, 'join', named(db, asked, { identity: other, writer: next }))
  t.is(await apply(db, db.writerKey, 'accept', { id: hid.encode(next) }), null)
  t.ok((await promise(db, next))?.promised, 'the one that waits still lets in whoever is accepted')
})

test('removal: a leave spends nothing, and removed after she left her invite is spent all the same', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db, { reuse: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', named(db, invite, { identity, writer }))
  t.is(await claimed(db, identity, writer), null)
  t.is(await apply(db, writer, 'del-member', { id: identity.id }), null)
  t.ok(await live(db, invite), 'her leaving spends nothing')

  t.is(await apply(db, db.writerKey, 'del-member', { id: identity.id }), null)
  t.absent(await live(db, invite), 'taken out after, the invite she holds is spent')
  const again = Identity.randomKeyPair().publicKey
  await apply(db, again, 'join', named(db, invite, { identity, writer: again }))
  t.absent((await db.get('requests', hid.encode(again))).data, 'so she waits for no accept')
  t.is((await refusal(db, hid.encode(again)))?.reason, 'removed', 'and is turned away')
})

test('removal: a device taken out by one who may remove spends them too, and a member removing her own device, or one who left, spends nothing', async (t) => {
  const gone = await second('member')
  const { db, owner, member, writer, as } = await withMember(t, 'member', [gone.row])
  const invite = await addressed(db, { reuse: true })
  await seat(db, gone)
  t.is(await apply(db, gone.writer.publicKey, 'del-member', { id: gone.id }), null)
  await seat(db, { identity: member, writer })
  const mine = linked(member)
  await seat(db, mine)
  t.is(await as('del-writer', delWriterOp(mine.writer.publicKey)), null)
  t.ok(await live(db, invite), 'her own device, without the right to remove')
  t.is(await as('del-member', { id: gone.id }), null)
  t.ok(await live(db, invite), 'nor one who left, taken out by her')
  const nobody = await Identity.create()
  t.is(await apply(db, db.writerKey, 'del-member', { id: nobody.id }), null)
  t.ok(await live(db, invite), 'nor a removal of nobody')

  const phone = linked(owner)
  await seat(db, phone)
  t.is(await apply(db, db.writerKey, 'del-writer', delWriterOp(phone.writer.publicKey)), null)
  t.absent(await live(db, invite), 'a device, by one who may remove')
  t.is((await spent(db, b4a.toHex(invite.id)))?.reason, 'removed')
})

test('removal: a promise under an invite it spends is withdrawn like a deny, unless its device claimed', async (t) => {
  const { db, id } = await withMember(t, 'member')
  const invite = await addressed(db, { reuse: true })
  const late = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', named(db, invite, { identity: late, writer }))
  const here = await Identity.create()
  const sat = Identity.randomKeyPair().publicKey
  await apply(db, sat, 'join', named(db, invite, { identity: here, writer: sat }))
  t.is(await claimed(db, here, sat), null)

  t.is(await apply(db, db.writerKey, 'del-member', { id }), null)
  t.absent(await promise(db, writer), 'the promise nobody claimed is withdrawn')
  t.is((await refusal(db, hid.encode(writer)))?.reason, 'removed', 'and answered')
  t.is((await claimed(db, late, writer))?.code, 'REFUSED', 'a claim made after finds nothing')
  t.absent((await db.get('members', late.id)).data, 'no member')
  t.ok(await promise(db, sat), 'one its device claimed stays for a member to settle')
  t.absent(await refusal(db, hid.encode(sat)))
  t.ok((await db.get('members', here.id)).data, 'and she stays a member')
})

test('removal: the invite it spends is spent on every device, a join under it turned away on each, and the same log gives the same rows', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const a = await makePeer(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })
  const room = { topic, key: a.db.key, encryptionKey: a.db.encryptionKey }
  const b = await makePeer(t, testnet, { ...room, identity: await Identity.create() })
  await admit(a.db, b.db, 'admin')
  await waitFor(() => b.db.writable)

  const secret = crypto.randomBytes(32)
  const invite = Invite.create({ key: a.db.key, address: Mailbox.getAddress(secret), own: true })
  const id = b4a.toHex(invite.id)
  const stamp = await a.db.write([['add-invite', inviteRow(id, { secret, reuse: true })]])
  // a device of the joiner appends its join to its own core, as Pairing.join does
  const join = async ({ db }) => {
    const payload = sealJoin(invite, db.identity, db.writerKey, crypto.randomBytes(32))
    const op = db.spec.dispatch.encode(`@${db.ns}/join`, payload)
    await waitFor(async () => (await db.get('invites', id)).data || spent(db, id))
    await db.bee.append(wrap(stamp, op), { optimistic: true })
    return hid.encode(db.writerKey)
  }
  const c = await makePeer(t, testnet, { ...room, identity: await Identity.create() })
  await join(c)
  await c.db.claim()
  await waitFor(async () => (await b.db.get('members', c.identity.id)).data)

  await b.db.del('members', c.identity.id)
  const again = await makePeer(t, testnet, { ...room, identity: c.identity })
  const writer = await join(again)
  for (const { db } of [a, b]) {
    await waitFor(async () => (await refusal(db, writer))?.reason === 'removed')
    t.is((await spent(db, id))?.reason, 'removed', 'spent by her removal')
    t.absent((await db.get('invites', id)).data)
    t.absent((await db.get('members', c.identity.id)).data, 'and she is not let in again')
  }
  const rows = async ({ view, ns }) => {
    const all = (name) => view.find(`@${ns}/${name}`, {}).toArray()
    return Promise.all(['invites', 'spent', 'requests', 'refusals', 'removals', 'members'].map(all))
  }
  const seen = await rows(a.db)
  t.alike(await rows(b.db), seen, 'every device holds the same rows')
  await a.db._rebuild()
  await waitFor(async () => refusal(a.db, writer))
  t.alike(await rows(a.db), seen, 'and so does the view applied again')
})

test("promise: a device removed takes its writer's request with it, and what its device key was promised", async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db, { reuse: true })
  // one that waits for an accept, which a removal leaves: a member's device is let in at once
  const asked = await addressed(db, { reuse: true, confirm: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const again = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', named(db, invite, { identity, writer }))
  t.is(await claimed(db, identity, writer), null)
  // the same device let in once more on another writer, and another device of the member, which
  // her phrase made: its chain does not pass through the first
  await apply(db, again, 'join', named(db, asked, { identity, writer: again }))
  const tablet = await Identity.create({ seed: identity.seed })
  const other = Identity.randomKeyPair().publicKey
  await apply(db, other, 'join', named(db, asked, { identity: tablet, writer: other }))
  t.ok(await promise(db, writer), 'seated, its promise not settled yet')

  t.is(await apply(db, db.writerKey, 'del-device', { id: hid.encode(writer) }), null)
  t.absent(await promise(db, writer), "its writer's promise goes with the seat")
  t.absent(await promise(db, again), 'and the one made to its device key on another writer')
  t.ok(await promise(db, other), "another device's stays")

  t.is(await apply(db, db.writerKey, 'del-writer', delWriterOp(other)), null)
  t.absent(await promise(db, other), 'a writer unseated before it sat loses what it was owed')
})

test('deny: a promise is withdrawn by one who may remove, with its reason, and by nobody below', async (t) => {
  const { db, as } = await withMember(t, 'member')
  const invite = await addressed(db)
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  const reply = crypto.randomBytes(32)
  await apply(db, writer, 'join', named(db, invite, { identity, writer, reply }))
  t.ok((await promise(db, writer))?.promised, 'let in, its invite spent by its own join')

  t.is(
    (await as('deny', { id, reason: 'no' }))?.rule,
    'remove',
    'one who may only invite is refused'
  )
  t.ok(await promise(db, writer), 'and the promise stands')
  t.is(await apply(db, db.writerKey, 'deny', { id, reason: 'not you' }), null)
  t.absent(await promise(db, writer), 'withdrawn by one who may remove')
  const refused = await refusal(db, id)
  t.is(refused?.reason, 'not you', 'with its reason')
  t.alike(refused.reply, reply, 'at the address its join named')
  t.is(refused.invite, b4a.toHex(invite.id), 'under its invite')
  t.is((await claimed(db, identity, writer))?.code, 'REFUSED', 'a claim made after finds nothing')
  t.is(await apply(db, db.writerKey, 'accept', { id }), null, 'and nothing is left to accept')
  t.absent((await db.get('members', identity.id)).data)
})

test('promise: a device removed takes the requests that stand on its key, linked through it or waiting on it', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const invite = await addressed(db, { confirm: true, reuse: true })
  const open = await addressed(db)
  // another device of the owner, seated, links a bare device; the owner's first links one too
  const phone = linked(identity)
  t.is(await seat(db, phone), null)
  const asks = async () => {
    const device = Identity.randomKeyPair()
    const writer = Identity.randomKeyPair().publicKey
    const bare = await Identity.bare(device)
    await apply(db, writer, 'join', named(db, invite, { identity: bare, writer }))
    return { device, writer, id: hid.encode(writer) }
  }
  const through = await asks()
  const direct = await asks()
  const late = await asks()
  const chain = phone.identity.link(through.device.publicKey)
  t.is(await apply(db, db.writerKey, 'accept', { id: through.id, proof: chain }), null)
  const own = identity.link(direct.device.publicKey)
  t.is(await apply(db, db.writerKey, 'accept', { id: direct.id, proof: own }), null)

  // a stranger who waits, then comes in through another invite on the same device
  const stranger = await Identity.create()
  const waits = Identity.randomKeyPair().publicKey
  const sits = Identity.randomKeyPair().publicKey
  await apply(db, waits, 'join', named(db, invite, { identity: stranger, writer: waits }))
  await apply(db, sits, 'join', named(db, open, { identity: stranger, writer: sits }))
  t.is(await claimed(db, stranger, sits), null)
  t.absent((await promise(db, waits))?.admitted, 'still waiting')

  t.is(await apply(db, db.writerKey, 'del-device', { id: phone.writer.id }), null)
  t.absent(await promise(db, through.writer), 'the promise linked through it goes')
  t.ok(await promise(db, direct.writer), 'one linked through another device stays')
  const refused = await apply(db, db.writerKey, 'accept', {
    id: late.id,
    proof: phone.identity.link(late.device.publicKey)
  })
  t.is(refused?.rule, 'removed', 'and it links nobody after')

  t.is(await apply(db, db.writerKey, 'del-device', { id: hid.encode(sits) }), null)
  t.absent(await promise(db, waits), 'the request that waited on a removed key goes')
})

test('accept: a waiting join whose device key was removed since is refused', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db, { confirm: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  await apply(db, writer, 'join', named(db, invite, { identity, writer }))
  // the removal recorded and the request still there, as a reorder leaves them
  const key = hid.encode(identity.device.publicKey)
  await db.view.insert(`@${db.ns}/removals`, { id: key, index: 0 })
  t.is((await apply(db, db.writerKey, 'accept', { id }))?.rule, 'removed')
  t.absent((await promise(db, writer))?.admitted, 'it is let in nowhere')
})

test('accept: a waiting join stands on the chain it proved: a device earlier on it removed, the accept is refused and the request goes with the removal', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db, { confirm: true, reuse: true })
  const open = await addressed(db)
  // her tablet, linked by her first device, asks in and waits; the first comes in by another invite
  const stranger = await Identity.create()
  const tablet = linked(stranger)
  const waits = tablet.writer.publicKey
  const id = hid.encode(waits)
  await apply(db, waits, 'join', named(db, invite, { identity: tablet.identity, writer: waits }))
  const first = stranger.device.publicKey
  t.alike(chainOf(await promise(db, waits))[0], first, 'the row keeps the chain its join proved')
  const sits = Identity.randomKeyPair().publicKey
  await apply(db, sits, 'join', named(db, open, { identity: stranger, writer: sits }))
  t.is(await claimed(db, stranger, sits), null)
  t.absent((await promise(db, waits))?.admitted, 'still waiting')

  // the removal recorded and the request still there, as a reorder leaves them
  const removal = { id: hid.encode(first), index: 0 }
  await db.view.insert(`@${db.ns}/removals`, removal)
  t.is((await apply(db, db.writerKey, 'accept', { id }))?.rule, 'removed')
  t.absent((await promise(db, waits))?.admitted, 'it is let in nowhere')
  await db.view.delete(`@${db.ns}/removals`, removal)

  t.is(await apply(db, db.writerKey, 'del-device', { id: hid.encode(sits) }), null)
  t.absent(await promise(db, waits), 'removed for real, the request that stood on it goes')
})

test('promise: a join keeps its proof for its chain alone: its seat keeps no chain, a linked one keeps its link', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const stranger = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', named(db, await addressed(db), { identity: stranger, writer }))
  const row = await promise(db, writer)
  t.ok(row.proof, 'the promise keeps the proof of its join')
  t.is(linkOf(row.proof), null, 'which is no link')
  t.is(await claimed(db, stranger, writer), null)
  t.is((await db.get('devices', hid.encode(writer))).data.proof, null, 'so its seat keeps none')

  const device = Identity.randomKeyPair()
  const other = Identity.randomKeyPair().publicKey
  const bare = await Identity.bare(device)
  const invite = await addressed(db, { confirm: true })
  await apply(db, other, 'join', named(db, invite, { identity: bare, writer: other }))
  const proof = identity.link(device.publicKey)
  t.is(await apply(db, db.writerKey, 'accept', { id: hid.encode(other), proof }), null)
  t.alike(linkOf((await promise(db, other)).proof), proof, 'a link replaces it with its chain')

  const guest = await Identity.create()
  const late = Identity.randomKeyPair().publicKey
  const asks = await addressed(db, { confirm: true })
  await apply(db, late, 'join', named(db, asks, { identity: guest, writer: late }))
  const { proof: proved } = await promise(db, late)
  t.is(await apply(db, db.writerKey, 'accept', { id: hid.encode(late) }), null)
  const kept = await promise(db, late)
  t.ok(kept.promised, 'accepted, a promise')
  t.alike(kept.proof, proved, 'an accept that links nobody keeps it')
})

test('join: a removed member comes back only through an invite minted after its removal', async (t) => {
  const { db } = await withRole(t, 'owner')
  const before = await minted(db, { reuse: true })
  const identity = await Identity.create()
  const first = Identity.randomKeyPair().publicKey
  await apply(db, first, 'join', joinOp(db, before, { identity, writer: first }))
  t.ok((await db.get('members', identity.id)).data, 'joined')
  t.is(await apply(db, db.writerKey, 'del-member', { id: identity.id }), null)

  const again = Identity.randomKeyPair().publicKey
  const reply = crypto.randomBytes(32)
  await apply(db, again, 'join', joinOp(db, before, { identity, writer: again, reply }))
  t.absent((await db.get('members', identity.id)).data, 'an invite from before admits nobody')
  const refused = await refusal(db, hid.encode(again))
  t.is(refused?.reason, 'removed', 'and the joiner is told why')
  t.alike(refused?.reply, reply, 'at the address its join named')

  // minted after the removal, straight into the view like the joins above
  const after = Invite.create({ key: db.key, address: db.address })
  await apply(db, db.writerKey, 'add-invite', inviteRow(b4a.toHex(after.id)))
  const back = Identity.randomKeyPair().publicKey
  await apply(db, back, 'join', joinOp(db, after, { identity, writer: back }))
  t.ok((await db.get('members', identity.id)).data, 'a newer one does')
})

test('join: a writer bound to another member is refused', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await minted(db, { reuse: true })
  const identity = await Identity.create()
  const writer = db.writerKey
  const err = await apply(db, writer, 'join', joinOp(db, invite, { identity, writer }))
  t.is(err?.code, 'REFUSED')
  t.absent((await db.get('members', identity.id)).data)
  t.is((await db.get('devices', hid.encode(writer))).data.memberId, db.identity.id)
})

test('join: a known member on another device keeps its record; a reusable invite stays', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await minted(db, { reuse: true })
  const identity = await Identity.create()
  const first = Identity.randomKeyPair().publicKey
  await apply(db, first, 'join', joinOp(db, invite, { identity, writer: first }))
  const record = (await db.get('members', identity.id)).data
  await apply(db, db.writerKey, 'set-member', { ...record, role: 'admin', updatedAt: 2 })

  const second = Identity.randomKeyPair().publicKey
  t.is(await apply(db, second, 'join', joinOp(db, invite, { identity, writer: second })), null)
  const after = (await db.get('members', identity.id)).data
  t.is(after.role, 'admin', 'the rank it was given since')
  t.alike(after.key, record.key, 'its first writer stays its key')
  t.is((await db.get('devices', hid.encode(second))).data?.memberId, identity.id)
  t.ok((await db.get('invites', b4a.toHex(invite.id))).data)
})

test('confirm: a join waits as a request; accepting it is capped by the invite and the accepter', async (t) => {
  const { db, as } = await withMember(t, 'member')
  const invite = await minted(db, { role: 'member', confirm: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  t.is(await apply(db, writer, 'join', joinOp(db, invite, { identity, writer })), null)
  t.absent((await db.get('members', identity.id)).data, 'not admitted yet')
  t.is((await db.get('requests', id)).data?.invite, b4a.toHex(invite.id))

  const above = await apply(db, db.writerKey, 'accept', { id, role: 'admin' })
  t.is(above?.code, 'REFUSED', 'the owner may grant admin, the invite may not')
  t.is(await as('accept', { id, role: 'reader' }), null, 'within it')
  t.is((await db.get('members', identity.id)).data?.role, 'reader')
  t.alike((await db.get('devices', id)).data?.key, identity.device.publicKey, 'its device key kept')
  t.is((await db.get('requests', id)).data?.admitted, true, 'admitted, owed its keys')
  t.absent((await db.get('invites', b4a.toHex(invite.id))).data, 'spent')
  t.is(await as('accept', { id, role: 'member' }), null, 'accepting it again does nothing')
  t.is((await db.get('members', identity.id)).data?.role, 'reader')
})

test('confirm: an invite above the accepter admits at most its rank', async (t) => {
  const { db, as } = await withMember(t, 'member')
  const invite = await minted(db, { role: 'admin', confirm: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  await apply(db, writer, 'join', joinOp(db, invite, { identity, writer }))
  t.is((await as('accept', { id }))?.code, 'REFUSED', 'a member cannot hand out admin')
  t.is(await as('accept', { id, role: 'member' }), null)
  t.is((await db.get('members', identity.id)).data?.role, 'member')
})

test('confirm: accepting or denying needs INVITE; only a join writes a request', async (t) => {
  const { db, as } = await withMember(t, 'reader')
  const invite = await minted(db, { confirm: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  await apply(db, writer, 'join', joinOp(db, invite, { identity, writer }))

  t.is((await as('accept', { id, role: 'reader' }))?.code, 'REFUSED', 'even at its own rank')
  t.is((await as('del-request', { id }))?.code, 'REFUSED')
  const forged = {
    id: 'x',
    identity: identity.publicKey,
    invite: b4a.toHex(invite.id),
    reply: b4a.alloc(32)
  }
  t.is((await apply(db, db.writerKey, 'add-request', forged))?.code, 'REFUSED')
  t.is((await apply(db, db.writerKey, 'set-request', forged))?.code, 'REFUSED')
  t.ok((await db.get('requests', id)).data, 'still waiting')
  t.is(await apply(db, db.writerKey, 'del-request', { id }), null)
  t.absent((await db.get('requests', id)).data, 'denied by the owner')
})

test('deny: a reader turns no join away', async (t) => {
  const { db } = await withRole(t, 'owner')
  // minted first: a write through db rebuilds the view without the joins applied straight into it
  const readers = await minted(db, { role: 'reader' })
  const gated = await minted(db, { confirm: true })
  const reader = await Identity.create()
  const own = Identity.randomKeyPair().publicKey
  await apply(db, own, 'join', joinOp(db, readers, { identity: reader, writer: own }))
  t.is((await db.get('devices', hid.encode(own))).data?.memberId, reader.id, 'a reader device')

  const joiner = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  await apply(db, writer, 'join', joinOp(db, gated, { identity: joiner, writer }))
  t.ok((await db.get('requests', id)).data, 'waiting')

  t.is((await apply(db, own, 'deny', { id }))?.code, 'REFUSED')
  t.ok((await db.get('requests', id)).data, 'still waiting')
  t.absent(await refusal(db, id), 'and not turned away')
  t.is(await apply(db, db.writerKey, 'deny', { id }), null)
  t.ok(await refusal(db, id), 'the owner turns it away')
})

test('join: a reader writes nothing, not through an optimistic op either', async (t) => {
  const after = { promote: async () => {} }
  const { db } = await withRole(t, 'owner', { spec: spec.handles.team, after })
  // minted first: a write through db rebuilds the view without the joins applied straight into it
  const readers = await minted(db, { role: 'reader' })
  const gated = await minted(db, { confirm: true })
  const reader = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', joinOp(db, readers, { identity: reader, writer }))
  const { data: device } = await db.get('devices', hid.encode(writer))
  t.is(device?.memberId, reader.id, 'its device has a row')

  const identity = await Identity.create()
  const joiner = Identity.randomKeyPair().publicKey
  const id = hid.encode(joiner)
  await apply(db, joiner, 'join', joinOp(db, gated, { identity, writer: joiner }))
  const accepted = await apply(db, writer, 'accept', { id, role: 'reader' })
  t.is(accepted?.code, 'REFUSED', 'no accepting, even at its own rank')
  const promoted = await apply(db, writer, 'promote', { memberId: reader.id, role: 'owner' })
  t.is(promoted?.code, 'REFUSED', 'no actions')
  t.is((await apply(db, writer, 'add-messages', { id: 'm', text: 'x' }))?.code, 'REFUSED')
})

test('confirm: revoking the invite turns its waiting joins away', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await minted(db, { confirm: true, reuse: true, expires: 99 })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', joinOp(db, invite, { identity, writer }))
  t.is(await apply(db, db.writerKey, 'del-invite', { id: b4a.toHex(invite.id) }), null)
  t.alike((await db.get('requests')).data, [])
  const refused = await refusal(db, hid.encode(writer))
  t.is(refused?.reason, 'revoked', 'told why')
  t.is(refused?.expires, 99, 'until the invite would have run out')
})

test('join: a spent or revoked invite turns its joins away; one the room never held is ignored', async (t) => {
  const { db } = await withRole(t, 'owner')
  const once = await minted(db)
  const revoked = await minted(db, { reuse: true })
  const stranger = Invite.create({ key: db.key, address: db.address })
  const join = async (invite) => {
    const identity = await Identity.create()
    const writer = Identity.randomKeyPair().publicKey
    t.is(await apply(db, writer, 'join', joinOp(db, invite, { identity, writer })), null)
    return hid.encode(writer)
  }
  t.absent(await refusal(db, await join(once)), 'the first joiner is admitted')
  t.is(await apply(db, db.writerKey, 'del-invite', { id: b4a.toHex(revoked.id) }), null)
  t.is((await spent(db, b4a.toHex(once.id)))?.reason, 'spent', 'the room keeps what it spent')

  t.is((await refusal(db, await join(once)))?.reason, 'spent')
  t.is((await refusal(db, await join(revoked)))?.reason, 'revoked')
  const unknown = await join(stranger)
  t.absent(await refusal(db, unknown), 'a stranger makes no member answer')
})

test('join: a writer has a request or a refusal, never both', async (t) => {
  const { db } = await withRole(t, 'owner')
  const gated = await minted(db, { confirm: true, reuse: true })
  const open = await minted(db, { reuse: true })
  const revoked = await minted(db, { reuse: true })
  await db.call('del-invite', { id: b4a.toHex(revoked.id) })
  const identity = await Identity.create()
  const joiner = (writer) => (invite) =>
    apply(db, writer, 'join', joinOp(db, invite, { identity, writer }))

  const waiting = Identity.randomKeyPair().publicKey
  const id = hid.encode(waiting)
  await joiner(waiting)(revoked)
  t.ok(await refusal(db, id), 'refused')
  await joiner(waiting)(gated)
  t.absent(await refusal(db, id), 'a join waiting for a member takes over from its refusal')
  await joiner(waiting)(revoked)
  t.absent(await refusal(db, id), 'and is answered through its request')
  t.ok((await db.get('requests', id)).data)

  const admitted = Identity.randomKeyPair().publicKey
  await joiner(admitted)(revoked)
  await joiner(admitted)(open)
  t.absent(await refusal(db, hid.encode(admitted)), 'an admission takes over too')
  t.is((await db.get('requests', hid.encode(admitted))).data?.admitted, true)
})

const refused = (db) => db.view.find(`@${db.ns}/refusals`, {}).toArray()

// a join on `invite` from a writer of its own, as `op` seals it: the writer's id
async function joined(db, invite, { op = joinOp, identity, ...ctx } = {}) {
  identity ??= await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const value = db.spec.dispatch.encode(`@${db.ns}/join`, op(db, invite, { identity, writer }))
  await db.dispatcher.dispatch(value, {
    view: db.view,
    host: noHost,
    key: writer,
    dbKey: db.key,
    ...ctx
  })
  return hid.encode(writer)
}

test("refusal: a hundred joins on one spent invite leave one row, the newest join's", async (t) => {
  const { db } = await withRole(t, 'owner')
  const once = await minted(db)
  const revoked = await addressed(db, { reuse: true })
  await db.call('del-invite', { id: b4a.toHex(revoked.id) })
  await joined(db, once)
  const identity = await Identity.create()

  let newest
  for (let i = 0; i < 100; i++) newest = await joined(db, once, { identity })
  const rows = await refused(db)
  t.is(rows.length, 1, 'one row')
  t.is(rows[0].id, newest, 'of the newest join')
  t.is(rows[0].reason, 'spent', 'which hears why')

  const other = await joined(db, revoked, { op: named, identity })
  await joined(db, once, { identity })
  const kept = await refused(db)
  t.is(kept.length, 2, 'one for each spent invite')
  t.is(kept.find((row) => row.id === other)?.reason, 'revoked', "the other invite's stays")
})

test('refusal: a request a member turned away keeps its row, whatever its invite turns away after', async (t) => {
  const { db } = await withRole(t, 'owner')
  const gated = await minted(db, { confirm: true, reuse: true })
  const open = await addressed(db, { reuse: true })
  const waiting = [await joined(db, gated), await joined(db, gated), await joined(db, gated)]
  const promised = await joined(db, open, { op: named })

  for (const id of waiting.slice(0, 2)) await apply(db, db.writerKey, 'deny', { id, reason: 'no' })
  t.alike(
    (await refused(db)).map((row) => row.id).sort(),
    waiting.slice(0, 2).sort(),
    'two denied, two rows'
  )
  await apply(db, db.writerKey, 'deny', { id: promised, reason: 'no' })
  await apply(db, db.writerKey, 'del-invite', { id: b4a.toHex(gated.id) })
  await apply(db, db.writerKey, 'del-invite', { id: b4a.toHex(open.id) })
  const turned = [...waiting, promised].sort()
  t.alike((await refused(db)).map((row) => row.id).sort(), turned, 'one row for each request')

  for (let i = 0; i < 5; i++) await joined(db, gated)
  for (let i = 0; i < 5; i++) await joined(db, open, { op: named })
  const rows = (await refused(db)).map((row) => row.id)
  t.is(rows.length, turned.length + 2, 'and one more for each invite, spent since')
  t.ok(
    turned.every((id) => rows.includes(id)),
    'the requests keep theirs'
  )
})

test("refusal: a database below the version that has an invite's secret keeps a row for each join, and at it a join stamped below is bounded too", async (t) => {
  const { since } = spec.meta
  const invite = { ...since.types['@cero/invite'], secret: 2 }
  const meta = {
    ...spec.meta,
    since: { ...since, types: { ...since.types, '@cero/invite': invite } }
  }
  const { db } = await withRole(t, 'owner', { spec: { ...spec, meta } })
  const revoked = await minted(db, { reuse: true })
  await db.call('del-invite', { id: b4a.toHex(revoked.id) })

  const before = [await joined(db, revoked), await joined(db, revoked), await joined(db, revoked)]
  t.alike(
    (await refused(db)).map((row) => row.id).sort(),
    [...before].sort(),
    'below it: a row each'
  )

  t.is(await apply(db, db.writerKey, 'upgrade', { version: 2 }), null)
  await joined(db, revoked, { stamp: 1 })
  const newest = await joined(db, revoked, { stamp: 1 })
  const rows = (await refused(db)).map((row) => row.id)
  t.alike(rows.sort(), [...before, newest].sort(), 'at it: one row for the joins since')
})

test('refusal: the joins a spent invite turned away leave the same row on every device, and after the view is applied again', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const a = await makePeer(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })
  const room = { topic, key: a.db.key, encryptionKey: a.db.encryptionKey }
  const b = await makePeer(t, testnet, { ...room, identity: await Identity.create() })
  await admit(a.db, b.db, 'admin')
  await waitFor(() => b.db.writable)

  const secret = crypto.randomBytes(32)
  const invite = Invite.create({ key: a.db.key, address: Mailbox.getAddress(secret), own: true })
  const id = b4a.toHex(invite.id)
  const stamp = await a.db.write([['add-invite', inviteRow(id, { secret, reuse: true })]])
  await a.db.call('del-invite', { id })
  let newest
  for (let i = 0; i < 3; i++) {
    const { db } = await makePeer(t, testnet, { ...room, identity: await Identity.create() })
    const payload = sealJoin(invite, db.identity, db.writerKey, crypto.randomBytes(32))
    await waitFor(() => spent(db, id))
    const op = db.spec.dispatch.encode(`@${db.ns}/join`, payload)
    await db.bee.append(wrap(stamp, op), { optimistic: true })
    newest = hid.encode(db.writerKey)
    for (const peer of [a, b]) await waitFor(() => refusal(peer.db, newest))
  }
  const seen = await refused(a.db)
  t.alike(
    seen.map((row) => row.id),
    [newest],
    'one row, of the newest join'
  )
  t.alike(await refused(b.db), seen, 'the same on another device')
  await a.db._rebuild()
  await waitFor(() => refusal(a.db, newest))
  t.alike(await refused(a.db), seen, 'and once the view is applied again')
})

// an identity the room let in and then took out
async function ousted(db, invite) {
  const identity = await Identity.create()
  await joined(db, invite, { identity })
  await apply(db, db.writerKey, 'del-member', { id: identity.id })
  return identity
}

test('refusal: fifty joins of one removed identity on a live invite leave one row, of the newest, and another removed identity keeps her own', async (t) => {
  const { db } = await withRole(t, 'owner')
  const open = await minted(db, { reuse: true })
  const asked = await minted(db, { reuse: true, confirm: true })
  const identity = await ousted(db, open)
  const other = await ousted(db, open)

  let newest
  for (let i = 0; i < 50; i++) newest = await joined(db, asked, { identity })
  const rows = await refused(db)
  t.is(rows.length, 1, 'one row')
  t.is(rows[0].id, newest, 'of the newest join')
  t.is(rows[0].reason, 'removed', 'which hears why')

  const hers = await joined(db, asked, { identity: other })
  await joined(db, asked, { identity: other })
  const last = await joined(db, asked, { identity })
  const kept = (await refused(db)).map((row) => row.id)
  t.is(kept.length, 2, 'one for each removed identity')
  t.ok(kept.includes(last) && !kept.includes(hers), 'the newest of each')
})

test("refusal: below the version that has an invite's secret a removed identity's joins on a live invite keep a row each", async (t) => {
  const { since } = spec.meta
  const invite = { ...since.types['@cero/invite'], secret: 2 }
  const meta = {
    ...spec.meta,
    since: { ...since, types: { ...since.types, '@cero/invite': invite } }
  }
  const { db } = await withRole(t, 'owner', { spec: { ...spec, meta } })
  const open = await minted(db, { reuse: true })
  const asked = await minted(db, { reuse: true, confirm: true })
  const identity = await ousted(db, open)

  const before = [await joined(db, asked, { identity }), await joined(db, asked, { identity })]
  t.alike(
    (await refused(db)).map((row) => row.id).sort(),
    [...before].sort(),
    'below it: a row each'
  )
  t.is(await apply(db, db.writerKey, 'upgrade', { version: 2 }), null)
  await joined(db, asked, { identity })
  const newest = await joined(db, asked, { identity })
  const rows = (await refused(db)).map((row) => row.id)
  t.alike(rows.sort(), [...before, newest].sort(), 'at it: one row for her joins since')
})

test('accept: with a proof, the joiner is admitted as a device of the accepter, under its member', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const invite = await minted(db, { confirm: true })
  const device = Identity.randomKeyPair()
  const bare = await Identity.bare(device)
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  t.is(await apply(db, writer, 'join', joinOp(db, invite, { identity: bare, writer })), null)
  const { data: waiting } = await db.get('requests', id)
  t.alike(waiting?.key, device.publicKey, 'the request carries the device key')
  t.absent((await db.get('members', bare.id)).data, 'a bare device is no member')

  const proof = identity.link(device.publicKey)
  t.is(await apply(db, db.writerKey, 'accept', { id, proof }), null)
  const { data: row } = await db.get('devices', id)
  t.is(row?.memberId, identity.id, 'seated under the accepter')
  t.alike(row?.key, device.publicKey)
  t.alike(row?.proof, proof, 'with the chain its reply will carry')
  t.is((await db.get('members')).data.length, 1, 'no member was added')
  t.is((await db.get('requests', id)).data?.admitted, true)
  t.absent((await db.get('invites', b4a.toHex(invite.id))).data, 'spent')
})

test("accept: a proof must chain the request's key to the accepter's own identity", async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const other = await Identity.create()
  const invite = await minted(db, { confirm: true, reuse: true })
  const device = Identity.randomKeyPair()
  const bare = await Identity.bare(device)
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  await apply(db, writer, 'join', joinOp(db, invite, { identity: bare, writer }))
  const wrong = {
    'another key': identity.link(Identity.randomKeyPair().publicKey),
    'another identity': other.link(device.publicKey),
    'not a proof': b4a.from('garbage')
  }
  for (const [why, proof] of Object.entries(wrong)) {
    t.is((await apply(db, db.writerKey, 'accept', { id, proof }))?.code, 'REFUSED', why)
  }
  t.absent((await db.get('devices', id)).data, 'nothing seated')
})

test('accept: a proof through a device removed since the join seats nothing', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const invite = await minted(db, { confirm: true })
  const phone = linked(identity)
  await seat(db, phone)
  const device = phone.identity.device
  const bare = await Identity.bare(device)
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  await apply(db, writer, 'join', joinOp(db, invite, { identity: bare, writer }))
  t.ok((await db.get('requests', id)).data, 'waiting')

  await apply(db, db.writerKey, 'del-writer', delWriterOp(phone.writer.publicKey))
  t.absent((await db.get('requests', id)).data, 'the request that waited on its key goes with it')
  const proof = identity.link(device.publicKey)
  t.is(await apply(db, db.writerKey, 'accept', { id, proof }), null, 'accepting it is nothing')
  t.absent((await db.get('devices', id)).data, 'nothing seated')
})

test('del-refusal: answering a refused join needs INVITE', async (t) => {
  const { db, as } = await withMember(t, 'reader')
  const invite = await minted(db)
  await db.call('del-invite', { id: b4a.toHex(invite.id) })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  await apply(db, writer, 'join', joinOp(db, invite, { identity, writer }))
  t.is((await as('del-refusal', { id }))?.code, 'REFUSED')
  t.ok(await refusal(db, id), 'still owed')
  t.is(await apply(db, db.writerKey, 'del-refusal', { id }), null)
  t.absent(await refusal(db, id), 'answered by the owner')
})

test('del-invite: a spent invite is forgotten by a member who can remove', async (t) => {
  const { db, as } = await withMember(t)
  const invite = await minted(db, { reuse: true })
  const id = b4a.toHex(invite.id)
  t.is(await apply(db, db.writerKey, 'del-invite', { id }), null)
  t.is((await spent(db, id))?.reason, 'revoked')
  t.is((await as('del-invite', { id }))?.code, 'REFUSED', 'a member cannot forget it')
  t.ok(await spent(db, id))
  t.is(await apply(db, db.writerKey, 'del-invite', { id }), null)
  t.absent(await spent(db, id), 'the owner does')
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
        proof: identity.sign(admission(db.key, writerKey, db.writerKey)),
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

// ─── add-device: the writer→role mapping is unauthenticated ───────────────

test('add-device: a writer cannot re-point its device row at another member', async (t) => {
  // a second writer as a plain member
  const b = await second('member')
  const attackerMemberId = b.id
  const { db, identity } = await withRole(t, 'owner', { members: [b.row] })
  const ownerMemberId = identity.id
  await seat(db, b)

  const deviceId = b.writer.id
  t.is(
    (await db.get('devices', deviceId)).data.memberId,
    attackerMemberId,
    'device starts bound to its own member'
  )

  // the escalation attempt: re-point the device row at the owner's member id
  await t.exception(
    db.call('add-device', { id: deviceId, memberId: ownerMemberId, updatedAt: Date.now() }),
    /REFUSED/,
    'a device row is written only by its own device'
  )

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

test('add-device: the device key stays the one its admission proved', async (t) => {
  const { db } = await withRole(t, 'owner')
  const id = hid.encode(db.writerKey)
  const { data: before } = await db.get('devices', id)
  const row = {
    id,
    name: 'renamed',
    key: Identity.randomKeyPair().publicKey,
    createdAt: 1,
    updatedAt: 2
  }
  t.is(await apply(db, db.writerKey, 'add-device', row), null)
  const { data: after } = await db.get('devices', id)
  t.is(after.name, 'renamed')
  t.alike(after.key, before.key, 'the key never comes off the wire')
})

// ─── demotion: does lowering a role revoke the writer? ────────────────────

test('set-member: demoting below WRITE revokes the writer seat', async (t) => {
  // a second member as a writer
  const b = await second('member')
  const { db } = await withRole(t, 'owner', { members: [b.row] })
  await seat(db, b)
  t.ok((await db.get('devices', b.writer.id)).data, 'admitted as a writer')

  // demote them to reader, watching what the demotion asks the host to revoke
  const revoked = []
  const host = { removeWriter: (k) => revoked.push(z32.encode(k)) }
  const demotion = { ...b.row, role: 'reader', createdAt: 1, updatedAt: Date.now() }
  await apply(db, db.writerKey, 'set-member', demotion, host)

  t.is((await db.get('members', b.id)).data.role, 'reader', 'the role row says reader')
  t.ok(revoked.includes(z32.encode(b.writer.publicKey)), 'and the writer seat was revoked')

  // the device row stays: it is how a key resolves to a member, and deleting it
  // would leave the demoted writer unresolvable — which the apply-time WRITE
  // gate reads as "not yet enrolled" and lets through
  t.ok((await db.get('devices', b.writer.id)).data, 'the device row stays')
})

// ─── add-file: WRITE gate ─────────────────────────────────────────────────

const fileId = (type = 'text/plain') =>
  encodeId(
    crypto.randomBytes(32),
    { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 2 },
    type
  )

test('add-file: a reader cannot add a file', async (t) => {
  const { db } = await withRole(t, 'reader')
  const id = fileId()
  await t.exception(db.call('add-file', { id, name: 'shot.png' }), /REFUSED/)
  t.absent((await db.get('files', id)).data, 'a reader has no WRITE — add-file rejected')
})

test('add-file: a member (WRITE) can add a file', async (t) => {
  const { db, identity } = await withRole(t, 'member')
  const id = fileId()
  await db.call('add-file', { id, name: 'shot.png' })
  const { data } = await db.get('files', id)
  t.ok(data, 'a member with WRITE added the file row')
  t.is(data.name, 'shot.png', 'name persisted')
  t.is(data.memberId, identity.id, 'memberId stamped from the signer→member backlink')
})

// ─── poison ops: malformed nodes must not crash peers ─────────────────────

test('poison op: garbage bytes from an admitted writer are skipped on every peer', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const aErrs = []
  const bErrs = []

  const a = await makePeer(t, testnet, { topic, onerror: (err) => aErrs.push(err) })
  await a.db.bootstrap({ name: 'a' })

  const bIdentity = await Identity.create()
  const b = await makePeer(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey,
    onerror: (err) => bErrs.push(err)
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  await admit(a.db, b.db)
  await waitFor(() => b.db.writable)

  await b.db.bee.append(b4a.from('garbage'))
  const { data: row } = await b.db.put('messages', { text: 'alive' })

  const onB = await waitFor(async () => (await b.db.get('messages', row.id)).data)
  const onA = await waitFor(async () => (await a.db.get('messages', row.id)).data)
  t.is(onB.text, 'alive', 'B skipped the poison node and applied the next valid op')
  t.is(onA.text, 'alive', 'A skipped the poison node and applied the next valid op')
  t.ok(bErrs.length > 0, 'B surfaced the skip via onerror')
  t.ok(aErrs.length > 0, 'A surfaced the skip via onerror')
})

// a device's own writes to its member row (a name, an avatar) never carry its view of its rank: a rank change it has
// not seen yet is never undone, and the write is never refused for it. Concurrent ops land in either order, so a
// few rounds, promoting and demoting in turn
test('set-member: an own-row write made before a rank change arrives keeps both', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const a = await makePeer(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })
  const b = await makePeer(t, testnet, { topic, key: a.db.key, encryptionKey: a.db.encryptionKey })
  await waitForConnection(a.network)
  await waitForConnection(b.network)
  await admit(a.db, b.db)
  await waitFor(() => b.db.writable)
  const id = b.identity.id
  const row = async (db) => (await db.get('members', id)).data
  for (let round = 0; round < 4; round++) {
    const role = round % 2 ? 'member' : 'admin'
    const name = `b${round}`
    await b.network.suspend()
    await a.db.set('members', { id, role })
    await b.db.set('members', { id, name })
    await b.network.resume()
    const both = await waitFor(
      async () => {
        const [onA, onB] = [await row(a.db), await row(b.db)]
        const done = (r) => r?.role === role && r?.name === name
        return done(onA) && done(onB) && [onA, onB]
      },
      { timeout: 20000 }
    ).catch(async () => [await row(a.db), await row(b.db)])
    t.alike(
      both.map((r) => [r?.role, r?.name]),
      [
        [role, name],
        [role, name]
      ],
      `round ${round}: ${role}, named ${name}, on both`
    )
  }
})

test('set: a member row sent without a role carries no rank change, and keeps the stored one', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const sent = []
  const write = db.write.bind(db)
  db.write = (ops) => {
    sent.push(...ops)
    return write(ops)
  }
  await db.set('members', { id: identity.id, name: 'renamed' })
  t.is(sent[0][1].role, '', 'an empty rank on the wire: no change')
  const { data } = await db.get('members', identity.id)
  t.alike([data.role, data.name], ['owner', 'renamed'])
})

// a replicated action with no local hook must surface: silently skipping it
// diverges this peer from everyone that ran it
test('missing action hook: a replicated action surfaces via onerror, apply continues', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const bErrs = []

  const a = await makePeer(t, testnet, {
    topic,
    spec: spec.handles.team,
    after: { promote: async () => {} }
  })
  await a.db.bootstrap({ name: 'a' })

  const bIdentity = await Identity.create()
  const b = await makePeer(t, testnet, {
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

  const onB = await waitFor(async () => (await b.db.get('messages', row.id)).data)
  t.is(onB.text, 'alive', 'B kept applying past the unhooked action')
  t.ok(
    bErrs.some((e) => e.code === 'UNKNOWN'),
    'B surfaced the missing hook via onerror'
  )
})

test('poison op: wrong-length key/proof fields are skipped, not crashed', async (t) => {
  const { db, identity } = await bootstrapped(t)
  const intruder = Identity.randomKeyPair()

  await db.call('add-writer', {
    master: identity.publicKey,
    writer: intruder.publicKey,
    proof: b4a.alloc(10),
    name: 'x',
    isMobile: false
  })
  t.absent(
    (await db.get('devices', z32.encode(intruder.publicKey))).data,
    'garbage proof skipped without admitting'
  )

  await db.call('add-writer', {
    master: b4a.alloc(16),
    writer: intruder.publicKey,
    proof: identity.sign(admission(db.key, intruder.publicKey, db.writerKey)),
    name: 'x',
    isMobile: false
  })
  t.absent(
    (await db.get('devices', z32.encode(intruder.publicKey))).data,
    'short master skipped without admitting'
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

// ─── roles: who may change whose rank, and no way around it ───────────────

const RANKS = ['owner', 'admin', 'member', 'reader']

const target = (role) => ({
  id: hid.encode(Identity.randomKeyPair().publicKey),
  key: Identity.randomKeyPair().publicKey,
  role,
  name: 't'
})

const allowed = (signer, from, to) =>
  ['owner', 'admin'].includes(signer) &&
  RANKS.indexOf(signer) <= RANKS.indexOf(to) &&
  RANKS.indexOf(signer) < RANKS.indexOf(from)

for (const signer of RANKS) {
  test(`roles: what a ${signer} may change, by rank`, async (t) => {
    const moves = RANKS.flatMap((from) =>
      RANKS.filter((to) => to !== from).map((to) => ({ to, record: target(from) }))
    )
    const { db, as, id } = await withMember(
      t,
      signer,
      moves.map((m) => m.record)
    )
    for (const { to, record } of moves) {
      const from = record.role
      const err = await as('set-member', { ...record, role: to, updatedAt: Date.now() })
      const { role } = (await db.get('members', record.id)).data
      if (allowed(signer, from, to)) t.is(role, to, `${from} → ${to}`)
      else t.ok(err?.code === 'REFUSED' && role === from, `${from} → ${to} refused`)
    }
    for (const to of RANKS) {
      if (to === signer) continue
      const { data: self } = await db.get('members', id)
      const err = await as('set-member', { ...self, role: to, updatedAt: Date.now() })
      t.ok(err?.code === 'REFUSED', `its own rank: ${signer} → ${to} refused`)
    }
  })
}

test('roles: a promotion gives the writer seats back, a demotion takes them', async (t) => {
  const b = await second('member', { createdAt: 1, updatedAt: 1 })
  const { db } = await withRole(t, 'owner', { members: [b.row] })
  await seat(db, b)

  const seats = { added: [], removed: [] }
  const host = {
    addWriter: async (k) => seats.added.push(z32.encode(k)),
    removeWriter: async (k) => seats.removed.push(z32.encode(k))
  }
  const asOwner = (payload) => apply(db, db.writerKey, 'set-member', payload, host)
  await asOwner({ ...b.row, role: 'reader', updatedAt: Date.now() })
  t.ok(seats.removed.includes(b.writer.id), 'demoted below write: its writer goes')
  await asOwner({ ...b.row, role: 'member', updatedAt: Date.now() })
  t.ok(seats.added.includes(b.writer.id), 'promoted back: its writer returns')
})

test('escalation: add-writer cannot attach a writer to a higher rank', async (t) => {
  const { db, as, owner, id, writer, member, sign } = await withMember(t, 'member')
  const err = await as('add-writer', {
    master: member.publicKey,
    writer: writer.publicKey,
    proof: sign(admission(db.key, writer.publicKey, writer.publicKey)),
    memberId: owner.id,
    ts: Date.now()
  })
  t.is(err?.code, 'REFUSED')
  t.is((await db.get('devices', writer.id)).data.memberId, id, 'no writer acts as the owner')
})

test('escalation: add-writer cannot move an enrolled writer to another member', async (t) => {
  const other = target('member')
  const { db, as, id, writer, member, sign } = await withMember(t, 'admin', [other])
  const err = await as('add-writer', {
    master: member.publicKey,
    writer: writer.publicKey,
    proof: sign(admission(db.key, writer.publicKey, writer.publicKey)),
    memberId: other.id,
    ts: Date.now()
  })
  t.is(err?.code, 'REFUSED')
  t.is((await db.get('devices', writer.id)).data.memberId, id)
})

test('escalation: add-writer never seats another core, a member device or not', async (t) => {
  const other = target('member')
  const { db, as, writer, member, sign } = await withMember(t, 'member', [other])
  for (const key of [Identity.randomKeyPair().publicKey, other.key]) {
    const err = await as('add-writer', {
      master: member.publicKey,
      writer: key,
      proof: sign(admission(db.key, key, writer.publicKey)),
      memberId: other.id,
      ts: Date.now()
    })
    t.is(err, null, 'skipped: a device seats only itself')
    t.absent((await db.get('devices', hid.encode(key))).data)
  }
})

// ─── the rest of the view: every record keeps its rank rule ─────────────

test('invites: an invite grants at most its minter rank', async (t) => {
  const { db, as } = await withMember(t, 'member')
  const refused = await as('add-invite', inviteRow('up', { role: 'owner' }))
  t.is(refused?.code, 'REFUSED')
  t.absent((await db.get('invites', 'up')).data, 'no owner invite from a member')
  t.is(await as('add-invite', inviteRow('ok')), null)
})

test('invites: altering one keeps its rank capped', async (t) => {
  const { db, as } = await withMember(t, 'admin')
  await db.call('add-invite', inviteRow('i'))
  t.is((await as('set-invite', inviteRow('i', { role: 'owner' })))?.code, 'REFUSED')
  t.is((await db.get('invites', 'i')).data.role, 'member')
  t.is(await as('set-invite', inviteRow('i', { reuse: true })), null, 'within its rank it may')
})

test('invites: revoking one needs a rank that could grant it', async (t) => {
  const { db, as } = await withMember(t, 'admin')
  await db.call('add-invite', inviteRow('owner', { role: 'owner', reuse: true }))
  await db.call('add-invite', inviteRow('admin', { role: 'admin', reuse: true }))
  t.is((await as('del-invite', { id: 'owner' }))?.code, 'REFUSED')
  t.ok((await db.get('invites', 'owner')).data, 'an admin cannot revoke an owner invite')
  t.is(await as('del-invite', { id: 'admin' }), null, 'but revokes one it could grant')
})

test('devices: a device record is written only by its own device', async (t) => {
  const { db, as, id, writer, member } = await withMember(t, 'reader')
  const invite = await minted(db, { role: 'reader' })
  // a reader's device row comes from its join
  const join = joinOp(db, invite, { identity: member, writer: writer.publicKey })
  await apply(db, writer.publicKey, 'join', join)
  t.is((await as('add-device', { id: '!', updatedAt: 1 }))?.code, 'REFUSED')
  t.absent((await db.get('devices', '!')).data, 'no made-up record')
  const owners = hid.encode(db.writerKey)
  t.is((await as('set-device', { id: owners, name: 'pwned', updatedAt: 1 }))?.code, 'REFUSED')
  t.not((await db.get('devices', owners)).data.name, 'pwned')
  t.is(
    await as('set-device', { id: writer.id, name: 'mine', updatedAt: 1 }),
    null,
    'its own record it may name'
  )
  t.is(
    await db.call('del-member', { id }).then(
      () => null,
      (e) => e
    ),
    null,
    'and it stays removable'
  )
})

test('singles: wiping one needs write', async (t) => {
  const { db, as } = await withMember(t, 'reader')
  await db.set('profile', { name: 'owner' })
  t.is((await as('del-profile', { id: '' }))?.code, 'REFUSED')
  t.ok((await db.get('profile')).data, 'the single survives')
})

test('add-member: an id that is not an identity is refused, even at genesis', async (t) => {
  const record = { id: 'x', key: Identity.randomKeyPair().publicKey, role: 'reader' }
  await t.exception(withRole(t, 'owner', { members: [record] }), /REFUSED/)
})

test('files: a member cannot overwrite or drop another member file record', async (t) => {
  const { db, as } = await withMember(t, 'member')
  const id = fileId()
  await db.call('add-file', { id, name: 'scan.pdf', stamp: 1 })
  t.is((await as('add-file', { id, name: 'x', stamp: 9 }))?.code, 'REFUSED')
  t.is((await as('set-file', { id, name: 'x', stamp: 9 }))?.code, 'REFUSED')
  t.is((await as('del-file', { id }))?.code, 'REFUSED')
  const { data } = await db.get('files', id)
  t.is(data.name, 'scan.pdf')
  t.is(data.stamp, 1)
})

test('files: an id that is no file id is refused at apply, as a file row and in a t.file field', async (t) => {
  const { db, as } = await withMember(t, 'member')
  const bad = 'not-a-file-id'
  const row = { id: 'm', text: 'x', createdAt: 1, updatedAt: 1 }
  t.is((await as('add-file', { id: bad }))?.code, 'REFUSED', 'a file row')
  t.is((await as('add-file', { id: '' }))?.code, 'REFUSED', 'an empty one')
  t.is((await as('add-messages', { ...row, photo: bad }))?.code, 'REFUSED', 'a collection field')
  t.is((await as('set-profile', { photo: bad }))?.code, 'REFUSED', 'a single field')
  t.absent((await db.get('files', bad)).data)
  t.absent((await db.get('messages', 'm')).data)
  t.absent((await db.get('profile')).data)

  const good = fileId()
  t.is(await as('add-file', { id: good }), null, 'a file id lands')
  t.is(await as('add-messages', { ...row, photo: good }), null, 'in a field too')
  t.is(await as('add-messages', { ...row, id: 'n' }), null, 'and a field left out')
  t.is((await as('set-messages', { id: 'm', photo: bad }))?.code, 'REFUSED', 'an edit to one')
  t.is((await db.get('messages', 'm')).data.photo, good)
  await t.exception(db.put('messages', { text: 'y', photo: bad }), /REFUSED/, 'the writer hears it')
})

test('files: an id lands at apply whatever type it holds', async (t) => {
  const { db, as } = await withMember(t, 'member')
  const old = fileId('image')
  t.is(await as('add-file', { id: old }), null, 'a file row an earlier build made')
  t.is(await as('set-profile', { photo: old }), null, 'in a t.file field')
  t.is(await as('set-profile', { name: 'b', photo: old }), null, 'and a merge that carries it')
  t.is((await db.get('profile')).data.name, 'b')
})

test('escalation: a self-admission cannot move a seated writer to another identity', async (t) => {
  const other = await second('member')
  const { db, id, writer, member } = await withMember(t, 'member', [other.row])
  await seat(db, { identity: member, writer })
  const err = await seat(db, { identity: other.identity, writer })
  t.is(err?.code, 'REFUSED')
  t.is((await db.get('devices', writer.id)).data.memberId, id)
})

test('genesis: a room emptied of members is not new again', async (t) => {
  const { db, identity } = await withRole(t, 'owner')
  const self = (verb, payload) => apply(db, db.writerKey, verb, payload)
  t.is(await self('del-member', { id: identity.id }), null)
  t.absent((await db.get('members', identity.id)).data, 'no member left')
  const founder = Identity.randomKeyPair()
  const record = {
    id: hid.encode(founder.publicKey),
    key: founder.publicKey,
    role: 'owner',
    createdAt: 1,
    updatedAt: 1
  }
  t.is((await self('add-member', record))?.code, 'REFUSED')
  t.absent((await db.get('members', record.id)).data, 'nobody re-founds it')
})

test('rotate-key: an announcement whose commitment is not 32 bytes is no epoch', async (t) => {
  const { db } = await withRole(t, 'owner')
  const epochs = () => db.view.find(`@${db.ns}/epochs`, {}).toArray()
  const announce = (stamp, commit) => ({
    epoch: 0,
    stamp,
    wrapped: b4a.alloc(64, 1),
    commit,
    createdAt: 1
  })
  t.is(await apply(db, db.writerKey, 'rotate-key', announce(5, b4a.alloc(16, 1))), null)
  t.is(await apply(db, db.writerKey, 'rotate-key', announce(6, null)), null)
  t.is((await epochs()).length, 0, 'none landed')
  t.is(await apply(db, db.writerKey, 'rotate-key', announce(7, b4a.alloc(32, 1))), null)
  t.is((await epochs()).length, 1, 'a 32-byte one does')
})

// ─── a rotation owed ──────────────────────────────────────────────────────

// what the log keeps: 1 while a rotation is owed, 0 once one cleared it, null when none ever was
const owed = async (db) =>
  (await db.view.get(`@${db.ns}/counters`, { name: '_owed' }))?.value ?? null

// a rotation naming these writers, as its device announces it
let stamps = 0
const rotation = (ids) => ({
  epoch: 0,
  stamp: ++stamps,
  wrapped: c.encode(
    wraps,
    ids.map((id) => ({ id, box: b4a.alloc(48, 1) }))
  ),
  commit: b4a.alloc(32, 1),
  createdAt: 1
})

// the owner's room with its key check held back: these read what apply stored
async function owing(t, opts) {
  const { db } = await withRole(t, 'owner', opts)
  db.rotation._audit = async () => {}
  const me = hid.encode(db.writerKey)
  const rotate = (...ids) => apply(db, db.writerKey, 'rotate-key', rotation([me, ...ids]))
  return { db, rotate }
}

test('owed: a join, a new device and a promise owe no rotation; a seat dropped, a member removed and a member leaving each owe one', async (t) => {
  const b = await second('member')
  const left = await second('member')
  const { db, rotate } = await owing(t, { members: [b.row, left.row] })
  const invite = await addressed(db, { reuse: true })
  const joiner = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const phone = linked(b.identity)
  const id = hid.encode(phone.writer.publicKey)

  t.is(await seat(db, b), null)
  t.is(await seat(db, left), null)
  t.is(await seat(db, phone), null)
  t.is(await apply(db, writer, 'join', named(db, invite, { identity: joiner, writer })), null)
  t.ok((await promise(db, writer))?.promised)
  t.is(await owed(db), null, 'a member seated, another device of hers and a promise owe nothing')

  t.is(await apply(db, b.writer.publicKey, 'del-device', { id }), null)
  t.is(await owed(db), 1, 'a device its own member took out owes one')
  t.is(await rotate(hid.encode(b.writer.publicKey), hid.encode(left.writer.publicKey)), null)
  t.is(await owed(db), 0, 'cleared by a rotation that names only seated devices')

  t.is(await apply(db, left.writer.publicKey, 'del-member', { id: left.id }), null)
  t.is(await owed(db), 1, 'a member leaving owes one')
  t.is(await rotate(hid.encode(b.writer.publicKey)), null)
  t.is(await owed(db), 0)

  t.is(await claimed(db, joiner, writer), null)
  t.is(await owed(db), 0, 'a promise kept owes nothing')
  t.is(await apply(db, db.writerKey, 'del-member', { id: b.id }), null)
  t.is(await owed(db), 1, 'a member removed owes one')
})

test('owed: a promise withdrawn owes a rotation: denied, its invite revoked, swept with its writer, or dropped before it was kept; one settled once kept owes none', async (t) => {
  const { db, rotate } = await owing(t)
  const invite = await addressed(db, { reuse: true })
  const letIn = async () => {
    const identity = await Identity.create()
    const writer = Identity.randomKeyPair().publicKey
    t.is(await apply(db, writer, 'join', named(db, invite, { identity, writer })), null)
    return { identity, writer, id: hid.encode(writer) }
  }
  const cleared = async () => {
    t.is(await rotate(), null)
    t.is(await owed(db), 0)
  }

  const kept = await letIn()
  t.is(await claimed(db, kept.identity, kept.writer), null)
  t.is(await apply(db, db.writerKey, 'del-request', { id: kept.id }), null)
  t.is(await owed(db), null, 'settled once its device sat: nothing owed')

  const denied = await letIn()
  t.is(await apply(db, db.writerKey, 'deny', { id: denied.id }), null)
  t.is(await owed(db), 1, 'denied')
  await cleared()

  const dropped = await letIn()
  t.is(await apply(db, db.writerKey, 'del-request', { id: dropped.id }), null)
  t.is(await owed(db), 1, 'dropped with no device of hers seated')
  await cleared()

  const swept = await letIn()
  t.is(await apply(db, db.writerKey, 'del-writer', delWriterOp(swept.writer)), null)
  t.is(await owed(db), 1, 'swept with its writer')
  await cleared()

  await letIn()
  t.is(await apply(db, db.writerKey, 'del-invite', { id: b4a.toHex(invite.id) }), null)
  t.is(await owed(db), 1, 'its invite revoked')
})

test('owed: a rotation clears it where every device it names is seated or promised, and leaves it owed where one is not', async (t) => {
  const b = await second('member')
  const { db, rotate } = await owing(t, { members: [b.row] })
  const invite = await addressed(db)
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const seated = hid.encode(b.writer.publicKey)
  t.is(await seat(db, b), null)
  t.is(await apply(db, writer, 'join', named(db, invite, { identity, writer })), null)

  t.is(await rotate(seated, hid.encode(writer)), null)
  t.is(await owed(db), 0, 'a seated device and a promised one: nothing owed')
  t.is(await rotate(hid.encode(Identity.randomKeyPair().publicKey)), null)
  t.is(await owed(db), 1, 'a device with no seat and no promise: one more is owed')
  t.is(await rotate(seated), null)
  t.is(await owed(db), 0)

  // a removal that carries its rotation, and one sealed before a removal it crossed
  t.is(await apply(db, db.writerKey, 'del-member', { id: b.id }), null)
  t.is(await owed(db), 1)
  t.is(await rotate(), null)
  t.is(await owed(db), 0, 'the rotation a removal carries clears what it owed')
  t.is(await rotate(seated), null)
  t.is(await owed(db), 1, 'one that names the device removed before it landed leaves it owed')
})

test('deny: one that lands after the claim it raced drops the request, with no refusal and nothing owed', async (t) => {
  const { db } = await withMember(t, 'member')
  const invite = await addressed(db, { reuse: true })
  const here = await Identity.create()
  const sat = Identity.randomKeyPair().publicKey
  await apply(db, sat, 'join', named(db, invite, { identity: here, writer: sat }))
  t.is(await claimed(db, here, sat), null, 'the claim lands first')
  const before = await owed(db)
  t.is(await apply(db, db.writerKey, 'deny', { id: hid.encode(sat), reason: 'no' }), null)
  t.absent(await promise(db, sat), 'the request goes')
  t.ok((await db.get('members', here.id)).data, 'still a member')
  t.ok((await db.get('devices', hid.encode(sat))).data, 'still seated')
  t.absent(await refusal(db, hid.encode(sat)), 'a seated device has no refusal of its join')
  t.is(await owed(db), before, 'and nothing is owed')
})

test('del-request: a promise no device claimed is withdrawn only by one who may remove', async (t) => {
  const { db, as } = await withMember(t, 'member')
  const invite = await addressed(db)
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const id = hid.encode(writer)
  await apply(db, writer, 'join', named(db, invite, { identity, writer }))
  t.is((await as('deny', { id }))?.rule, 'remove', 'a member may not deny a promise')
  t.is((await as('del-request', { id }))?.rule, 'remove', 'nor drop it')
  t.ok(await promise(db, writer), 'the promise stands')
  t.is(await owed(db), null, 'nothing owed')
  t.is(await claimed(db, identity, writer), null, 'the joiner still claims')
  t.is(await as('del-request', { id }), null, 'kept, a member who may invite settles it')
  t.absent(await promise(db, writer))
  t.is(await owed(db), null)
})

test('removal: a promise no device claimed goes with it, its single-use invite used up or not, and hears why', async (t) => {
  const { db, id } = await withMember(t, 'member')
  const once = await addressed(db)
  const many = await addressed(db, { reuse: true })
  const asked = await addressed(db, { confirm: true })
  const x = await Identity.create()
  const xw = Identity.randomKeyPair().publicKey
  const y = await Identity.create()
  const yw = Identity.randomKeyPair().publicKey
  const z = await Identity.create()
  const zw = Identity.randomKeyPair().publicKey
  await apply(db, xw, 'join', named(db, once, { identity: x, writer: xw }))
  await apply(db, yw, 'join', named(db, many, { identity: y, writer: yw }))
  await apply(db, zw, 'join', named(db, asked, { identity: z, writer: zw }))
  t.is(await apply(db, db.writerKey, 'accept', { id: hid.encode(zw) }), null)
  t.ok((await promise(db, xw))?.promised)
  t.ok((await promise(db, zw))?.promised)
  t.is(await apply(db, db.writerKey, 'del-member', { id }), null)
  t.absent(await promise(db, yw), 'under a reusable invite')
  t.absent(await promise(db, xw), 'and under a single-use one, used up by its join')
  t.is((await refusal(db, hid.encode(xw)))?.reason, 'removed')
  t.is((await claimed(db, x, xw))?.code, 'REFUSED', 'it claims nothing after')
  t.absent(await live(db, asked), 'the invite that waits is used up by its accept')
  t.ok((await promise(db, zw))?.promised, "and the promise a member's accept made stays")
  t.absent(await refusal(db, hid.encode(zw)))
  t.is(await claimed(db, z, zw), null, 'its device claims after')
  t.is((await db.get('devices', hid.encode(zw))).data?.memberId, z.id)
})

test('removal: a promise that goes with its device or its member leaves a refusal', async (t) => {
  const { db } = await withRole(t, 'owner')
  const invite = await addressed(db, { reuse: true })
  // one that waits for an accept, which a removal leaves: a member's device is let in at once
  const asked = await addressed(db, { reuse: true, confirm: true })
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  const again = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', named(db, invite, { identity, writer }))
  t.is(await claimed(db, identity, writer), null)
  await apply(db, again, 'join', named(db, asked, { identity, writer: again }))
  t.ok((await promise(db, again))?.promised)
  t.is(await apply(db, db.writerKey, 'del-device', { id: hid.encode(writer) }), null)
  t.absent(await promise(db, again))
  t.is((await refusal(db, hid.encode(again)))?.reason, 'removed', 'made to a device removed')
  t.absent(await refusal(db, hid.encode(writer)), 'the device that sat has none')

  const tablet = await Identity.create({ seed: identity.seed })
  const other = Identity.randomKeyPair().publicKey
  await apply(db, other, 'join', named(db, asked, { identity: tablet, writer: other }))
  t.ok((await promise(db, other))?.promised)
  t.is(await apply(db, db.writerKey, 'del-member', { id: identity.id }), null)
  t.absent(await promise(db, other))
  t.is((await refusal(db, hid.encode(other)))?.reason, 'removed', 'made to a member removed')
})

test('removal: one who left, let back in by an accept on a single-use invite older than her leaving, keeps her promise through it', async (t) => {
  const { db, id } = await withMember(t, 'member')
  const first = await addressed(db, { reuse: true })
  const once = await addressed(db)
  const identity = await Identity.create()
  const writer = Identity.randomKeyPair().publicKey
  await apply(db, writer, 'join', named(db, first, { identity, writer }))
  t.is(await claimed(db, identity, writer), null)
  t.is(await apply(db, writer, 'del-member', { id: identity.id }), null, 'she leaves')

  const again = Identity.randomKeyPair().publicKey
  await apply(db, again, 'join', named(db, once, { identity, writer: again }))
  t.absent((await promise(db, again))?.admitted, 'she waits, though the invite asks for no accept')
  t.is(await apply(db, db.writerKey, 'accept', { id: hid.encode(again) }), null)
  t.ok((await promise(db, again))?.promised)
  t.is((await spent(db, b4a.toHex(once.id)))?.confirm, true, 'the invite is spent by an accept')

  t.is(await apply(db, db.writerKey, 'del-member', { id }), null)
  t.ok((await promise(db, again))?.promised, 'so the promise a member made stays')
  t.absent(await refusal(db, hid.encode(again)))
  t.is(await claimed(db, identity, again), null, 'and her device claims after')
  t.is((await db.get('devices', hid.encode(again))).data?.memberId, identity.id)
})
