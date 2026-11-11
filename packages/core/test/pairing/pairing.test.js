import test from 'brittle'
import AbortController from 'bare-abort-controller'
import b4a from 'b4a'
import z32 from 'z32'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import hid from 'hypercore-id-encoding'
import Hypercore from 'hypercore'
import encoding from 'autobee/lib/encoding.js'

import { Network } from '../../src/network/index.js'
import { Identity } from '../../src/identity/index.js'
import { Database } from '../../src/database/index.js'
import { Pairing } from '../../src/pairing/index.js'
import { Invite } from '../../src/pairing/invite.js'
import { Response, STATUS_ACCEPTED } from '../../src/pairing/response.js'
import { Mailbox } from '../../src/mailbox/index.js'
import { getEncoding } from '../../src/lib/spec/index.js'
import { CeroError } from '../../src/lib/errors.js'
import { spec } from '../fixtures/spec/index.js'

import { makeStore, makeTestnet, makeBlindPeer, waitFor } from '../helpers/index.js'

test.configure({ timeout: 60000 })

async function makeMailbox(t, testnet, opts = {}) {
  const identity = await Identity.create()
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const net = new Network({ bootstrap: testnet.bootstrap, store, ...opts })
  await net.ready()
  t.teardown(() => net.close().catch(() => {}), { order: 2 })
  const mailbox = new Mailbox(net)
  t.teardown(() => mailbox.close().catch(() => {}), { order: 1 })
  return { mailbox, net, identity }
}

// a member: the owner of a fresh database, answering its joins
async function makeHost(t, testnet, { mirrors } = {}) {
  const { mailbox, net, identity } = await makeMailbox(t, testnet, { mirrors })
  const db = new Database({
    store: net.store,
    identity,
    network: net,
    spec,
    encryptionKey: Identity.randomBytes(32)
  })
  await db.ready()
  await db.bootstrap({ name: 'host' })
  t.teardown(() => db.close().catch(() => {}), { order: 1 })
  const pairing = new Pairing({ mailbox, db })
  await pairing.ready()
  t.teardown(() => pairing.close().catch(() => {}), { order: 0 })
  return { pairing, mailbox, net, db, identity }
}

async function makeJoiner(t, testnet, { mirrors } = {}) {
  const { mailbox, net, identity } = await makeMailbox(t, testnet, { mirrors })
  const join = (invite, opts = {}) => Pairing.join(mailbox, invite, { identity, spec, ...opts })
  return { mailbox, net, identity, join }
}

async function makeHostJoiner(t, testnet, opts = {}) {
  return { host: await makeHost(t, testnet, opts), joiner: await makeJoiner(t, testnet) }
}

// another member of the host's database, on its own device, answering its joins too
async function makeMember(t, testnet, host, role) {
  const { mailbox, net, identity, join } = await makeJoiner(t, testnet)
  const { key, encryptionKey, epochs, writer } = await join(await host.pairing.invite({ role }))
  const opts = { key, encryptionKey, epochs, keyPair: writer }
  const db = new Database({ store: net.store, identity, network: net, spec, ...opts })
  await db.ready()
  t.teardown(() => db.close().catch(() => {}), { order: 1 })
  await waitFor(() => db.writable)
  const pairing = new Pairing({ mailbox, db })
  await pairing.ready()
  t.teardown(() => pairing.close().catch(() => {}), { order: 0 })
  return { pairing, db, identity }
}

const sample = () => ({
  key: crypto.randomBytes(32),
  address: crypto.randomBytes(32),
  link: { key: crypto.randomBytes(32), length: 1 }
})
const invites = async (db) => (await db.get('invites')).data
const member = async (db, identity) =>
  (await db.get('members', hid.encode(identity.publicKey))).data
const refusals = (db) => db.view.find(`@${db.ns}/refusals`, {}).toArray()
const spent = (db) => db.view.find(`@${db.ns}/spent`, {}).toArray()
const waiting = async (db) => (await db.get('requests', { admitted: false })).data
// the first join waiting on a confirm invite, once the database holds it
const asked = (db) => waitFor(async () => (await waiting(db))[0])
const code = async (answer) => (await answer.catch((e) => e))?.code
// resolves once the database applied an op of `name`, local or replicated, and its view shows it
const applied = (db, op, name) =>
  new Promise((resolve) => {
    const onapply = (row) => {
      if (row.op !== op || row.name !== name) return
      db.off('apply', onapply)
      // readable once its batch is in the view, whether or not it changed a row
      db.bee.updated().then(() => resolve(row))
    }
    db.on('apply', onapply)
  })

// ─── construction / lifecycle ──────────────────────────────────────────────

test('construction: a mailbox and a database', async (t) => {
  const testnet = await makeTestnet(t)
  const { mailbox } = await makeMailbox(t, testnet)
  t.exception.all(() => new Pairing({ db: {} }), /mailbox/)
  t.exception.all(() => new Pairing({ mailbox }), /db/)
})

test('ready() + close() lifecycle, both idempotent', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing } = await makeHost(t, testnet)
  await pairing.ready()
  t.ok(pairing.opened)
  await pairing.close()
  await pairing.close()
  t.ok(pairing.closed)
})

test('sync: one still reading as its database closes ends as closed', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing, db } = await makeHost(t, testnet)
  // its read of the requests resolves late, as from a slow disk
  const get = db.get.bind(db)
  let reached
  let release
  const parked = new Promise((resolve) => (reached = resolve))
  const held = new Promise((resolve) => (release = resolve))
  db.get = async (...args) => {
    const read = await get(...args)
    if (args[0] === 'requests') {
      reached()
      await held
    }
    return read
  }
  const syncing = pairing._sync()
  await parked
  await db.close()
  release()
  t.is(await code(syncing), 'CLOSED', 'as its other reads do, not on a view that is gone')
})

// runs `onread` the moment a join's reply block is read, its row still on its way to the box
function onReplyRead(mailbox, onread) {
  const box = mailbox.inbox
  const put = box.put
  let read = false
  box.put = async (mail) => {
    if (!read && !mail.handled) {
      read = true
      await onread()
    }
    return put(mail)
  }
}

test('join: one stopped as its reply was read gets it when the same writer joins again', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const writer = crypto.keyPair()
  const invite = await host.pairing.invite()
  const stop = new AbortController()
  onReplyRead(joiner.mailbox, () => stop.abort())

  t.is(await code(joiner.join(invite, { writer, timeout: 0, signal: stop.signal })), 'CLOSED')
  await waitFor(async () => (await host.db.get('requests')).data.length === 0)
  t.pass('its inviter counts the reply delivered')
  const again = await joiner.join(invite, { writer, timeout: 15000 }).catch((err) => err)
  t.alike(again.key, host.db.key, 'the one that resumes gets the answer')
})

test('join: taken over as its reply is read, the attempt that took over gets it', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const writer = crypto.keyPair()
  const invite = await host.pairing.invite()
  // its inviter has counted the reply delivered and offers it no more, then, as with a newer invite, the
  // attempt in flight stops and the same writer joins again at once
  const stop = new AbortController()
  let second = null
  onReplyRead(joiner.mailbox, async () => {
    await waitFor(async () => (await host.db.get('requests')).data.length === 0)
    stop.abort()
    second = joiner.join(invite, { writer, timeout: 5000 }).catch((err) => err)
  })

  t.is(await code(joiner.join(invite, { writer, timeout: 0, signal: stop.signal })), 'CLOSED')
  const again = await second
  t.alike(again.key, host.db.key, 'the attempt that took over gets the answer')
})

// ─── invites ───────────────────────────────────────────────────────────────

test('invite: a z32 string, kept in the database', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing, db } = await makeHost(t, testnet)
  const invite = await pairing.invite({ role: 'reader', ttl: '1h', reuse: true })
  t.ok(/^[ybndrfg8ejkmcpqxot1uwisza345h769]+$/.test(invite))

  const [record] = await invites(db)
  const parsed = Invite.parse(invite)
  t.is(record.id, b4a.toHex(parsed.id))
  t.is(record.role, 'reader')
  t.is(record.reuse, true)
  t.is(record.wrapped, undefined, 'no secret: apply checks the invite by its public id')
  t.ok(Math.abs(parsed.expires - Date.now() - 3600_000) < 5000, "'1h' reads as an hour")
})

test('invite: the role is a rank, member by default', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing, db } = await makeHost(t, testnet)
  await t.exception(pairing.invite({ role: 'volunteer' }), /not a rank/)
  await pairing.invite()
  const [record] = await invites(db)
  t.is(record.role, 'member')
})

test('invite: ttl is ms or a duration', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing } = await makeHost(t, testnet)
  const inMs = Invite.parse(await pairing.invite({ ttl: 60_000 }))
  t.ok(Math.abs(inMs.expires - Date.now() - 60_000) < 5000)
  t.is(Invite.parse(await pairing.invite()).expires, 0, 'no ttl, no expiry')
  await t.exception(pairing.invite({ ttl: 'soon' }), /not a duration/)
})

test('invite: a ttl is a positive whole number of ms the clock reaches, or INVALID and nothing is written', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing, db } = await makeHost(t, testnet)
  for (const ttl of [-1000, '-1h', '0s', 0.5, Infinity, Number.MAX_SAFE_INTEGER, 2 ** 53, 1e20]) {
    t.is(await code(pairing.invite({ ttl })), 'INVALID', `ttl ${ttl}`)
    t.exception(() => Invite.create({ ...sample(), ttl }), /INVALID/)
  }
  t.alike(await invites(db), [], 'no invite was written')
  t.ok(Invite.parse(await pairing.invite({ ttl: 1 })).expires > 0, 'one ms is a ttl')
})

test('close: a sync caught mid-way leaves no expiry timer armed', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing, db } = await makeHost(t, testnet)
  await pairing.invite({ ttl: '1h' })
  // the room closes while a sync drops an invite that ran out; every sync is let finish
  const syncs = []
  const sync = pairing._sync.bind(pairing)
  pairing._sync = () => syncs[syncs.push(sync()) - 1]
  const call = db.call.bind(db)
  db.call = async (verb, ...args) => {
    if (verb === 'del-invite') await pairing.close()
    return call(verb, ...args)
  }
  await pairing.invite({ ttl: 1 }).catch(() => {})
  await waitFor(() => pairing.closed)
  await Promise.allSettled(syncs)
  t.ok(pairing.closed, 'closed mid-sync')
  t.is(pairing._expiry, null, 'nothing left to wake it')
})

test('invite: a rank above member is single-use', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing } = await makeHost(t, testnet)
  await t.exception(pairing.invite({ role: 'admin', reuse: true }), /at most member/)
  t.ok(await pairing.invite({ role: 'member', reuse: true }))
  t.ok(await pairing.invite({ role: 'admin' }))
})

test('Invite.parse round-trips: key, address, id', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing, db } = await makeHost(t, testnet, { mirrors: [crypto.randomBytes(32)] })
  const invite = await pairing.invite()
  const parsed = Invite.parse(invite)
  t.alike(parsed.key, db.key)
  t.alike(parsed.discoveryKey, db.discoveryKey)
  t.alike(parsed.address, db.address, 'the address its encryption key owns')
  t.is(parsed.mirrors, undefined, "the mirrors are the app's, never in the invite")
  t.alike(Invite.parse(invite).id, parsed.id, 'the id is stable across parses')
  t.is(parsed.toString(), invite)
  t.is(parsed.data, null, 'no data unless given')
})

test('invite: data rides in the invite, readable before joining', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing } = await makeHost(t, testnet)
  const data = b4a.from('clinic')
  t.alike(Invite.parse(await pairing.invite({ data })).data, data)
})

test('Invite.parse: rejects garbage with INVALID_INVITE', async (t) => {
  t.exception(() => Invite.parse('not z32 !!!'), /not an invite/)
  t.exception(() => Invite.parse(z32.encode(b4a.from('short'))), /not an invite/)
  t.exception(() => Invite.parse(42), /must be a string/)
  const fields = Invite.parse(Invite.create(sample()).toString())
  const unknown = z32.encode(c.encode(getEncoding('@cero/invite'), { ...fields, version: 99 }))
  t.exception(() => Invite.parse(unknown), /unknown invite version/)
})

test('Invite.create: needs a 32-byte key and address', (t) => {
  t.exception(() => Invite.create({ ...sample(), key: b4a.alloc(8) }), /key/)
  t.exception(() => Invite.create({ ...sample(), address: null }), /address/)
  t.exception(() => Invite.create({ ...sample(), data: 'clinic' }), /data must be a buffer/)
})

test('Invite proof: only the invite holder proves a writer', async (t) => {
  const invite = Invite.create(sample())
  const writer = crypto.randomBytes(32)
  t.ok(Invite.proven(invite.id, writer, invite.prove(writer)))
  t.absent(
    Invite.proven(invite.id, crypto.randomBytes(32), invite.prove(writer)),
    'bound to the writer'
  )
  const other = Invite.create(sample())
  t.absent(Invite.proven(invite.id, writer, other.prove(writer)), 'bound to the invite')
})

// ─── joins: apply admits ───────────────────────────────────────────────────

test('join: apply admits the joiner, and the reply carries the keys and epochs', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  await host.db.rotate()
  const invite = await host.pairing.invite({ role: 'member' })

  const result = await joiner.join(invite)
  t.alike(await waiting(host.db), [], 'no request: nobody has to accept')
  t.alike(result.key, host.db.key)
  t.alike(result.encryptionKey, host.db.encryptionKey)
  t.alike(result.epochs, host.db.keyring.all(), 'the epochs, to read the history before')
  t.is(result.writer.publicKey.byteLength, 32, 'a fresh writer, returned to open the database')

  t.is((await member(host.db, joiner.identity)).role, 'member', 'admitted before the reply')
  const writer = hid.encode(
    Hypercore.key({ version: 2, signers: [{ publicKey: result.writer.publicKey }] })
  )
  const { data: device } = await host.db.get('devices', writer)
  t.is(device.memberId, joiner.identity.id, 'its writer, bound to it')
  t.alike(await invites(host.db), [], 'a single-use invite is spent')
  await waitFor(async () => (await host.db.get('requests')).data.length === 0)
  t.pass('the admission settles once the keys were read')
  t.alike(await host.mailbox.outbox.list(), [], 'and nothing is kept to send again')
})

test('join: links the node that added its invite, so no member applies it first', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite()
  const { link } = Invite.parse(invite)
  t.alike(link, { key: host.db.writerKey, length: host.db.length }, 'the record, on the minter')

  const { writer } = await joiner.join(invite)
  const key = Hypercore.key({ version: 2, signers: [{ publicKey: writer.publicKey }] })
  const core = joiner.net.store.get({ key })
  await core.ready()
  const block = await core.get(0)
  await core.close()
  // a plain block: its padding says unencrypted, the oplog follows
  const { links } = encoding.decodeOplog(block.subarray(8))
  t.alike(links, [link])
})

test('join: a reusable invite admits every joiner, each at its role', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner: one } = await makeHostJoiner(t, testnet)
  const two = await makeJoiner(t, testnet)
  const invite = await host.pairing.invite({ role: 'reader', reuse: true })

  t.alike((await one.join(invite)).key, host.db.key)
  t.alike((await two.join(invite)).key, host.db.key)
  t.is((await member(host.db, one.identity)).role, 'reader')
  t.is((await member(host.db, two.identity)).role, 'reader')
  t.is((await invites(host.db)).length, 1, 'the invite stays')
})

test('join: a single-use invite admits once; a second joiner hears it is spent', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner: one } = await makeHostJoiner(t, testnet)
  const two = await makeJoiner(t, testnet)
  const invite = await host.pairing.invite()

  await one.join(invite)
  const err = await two.join(invite, { timeout: 10000 }).catch((e) => e)
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'spent')
  t.absent(await member(host.db, two.identity), 'and was not admitted')
})

test('join: a member joining again from another device keeps its record', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ role: 'member', reuse: true })
  await joiner.join(invite)
  const before = await member(host.db, joiner.identity)
  await host.db.call('set-member', { ...before, role: 'admin', updatedAt: Date.now() })

  // the same identity on a second device, with a writer of its own
  const device = await makeMailbox(t, testnet)
  const result = await Pairing.join(device.mailbox, invite, { identity: joiner.identity, spec })
  const after = await member(host.db, joiner.identity)
  t.is(after.role, 'admin', 'the role it was given since')
  t.is(after.createdAt, before.createdAt)
  const writer = Hypercore.key({ version: 2, signers: [{ publicKey: result.writer.publicKey }] })
  t.is((await host.db.get('devices', hid.encode(writer))).data?.memberId, joiner.identity.id)
})

test('join: a fresh invite takes over from one that admits nobody', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const revoked = await host.pairing.invite()
  await host.pairing.revoke(revoked)
  const writer = crypto.keyPair()
  const err = await joiner.join(revoked, { writer, timeout: 10000 }).catch((e) => e)
  t.is(err.code, 'DENIED', 'the revoked invite admits nobody')

  // the same writer, as a join resumed with a new invite keeps it
  const result = await joiner.join(await host.pairing.invite(), { writer })
  t.alike(result.key, host.db.key)
  t.ok(await member(host.db, joiner.identity))
})

test('join: a reply for another database is ignored', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite()
  await host.pairing.close()
  const writer = crypto.keyPair()
  const forged = { status: STATUS_ACCEPTED, reason: '', key: crypto.randomBytes(32) }
  await host.mailbox.send(Mailbox.getAddress(writer.secretKey), c.encode(Response, forged))

  const err = await joiner.join(invite, { writer, timeout: 3000 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT')
})

test('expiry: a joiner admitted past its invite is removed, not answered', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ ttl: 2000 })
  // nobody answers while the join lands, so it is admitted and never gets its keys
  await host.pairing.close()
  const joining = joiner.join(invite, { timeout: 0 }).catch((e) => e)
  await waitFor(async () => !!(await member(host.db, joiner.identity)))
  t.is((await joining).code, 'EXPIRED', 'the joiner gives up at expiry')

  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  await pairing.ready()
  await waitFor(async () => !(await member(host.db, joiner.identity)))
  t.alike((await host.db.get('requests')).data, [], 'nothing left owed')
})

test('expiry: a joiner admitted but gone is removed at expiry, even while offered its keys', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ ttl: 4000 })
  await host.pairing.close()
  const joining = joiner.join(invite, { timeout: 0 }).catch((e) => e)
  await waitFor(async () => !!(await member(host.db, joiner.identity)))
  // it leaves before reading its keys
  await joiner.mailbox.close()
  await joining

  // a device of the host back online before the expiry offers the keys to nobody
  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  await pairing.ready()
  t.ok(Date.now() < Invite.parse(invite).expires, 'offered before the invite ran out')
  const gone = async () => !(await member(host.db, joiner.identity))
  t.ok(await waitFor(gone, { timeout: 8000 }).catch(() => false), 'removed once it ran out')
})

test('expiry: an extra device that never read its keys costs its member nothing', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ reuse: true, ttl: 4000 })
  const first = await joiner.join(invite)
  const owed = async () => (await host.db.get('requests')).data
  await waitFor(async () => (await owed()).length === 0)

  // nobody answers while a second device of the member lands, and it leaves before reading its keys
  await host.pairing.close()
  const device = await makeMailbox(t, testnet)
  const writer = crypto.keyPair()
  const opts = { identity: joiner.identity, spec, writer, timeout: 0 }
  const joining = Pairing.join(device.mailbox, invite, opts).catch((e) => e)
  await waitFor(async () => (await owed()).length === 1)
  await device.mailbox.close()
  await joining

  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  await pairing.ready()
  await waitFor(async () => (await owed()).length === 0, { timeout: 10000 })
  t.ok(await member(host.db, joiner.identity), 'the member stays')
  const seat = (pair) =>
    hid.encode(Hypercore.key({ version: 2, signers: [{ publicKey: pair.publicKey }] }))
  t.ok((await host.db.get('devices', seat(first.writer))).data, 'with the device that read them')
  t.ok((await host.db.get('devices', seat(writer))).data, 'and the unread one keeps its seat')

  // the same device, back with a fresh invite, reads its keys this time
  const again = new Mailbox(device.net)
  t.teardown(() => again.close().catch(() => {}), { order: 1 })
  const fresh = await pairing.invite()
  const result = await Pairing.join(again, fresh, { ...opts, timeout: 30000 })
  t.alike(result.key, host.db.key)
})

test('expiry: two devices of a new member that never read their keys do not keep each other in', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ reuse: true, ttl: 3000 })
  // nobody answers while both land, and neither reads its keys
  await host.pairing.close()
  const other = await makeMailbox(t, testnet)
  const opts = { identity: joiner.identity, spec, timeout: 0 }
  const joins = [joiner.mailbox, other.mailbox].map((mailbox) =>
    Pairing.join(mailbox, invite, { ...opts, writer: crypto.keyPair() }).catch((e) => e)
  )
  const owed = async () => (await host.db.get('requests')).data
  await waitFor(async () => (await owed()).length === 2)
  for (const joining of joins) t.is((await joining).code, 'EXPIRED', 'each gives up at expiry')

  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  await pairing.ready()
  const gone = async () => !(await member(host.db, joiner.identity))
  t.ok(await waitFor(gone, { timeout: 10000 }).catch(() => false), 'she is removed')
  t.alike(await owed(), [], 'nothing left owed')
})

test('expiry: a device still within its invite keeps its member in while another has run out', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const short = await host.pairing.invite({ reuse: true, ttl: 2000 })
  const long = await host.pairing.invite({ reuse: true, ttl: 600000 })
  // nobody answers while both land, and neither reads its keys
  await host.pairing.close()
  const other = await makeMailbox(t, testnet)
  const opts = { identity: joiner.identity, spec, timeout: 0 }
  const join = (mailbox, invite) =>
    Pairing.join(mailbox, invite, { ...opts, writer: crypto.keyPair() }).catch((e) => e)
  const first = join(joiner.mailbox, short)
  join(other.mailbox, long)
  const owed = async () => (await host.db.get('requests')).data
  await waitFor(async () => (await owed()).length === 2)
  t.is((await first).code, 'EXPIRED', 'the first gives up at expiry')
  // the second never reads its keys either, and its invite is still good
  await other.mailbox.close()

  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  const synced = new Promise((resolve) => pairing.once('serving', resolve))
  await pairing.ready()
  await synced
  t.ok(await member(host.db, joiner.identity), 'she stays')
  t.is((await owed()).length, 2, 'and both are still owed')
})

// ─── confirm invites: a member accepts ─────────────────────────────────────

test('confirm: a join waits as a request until a member accepts it', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ role: 'member', confirm: true })
  const joining = joiner.join(invite)

  const request = await asked(host.db)
  t.alike(request.identity, joiner.identity.publicKey, 'the joiner identity, proven')
  t.is(request.role, 'member', 'asking for the role of its invite')
  t.absent(await member(host.db, joiner.identity), 'not admitted yet')

  await host.pairing.accept(request.id)
  t.alike((await joining).key, host.db.key)
  t.is((await member(host.db, joiner.identity)).role, 'member')
  await waitFor(async () => (await host.db.get('requests')).data.length === 0)
  t.pass('the request settles once the joiner read its keys')
})

function stored(net, key) {
  return net.store.storage.hasCore(crypto.discoveryKey(key))
}

// the key of the core an outbox row travels in, without opening it
async function sentKey(net, { name }) {
  const { publicKey } = await net.store.createKeyPair(name)
  return Hypercore.key({ version: net.store.manifestVersion, signers: [{ publicKey }] })
}

test('confirm: junk sealed to the reply address leaves nothing on the joiner, the reply still lands', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const received = []
  const put = joiner.mailbox.inbox.put
  joiner.mailbox.inbox.put = async (m) => received.push(b4a.from(m.id, 'hex')) && put(m)
  const invite = await host.pairing.invite({ confirm: true })
  const writer = crypto.keyPair()
  const joining = joiner.join(invite, { writer })
  const request = await asked(host.db)

  const reply = Mailbox.getAddress(writer.secretKey)
  const other = { status: STATUS_ACCEPTED, reason: '', key: crypto.randomBytes(32) }
  const junk = []
  for (const message of [b4a.from('no response'), c.encode(Response, other)]) {
    await host.mailbox.send(reply, message)
    junk.push(await sentKey(host.net, (await host.mailbox.outbox.list()).at(-1)))
  }
  await waitFor(async () => (await host.mailbox.outbox.list()).length === 0, { timeout: 30000 })
  for (const key of junk) await waitFor(async () => !(await stored(joiner.net, key)))
  t.pass('no core kept')
  t.alike(await joiner.mailbox.inbox.list(), [], 'no row kept')

  await host.pairing.accept(request.id)
  t.alike((await joining).key, host.db.key, 'the real reply settles the join')
  // the join closes its inbox once answered, so the next start erases the reply's core
  const key = received.find((k) => !junk.some((j) => b4a.equals(j, k)))
  const again = new Mailbox(joiner.net, { inbox: joiner.mailbox.inbox })
  t.teardown(() => again.close())
  await again.ready()
  t.absent(await stored(joiner.net, key), 'and the reply core is erased')
})

test('confirm: a reply whose encryption key does not own the invite address is ignored, the real one settles the join', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const read = new Set()
  const put = joiner.mailbox.inbox.put
  joiner.mailbox.inbox.put = async (m) => read.add(m.id) && put(m)
  const writer = crypto.keyPair()
  const kept = []
  const keep = async (answer) => kept.push(answer)
  const joining = joiner.join(await host.pairing.invite({ confirm: true }), { writer, keep })
  const request = await asked(host.db)

  // the database key is no secret: every mirror holds it
  const { key } = host.db
  const rows = () => joiner.mailbox.inbox.list()
  const unread = async (id) => (await rows()).some((m) => m.id === id && !m.handled)
  for (const [name, encryptionKey] of [
    ['a made-up', crypto.randomBytes(32)],
    ['no', null]
  ]) {
    const forged = { status: STATUS_ACCEPTED, reason: '', key, encryptionKey, epochs: [] }
    await host.mailbox.send(Mailbox.getAddress(writer.secretKey), c.encode(Response, forged))
    const id = b4a.toHex(await sentKey(host.net, (await host.mailbox.outbox.list()).at(-1)))
    // a reply that settled the join closed its inbox, so nothing reads the next one
    const turned = await waitFor(async () => read.has(id) && !(await unread(id))).catch(() => false)
    t.ok(turned && !kept.length, `a reply with ${name} encryption key is read and settles nothing`)
  }

  await host.pairing.accept(request.id)
  t.alike((await joining).encryptionKey, host.db.encryptionKey)
})

test('join: two replies racing settle it once, and nothing is kept after', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const writer = crypto.keyPair()
  let read = 0
  const put = joiner.mailbox.inbox.put
  joiner.mailbox.inbox.put = async (m) => {
    if (!m.handled) read++
    return put(m)
  }
  const kept = []
  // the first answer is still being kept when the second is read
  const keep = async (answer) => {
    kept.push(answer)
    await waitFor(() => read === 2, { timeout: 30000 })
  }
  const joining = joiner.join(await host.pairing.invite({ confirm: true }), { writer, keep })
  await asked(host.db)

  // as two member devices answer at once
  const reply = Mailbox.getAddress(writer.secretKey)
  const answer = c.encode(Response, {
    status: STATUS_ACCEPTED,
    reason: '',
    key: host.db.key,
    encryptionKey: host.db.encryptionKey
  })
  const keys = []
  for (let i = 0; i < 2; i++) {
    await host.mailbox.send(reply, answer)
    keys.push(await sentKey(host.net, (await host.mailbox.outbox.list()).at(-1)))
  }
  t.alike((await joining).key, host.db.key)
  await waitFor(async () => (await host.mailbox.outbox.list()).length === 0, { timeout: 30000 })
  await waitFor(async () => (await joiner.mailbox.inbox.list()).every((m) => m.handled))
  t.is(kept.length, 1, 'kept once')
  // the join closed its inbox as it settled, so the next start erases what it read
  const again = new Mailbox(joiner.net, { inbox: joiner.mailbox.inbox })
  t.teardown(() => again.close())
  await again.ready()
  for (const key of keys) t.absent(await stored(joiner.net, key), 'erased')
})

test('join: a reply its keep failed on leaves the next one to settle it', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const writer = crypto.keyPair()
  let tries = 0
  const keep = async () => {
    if (tries++ === 0) throw new Error('disk full')
  }
  const joining = joiner.join(await host.pairing.invite({ confirm: true }), { writer, keep })
  await asked(host.db)

  const reply = Mailbox.getAddress(writer.secretKey)
  const answer = c.encode(Response, {
    status: STATUS_ACCEPTED,
    reason: '',
    key: host.db.key,
    encryptionKey: host.db.encryptionKey
  })
  await host.mailbox.send(reply, answer)
  await waitFor(() => tries === 1, { timeout: 30000 })
  await host.mailbox.send(reply, answer)
  t.alike((await joining).key, host.db.key)
  t.is(tries, 2)
})

test('offline: an old denial a mirror still announces does not settle the same writer joining again', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeBlindPeer(t, testnet)
  const host = await makeHost(t, testnet, { mirrors: [mirror.publicKey] })
  const joiner = await makeJoiner(t, testnet, { mirrors: [mirror.publicKey] })
  const writer = crypto.keyPair()
  const reply = Mailbox.getAddress(writer.secretKey)
  const deposited = new Promise((resolve) => {
    const onadd = (record) => {
      if (!record.referrer || !b4a.equals(record.referrer, reply)) return
      mirror.off('add-core', onadd)
      resolve(record.key)
    }
    mirror.on('add-core', onadd)
  })

  const first = joiner.join(await host.pairing.invite({ confirm: true }), { writer })
  await host.pairing.deny((await asked(host.db)).id, 'no')
  t.is((await first.catch((e) => e)).code, 'DENIED')
  const denial = await deposited
  const held = mirror.store.get({ key: denial })
  await held.ready()
  await waitFor(() => held.length > 0 && held.contiguousLength === held.length, { timeout: 30000 })
  await held.close()

  let announced = null
  const heard = new Promise((resolve) => (announced = resolve))
  // passive, so the inbox's session is what wakes the topic and gets the mirror's announce
  const spy = joiner.net.wakeup.session(reply, {
    active: false,
    discoveryKey: crypto.discoveryKey(reply),
    onannounce: (entries) => entries.some((e) => b4a.equals(e.key, denial)) && announced()
  })
  t.teardown(() => spy.destroy())
  const again = joiner.join(await host.pairing.invite({ confirm: true }), { writer })
  await heard
  const request = await asked(host.db)
  await host.pairing.accept(request.id)
  const res = await again.catch((e) => e)
  t.absent(
    res instanceof Error,
    `settled by the accept${res instanceof Error ? `, not ${res.code}` : ''}`
  )
})

test('link: a bare device joins, the accepter attests it, and the reply carries its chain', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet)
  const { mailbox, net } = await makeMailbox(t, testnet)
  const device = Identity.randomKeyPair()
  const bare = await Identity.bare(device)
  const invite = await host.pairing.invite({ role: 'owner', confirm: true, ttl: '2h' })
  const joining = Pairing.join(mailbox, invite, { identity: bare, spec })

  const request = await asked(host.db)
  t.alike(request.key, device.publicKey, 'the request names the device key')
  await host.pairing.accept(request.id, { proof: host.identity.link(request.key) })

  const reply = await joining
  t.alike(reply.key, host.db.key)
  const linked = Identity.verify(reply.proof, null, host.identity.publicKey)
  t.alike(
    linked?.device,
    device.publicKey,
    'the chain ends at this device, under the host identity'
  )
  const me = Identity.from({
    publicKey: host.identity.publicKey,
    encryptionKey: reply.encryptionKey,
    device,
    proof: reply.proof
  })
  const db = new Database({
    store: net.store,
    identity: me,
    network: net,
    spec,
    key: reply.key,
    encryptionKey: reply.encryptionKey,
    epochs: reply.epochs,
    keyPair: reply.writer
  })
  await db.ready()
  t.teardown(() => db.close().catch(() => {}), { order: 1 })
  await waitFor(() => db.writable)
  t.is(
    (await db.get('devices', hid.encode(db.writerKey))).data?.memberId,
    host.identity.id,
    'a device of the host, writing'
  )
  t.is((await db.get('members')).data.length, 1, 'no member was added')
})

test('confirm: only a waiting join is answered, any other id is UNKNOWN', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ confirm: true, reuse: true })
  const joining = joiner.join(invite).catch((e) => e)
  const { id } = await asked(host.db)
  // away, so the admission stays owed its keys and the invite stays live
  await joiner.net.suspend()
  await host.pairing.accept(id)

  t.is(await code(host.pairing.accept(id)), 'UNKNOWN', 'admitted: accepting again writes nothing')
  t.is(await code(host.pairing.deny(id)), 'UNKNOWN', 'nor does a deny')
  const none = hid.encode(crypto.randomBytes(32))
  t.is(await code(host.pairing.accept(none)), 'UNKNOWN', 'no such request')
  t.is(await code(host.pairing.deny(none)), 'UNKNOWN')
  await joiner.net.resume()
  t.alike((await joining).key, host.db.key, 'the accept stands')
})

test('confirm: a request whose invite was revoked is UNKNOWN to accept and deny', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ confirm: true })
  const joining = joiner.join(invite).catch((e) => e)
  const { id } = await asked(host.db)
  await host.pairing.revoke(invite)

  t.is(await code(host.pairing.accept(id)), 'UNKNOWN')
  t.is(await code(host.pairing.deny(id)), 'UNKNOWN')
  t.is((await joining).reason, 'revoked', 'the joiner hears the revoke')
  t.absent(await member(host.db, joiner.identity))
})

test('confirm: a request whose invite ran out and was dropped is UNKNOWN to accept and deny', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ confirm: true, ttl: 2000 })
  const joining = joiner.join(invite, { timeout: 0 }).catch((e) => e)
  const { id } = await asked(host.db)
  await waitFor(async () => (await invites(host.db)).length === 0)

  t.is(await code(host.pairing.accept(id)), 'UNKNOWN')
  t.is(await code(host.pairing.deny(id)), 'UNKNOWN')
  t.is((await joining).code, 'EXPIRED')
  t.absent(await member(host.db, joiner.identity))
})

test('confirm: accept checks the role and the expiry first', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const peer = await makeMember(t, testnet, host, 'member')
  const invite = await host.pairing.invite({ role: 'member', confirm: true, ttl: 4000 })
  // nobody who can remove is left to drop the invite once it runs out
  await host.pairing.close()
  const joining = joiner.join(invite, { timeout: 0 }).catch((e) => e)
  const { id } = await asked(peer.db)

  await t.exception(peer.pairing.accept(id, { role: 'owner' }), /exceeds the invite role/)
  await t.exception(peer.pairing.accept(id, { role: 'volunteer' }), /not a rank/)
  t.is((await joining).code, 'EXPIRED')
  // a timer can fire a millisecond before the clock reads its time: wait for the clock
  const { expires } = Invite.parse(invite)
  await waitFor(() => Date.now() > expires)
  t.is(await code(peer.pairing.accept(id)), 'EXPIRED', 'past its invite, though still listed')
  t.absent(await member(peer.db, joiner.identity), 'and nobody was admitted')
})

test('confirm: an accept refused at apply leaves the request answerable', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const peer = await makeMember(t, testnet, host, 'member')
  const invite = await host.pairing.invite({ role: 'admin', confirm: true })
  const joining = joiner.join(invite, { timeout: 10000 }).catch((e) => e)
  const { id } = await asked(peer.db)

  t.is(await code(peer.pairing.accept(id)), 'REFUSED', 'admin is above the role of the accepter')
  t.is((await asked(peer.db)).id, id, 'still waiting')
  await peer.pairing.accept(id, { role: 'member' })
  t.alike((await joining).key, host.db.key)
  t.is((await member(peer.db, joiner.identity)).role, 'member')
})

test('confirm: a member can deny with a reason', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ confirm: true })
  const joining = joiner.join(invite).catch((e) => e)
  await host.pairing.deny((await asked(host.db)).id, 'not-today')

  const err = await joining
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'not-today')
  t.alike((await host.db.get('requests')).data, [])
  t.absent(await member(host.db, joiner.identity))
})

test('confirm: a deny after another device accepted changes nothing: the joiner gets its keys', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const peer = await makeMember(t, testnet, host, 'admin')
  const invite = await host.pairing.invite({ confirm: true })
  const joining = joiner.join(invite, { timeout: 30000 }).catch((e) => e)
  // both devices hold the request before either answers
  const [{ id }] = await Promise.all([asked(host.db), asked(peer.db)])

  // the joiner is away while the two answers land, and the device that accepted leaves: only the
  // one that denied is left to send the keys the accept owes
  await joiner.net.suspend()
  await host.pairing.accept(id)
  await waitFor(async () => !!(await member(peer.db, joiner.identity)))
  await host.net.suspend()
  // written as by a device that had not seen the accept yet
  await peer.db.call('deny', { id, reason: 'too late' })

  await joiner.net.resume()
  const res = await joining
  t.absent(
    res instanceof Error,
    `the join resolved${res instanceof Error ? `, not ${res.code}` : ''}`
  )
  t.ok(res?.key, 'with the keys')
})

test('confirm: accepting one join spends a single-use invite, the others hear it is spent', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner: one } = await makeHostJoiner(t, testnet)
  const two = await makeJoiner(t, testnet)
  const invite = await host.pairing.invite({ role: 'admin', confirm: true })
  const joining = [one, two].map((j) => j.join(invite, { timeout: 10000 }).catch((e) => e))
  const [first, second] = await waitFor(async () => {
    const rows = await waiting(host.db)
    return rows.length === 2 && rows
  })

  await host.pairing.accept(first.id)
  t.alike(await waiting(host.db), [], 'the other request went with the invite')
  t.is(await code(host.pairing.accept(second.id)), 'UNKNOWN', 'and accepting it does nothing')
  const results = await Promise.all(joining)
  t.is(results.filter((r) => r.key).length, 1, 'one joiner admitted')
  t.alike(
    results.filter((r) => !r.key).map((r) => [r.code, r.reason]),
    [['DENIED', 'spent']],
    'the other is told'
  )
})

// ─── joiner errors ─────────────────────────────────────────────────────────

test('join: needs a mailbox, an identity and a spec; a writer, if given, is a keypair', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite()
  const { identity, mailbox } = joiner
  await t.exception(Pairing.join(null, invite, { identity, spec }), /mailbox/)
  await t.exception(Pairing.join(mailbox, invite, { spec }), /identity/)
  await t.exception(Pairing.join(mailbox, invite, { identity }), /spec/)
  const writer = crypto.randomBytes(32)
  await t.exception(Pairing.join(mailbox, invite, { identity, spec, writer }), /writer/)
})

test('Invite: an address nothing can be sealed to is no invite', (t) => {
  const zero = b4a.alloc(32)
  t.exception(() => Invite.create({ ...sample(), address: zero }), /sealed/)
  t.exception(() => Invite.parse(unsealable()), /sealed/)
})

test('join: invalid invite → INVALID_INVITE, expired → EXPIRED', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  t.is((await joiner.join('not-an-invite').catch((e) => e)).code, 'INVALID_INVITE')
  t.is((await joiner.join(unsealable()).catch((e) => e)).code, 'INVALID_INVITE')
  const invite = await host.pairing.invite({ ttl: 1 })
  await waitFor(() => Invite.parse(invite).expired)
  t.is((await joiner.join(invite).catch((e) => e)).code, 'EXPIRED')
})

test('join: an expired invite fails first, before the mailbox is touched', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ ttl: 1 })
  await waitFor(() => Invite.parse(invite).expired)
  await joiner.mailbox.close()
  t.is(await code(joiner.join(invite)), 'EXPIRED', 'not CLOSED: no join is written')
})

test('join: reads its reply with a timeout no longer than its own', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const seen = []
  const receive = joiner.mailbox.receive.bind(joiner.mailbox)
  joiner.mailbox.receive = (secret, fn, opts) =>
    seen.push(opts.timeout) && receive(secret, fn, opts)
  await joiner.join(await host.pairing.invite(), { timeout: 20000 })
  await joiner.join(await host.pairing.invite(), { timeout: 0 })
  t.alike(seen, [20000, undefined], 'its own, or the default when it waits for good')
})

test('join: times out when no member answers', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite()
  await host.pairing.close()
  t.is((await joiner.join(invite, { timeout: 1500 }).catch((e) => e)).code, 'TIMEOUT')
})

test('join: waiting for good still ends when the invite expires', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const soon = await host.pairing.invite({ ttl: 1500 })
  const later = await host.pairing.invite({ ttl: '30d' })
  await host.pairing.close()
  t.is((await joiner.join(soon, { timeout: 0 }).catch((e) => e)).code, 'EXPIRED')
  const err = await joiner.join(later, { timeout: 1500 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT', 'an expiry past the timer range does not fire early')
})

test('join: closing the mailbox stops it with CLOSED', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite()
  await host.pairing.close()
  const joining = joiner.join(invite, { timeout: 0 }).catch((e) => e)
  await joiner.mailbox.close()
  t.is((await joining).code, 'CLOSED')
  t.is((await joiner.join(invite).catch((e) => e)).code, 'CLOSED', 'and once it is closed')
})

test('join: an abort signal stops it', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite()
  const controller = new AbortController()
  const joining = joiner.join(invite, { timeout: 0, signal: controller.signal }).catch((e) => e)
  controller.abort()
  t.is((await joining).code, 'CLOSED')
})

// ─── invite lifecycle ──────────────────────────────────────────────────────

test('revoke: dropped from the database, a join with it is turned away', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite()
  t.is(await host.pairing.revoke(invite), true)
  t.is(await host.pairing.revoke(invite), false, 'revoking again finds nothing')
  t.alike(await invites(host.db), [])

  const err = await joiner.join(invite, { timeout: 10000 }).catch((e) => e)
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'revoked')
  t.absent(await member(host.db, joiner.identity))
  await waitFor(async () => (await refusals(host.db)).length === 0)
  t.pass('the refusal goes once read')
})

test('refused: a member removed after the invite was minted hears it', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ reuse: true })
  await joiner.join(invite)
  await host.db.call('del-member', { id: joiner.identity.id })

  const err = await joiner.join(invite, { timeout: 10000 }).catch((e) => e)
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'removed')
  t.absent(await member(host.db, joiner.identity), 'and is not let back in')
  await waitFor(async () => (await refusals(host.db)).length === 0)
  t.pass('the refusal goes once read')
})

test('refused: a join with an invite the room never held is not answered, nor kept', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const link = { key: host.db.writerKey, length: host.db.length }
  const stranger = Invite.create({ key: host.db.key, address: host.db.address, link })
  const landed = applied(host.db, 'join', 'join')
  const joining = joiner.join(stranger.toString(), { timeout: 5000 }).catch((e) => e)
  await landed
  t.alike(await refusals(host.db), [], 'no member owes it an answer')
  t.is((await joining).code, 'TIMEOUT')
})

test('refused: with two member devices online, the joiner is answered and both forget it', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const peer = await makeMember(t, testnet, host, 'member')
  const invite = await host.pairing.invite({ reuse: true })
  await host.pairing.revoke(invite)
  await waitFor(async () => (await spent(peer.db)).length === 1)

  const err = await joiner.join(invite, { timeout: 10000 }).catch((e) => e)
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'revoked')
  for (const { db, pairing } of [host, peer]) {
    await waitFor(async () => (await refusals(db)).length === 0)
    await waitFor(() => !pairing.serving)
  }
  t.pass('neither keeps answering')
})

test('expiry: a member who can remove drops the invite once it runs out', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet)
  await host.pairing.invite({ ttl: 1000 })
  t.is((await invites(host.db)).length, 1)
  await waitFor(async () => (await invites(host.db)).length === 0, { timeout: 10000 })
  t.pass('the log stops admitting it')
  await waitFor(async () => (await spent(host.db)).length === 0, { timeout: 10000 })
  t.pass('and forgets it: past its expiry no joiner uses it')
})

test('expiry: a revoked invite is kept to answer its joins until it runs out', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet)
  await host.pairing.revoke(await host.pairing.invite({ ttl: 1500 }))
  t.is((await spent(host.db)).length, 1)
  await waitFor(async () => (await spent(host.db)).length === 0, { timeout: 10000 })
  t.pass('then forgotten')
})

test('expiry: a refused joiner gone is forgotten at expiry, unanswered', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ ttl: 4000, reuse: true })
  await host.pairing.revoke(invite)
  await host.pairing.close()
  const joining = joiner.join(invite, { timeout: 0 }).catch((e) => e)
  await waitFor(async () => (await refusals(host.db)).length === 1)
  // it leaves before reading the answer
  await joiner.mailbox.close()
  await joining

  // a device of the host back online before the expiry offers the answer to nobody
  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  await pairing.ready()
  t.ok(Date.now() < Invite.parse(invite).expires, 'offered before the invite ran out')
  t.ok(pairing.serving, 'while it owes the answer')
  const gone = async () => (await refusals(host.db)).length === 0
  t.ok(await waitFor(gone, { timeout: 8000 }).catch(() => false), 'forgotten once it ran out')
})

test('expiry: an invite reaching its expiry this very millisecond is still watched', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet)
  await host.pairing.invite({ ttl: 60_000 })
  const [record] = await invites(host.db)
  const before = host.pairing._expiry
  // the expiry timer fired on the millisecond itself: not expired yet, so it must wake again
  const now = Date.now
  Date.now = () => record.expires
  try {
    host.pairing._arm([record])
  } finally {
    Date.now = now
  }
  t.not(host.pairing._expiry, before, 'a timer is armed for just past it')
})

test('serving: true while this member may answer a live invite', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet)
  t.is(host.pairing.serving, false)
  const invite = await host.pairing.invite()
  t.is(host.pairing.serving, true)
  await host.pairing.revoke(invite)
  t.is(host.pairing.serving, false)
})

// ─── resilience ────────────────────────────────────────────────────────────

test('a resumed join hears the reply to its earlier join', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite()
  await host.pairing.close()
  const writer = crypto.keyPair()

  // admitted while nobody answers, then the joiner stops
  const controller = new AbortController()
  const first = joiner
    .join(invite, { writer, signal: controller.signal, timeout: 0 })
    .catch((e) => e)
  await waitFor(async () => !!(await member(host.db, joiner.identity)))
  controller.abort()
  t.is((await first).code, 'CLOSED')

  // a member back online still owes it the keys: the admission is in the log
  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  await pairing.ready()
  // the invite is spent, so only the reply to the earlier join can land
  const again = await makeJoiner(t, testnet)
  const opts = { identity: joiner.identity, spec, writer }
  t.alike((await Pairing.join(again.mailbox, invite, opts)).key, host.db.key)
})

test('offline: member and joiner are never online together, the mirror carries both ways', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeBlindPeer(t, testnet)
  // both run the app's mirror; the member's database is mirrored, which keeps it connected
  const host = await makeHost(t, testnet, { mirrors: [mirror.publicKey] })
  const invite = await host.pairing.invite()
  await host.net.suspend()

  const joiner = await makeJoiner(t, testnet, { mirrors: [mirror.publicKey] })
  const joined = holds(mirror, Invite.parse(invite).key)
  const joining = joiner.join(invite, { timeout: 60000 })
  await joined
  await joiner.net.suspend()

  await host.net.resume()
  await waitFor(async () => !!(await member(host.db, joiner.identity)), { timeout: 30000 })
  // the reply read by the mirror settles the admission
  await waitFor(async () => (await host.db.get('requests')).data.length === 0, { timeout: 30000 })
  await host.net.suspend()

  await joiner.net.resume()
  t.alike((await joining).key, host.db.key)
})

test('offline: a refused joiner hears it through the mirror, never online with a member', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeBlindPeer(t, testnet)
  const host = await makeHost(t, testnet, { mirrors: [mirror.publicKey] })
  const invite = await host.pairing.invite()
  await host.pairing.revoke(invite)
  await host.net.suspend()

  const joiner = await makeJoiner(t, testnet, { mirrors: [mirror.publicKey] })
  const joined = holds(mirror, Invite.parse(invite).key)
  const joining = joiner.join(invite, { timeout: 60000 }).catch((e) => e)
  await joined
  await joiner.net.suspend()

  // the answer read by the mirror settles the refusal
  const answered = applied(host.db, 'del', 'refusal')
  await host.net.resume()
  await answered
  await host.net.suspend()

  await joiner.net.resume()
  const err = await joining
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'revoked')
})

// resolves once the mirror stores the whole core sent to `referrer`
async function holds(mirror, referrer) {
  const key = await new Promise((resolve) => {
    const onadd = (record) => {
      if (!record.referrer || !b4a.equals(record.referrer, referrer)) return
      mirror.off('add-core', onadd)
      resolve(record.key)
    }
    mirror.on('add-core', onadd)
  })
  const core = mirror.store.get({ key })
  await core.ready()
  await waitFor(() => core.length > 0 && core.contiguousLength === core.length, { timeout: 30000 })
  await core.close()
}

// ─── errors ────────────────────────────────────────────────────────────────

test('CeroError pairing factories have stable codes and inherit from Error', (t) => {
  const e = CeroError.INVALID_INVITE('bad')
  t.ok(e instanceof Error)
  t.is(e.code, 'INVALID_INVITE')
  t.is(e.name, 'CeroError')
  t.ok(e.isCeroError)

  const d = CeroError.DENIED('foo')
  t.is(d.code, 'DENIED')
  t.is(d.reason, 'foo')
})

// an invite whose address is all zeros: nothing can be sealed to it
function unsealable() {
  const fields = Invite.parse(Invite.create(sample()).toString())
  return new Invite({ ...fields, _str: null, address: b4a.alloc(32) }).toString()
}
