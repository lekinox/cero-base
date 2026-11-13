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
import { Invite, STAMPED } from '../../src/pairing/invite.js'
import {
  Response,
  STATUS_ACCEPTED,
  STATUS_DENIED,
  tag,
  proven,
  signed
} from '../../src/pairing/response.js'
import { Mailbox } from '../../src/mailbox/index.js'
import { unwrap } from '../../src/database/envelope.js'
import { getEncoding, decode as decodeAt } from '../../src/lib/spec/index.js'
import { CeroError } from '../../src/lib/errors.js'
import { spec as built } from '../fixtures/spec/index.js'

import { makeStore, makeTestnet, makeBlindPeer, waitFor } from '../helpers/index.js'

test.configure({ timeout: 60000 })

// the fixture app as a release that brings an invite's secret with `contract`
function dated(spec, contract) {
  const { since } = spec.meta
  const invite = { ...since.types['@cero/invite'], secret: contract }
  const types = { ...since.types, '@cero/invite': invite }
  return { ...spec, meta: { ...spec.meta, since: { ...since, types } } }
}

// with a contract no database here reaches: its invites carry the room's address. `built` has the
// field from the start, so its invites have an address of their own
const spec = dated(built, 9)

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
async function makeHost(t, testnet, { mirrors, spec: built = spec } = {}) {
  const { mailbox, net, identity } = await makeMailbox(t, testnet, { mirrors })
  const db = new Database({
    store: net.store,
    identity,
    network: net,
    spec: built,
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

async function makeJoiner(t, testnet, { mirrors, spec: built = spec } = {}) {
  const { mailbox, net, identity } = await makeMailbox(t, testnet, { mirrors })
  const join = (invite, opts = {}) =>
    Pairing.join(mailbox, invite, { identity, spec: built, ...opts })
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
    if (!read && !mail.handled && 'fetched' in mail) {
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

test('invite: options that are not a plain object are INVALID and nothing is written', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing, db } = await makeHost(t, testnet)
  for (const opts of [null, '1h', 5, [], b4a.alloc(4), new ArrayBuffer(4), new Map(), () => {}]) {
    t.is(await code(pairing.invite(opts)), 'INVALID', `options ${JSON.stringify(opts)}`)
  }
  t.alike(await invites(db), [], 'no invite was written')
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

// the fixture app at another contract
const at = (version) => ({ ...spec, meta: { ...spec.meta, version } })

// the join a writer's core holds: its stamp and its op
async function joinOf(net, writer) {
  const key = Hypercore.key({ version: 2, signers: [{ publicKey: writer.publicKey }] })
  const core = net.store.get({ key })
  await core.ready()
  const block = await core.get(0)
  await core.close()
  return unwrap(encoding.decodeOplog(block.subarray(8)).value)
}

const joinStamp = async (net, writer) => (await joinOf(net, writer)).version

test('invite: carries the stamp its record was written with, and a join is stamped with it', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet, { spec: at(2) })
  const before = await host.pairing.invite({ reuse: true })
  t.is(Invite.parse(before).stamp, 1, 'the version it was written at')
  t.is(Invite.parse(before).version, 1, 'in the form every release joins with')
  await host.db.write([['upgrade', { version: 2 }]])
  const after = await host.pairing.invite()
  t.is(Invite.parse(after).stamp, 2, 'and the raised one after a raise')
  t.is(Invite.parse(after).version, 2, 'in a form a release from before the stamp refuses')

  const joiner = await makeJoiner(t, testnet, { spec: at(2) })
  const { writer } = await joiner.join(after)
  t.is(await joinStamp(joiner.net, writer), 2, "the join takes its invite's stamp")
})

test('invite: one that carries no stamp counts as the start', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet, { spec: at(2) })
  const fields = Invite.parse(await host.pairing.invite())
  const bare = z32.encode(c.encode(getEncoding('@cero/invite'), { ...fields, stamp: 0 }))
  t.is(Invite.parse(bare).stamp, 0)

  const joiner = await makeJoiner(t, testnet, { spec: at(2) })
  const { writer } = await joiner.join(bare)
  t.is(await joinStamp(joiner.net, writer), spec.meta.start, 'its join is stamped with the start')
})

test('invite: a reusable one minted before a raise still admits a device on the older build', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet, { spec: at(2) })
  const invite = await host.pairing.invite({ reuse: true })
  await host.db.write([['upgrade', { version: 2 }]])

  const joiner = await makeJoiner(t, testnet)
  t.alike((await joiner.join(invite)).key, host.db.key, 'it joins')
  t.ok(await member(host.db, joiner.identity), 'and is a member')
})

test("join: a device whose build is below the invite's stamp is told to update, and writes nothing", async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet, { spec: at(2) })
  await host.db.write([['upgrade', { version: 2 }]])
  const invite = await host.pairing.invite()

  const joiner = await makeJoiner(t, testnet)
  const writer = crypto.keyPair()
  const err = await joiner.join(invite, { writer }).catch((e) => e)
  t.is(err?.code, 'BEHIND')
  const key = Hypercore.key({ version: 2, signers: [{ publicKey: writer.publicKey }] })
  const core = joiner.net.store.get({ key })
  await core.ready()
  t.is(core.length, 0, 'no join in its core')
  await core.close()
})

test('serving: a database that is behind answers no join', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet)
  const invite = await host.pairing.invite({ reuse: true })
  t.is(host.pairing.serving, true)
  await host.db.write([['upgrade', { version: 2 }]])
  await waitFor(() => host.db.behind === 2)
  await waitFor(() => host.pairing.serving === false)
  t.pass('it stops serving once behind')

  const joiner = await makeJoiner(t, testnet, { spec: at(2) })
  const err = await joiner.join(invite, { timeout: 5000 }).catch((e) => e)
  t.is(err?.code, 'TIMEOUT', 'the joiner hears nothing')
  t.ok(await member(host.db, joiner.identity), 'though apply admitted it')
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
    if (!m.handled && 'fetched' in m) read++
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

// joins with the invite's expiry handed to `take` instead of the clock
function expiring(join, take) {
  const { setTimeout } = globalThis
  globalThis.setTimeout = (fn, ms, ...args) =>
    ms > 3600000 ? take(fn) : setTimeout(fn, ms, ...args)
  try {
    return join()
  } finally {
    globalThis.setTimeout = setTimeout
  }
}

test('expiry: an invite that runs out while its reply is kept settles the join with the keys', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ confirm: true, ttl: '1d' })
  await joiner.mailbox.ready()
  let expire = null
  const keep = async () => expire()
  const join = () => joiner.join(invite, { writer: crypto.keyPair(), keep, timeout: 0 })
  const joined = expiring(join, (fn) => (expire = fn)).catch((err) => err)
  t.ok(expire, 'the expiry is in hand')
  await host.pairing.accept((await asked(host.db)).id)
  t.alike((await joined).key, host.db.key)
})

test('expiry: an invite that ran out while a reply failed to be kept ends the join EXPIRED', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ confirm: true, ttl: '1d' })
  await joiner.mailbox.ready()
  let expire = null
  const keep = async () => {
    expire()
    throw new Error('disk full')
  }
  const join = () => joiner.join(invite, { writer: crypto.keyPair(), keep, timeout: 0 })
  const ended = code(expiring(join, (fn) => (expire = fn)))
  await host.pairing.accept((await asked(host.db)).id)
  t.is(await ended, 'EXPIRED')
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

test('confirm: a joiner that cancels takes its request back from the room, which turns nobody away', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ confirm: true })
  const writer = crypto.keyPair()
  const stop = new AbortController()
  const joining = joiner.join(invite, { writer, timeout: 0, signal: stop.signal })
  const { id } = await asked(host.db)

  stop.abort()
  t.is(await code(joining), 'CLOSED')
  await Pairing.cancel(joiner.mailbox, invite, { spec, writer })
  await waitFor(async () => (await host.db.get('requests')).data.length === 0)
  t.pass('the request is gone')
  t.absent(await host.db.view.get(`@${host.db.ns}/refusals`, { id }), 'and nobody turned it away')
  t.absent(await member(host.db, joiner.identity), 'nor let in')
})

test('confirm: a cancel its mailbox closes on rejects CLOSED, and one made again announces the cancel already written', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ confirm: true })
  const writer = crypto.keyPair()
  const stop = new AbortController()
  const joining = joiner.join(invite, { writer, timeout: 0, signal: stop.signal })
  await asked(host.db)
  stop.abort()
  t.is(await code(joining), 'CLOSED')
  const { store } = joiner.net
  const core = store.get({
    keyPair: writer,
    manifest: { version: store.manifestVersion, signers: [{ publicKey: writer.publicKey }] }
  })
  t.teardown(() => core.close())
  await core.ready()

  await host.net.suspend()
  const cancelling = Pairing.cancel(joiner.mailbox, invite, { spec, writer })
  await waitFor(() => core.length === 2)
  await joiner.mailbox.close()
  t.is(await code(cancelling), 'CLOSED', 'it stops announcing')

  const again = new Mailbox(joiner.net)
  t.teardown(() => again.close())
  await host.net.resume()
  await Pairing.cancel(again, invite, { spec, writer })
  t.is(core.length, 2, 'written once')
  await waitFor(async () => (await host.db.get('requests')).data.length === 0)
  t.pass('and the room holds it')
})

test('confirm: two cancels at once from one writer write one', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite({ confirm: true })
  const writer = crypto.keyPair()
  const stop = new AbortController()
  const joining = joiner.join(invite, { writer, timeout: 0, signal: stop.signal })
  await asked(host.db)
  stop.abort()
  t.is(await code(joining), 'CLOSED')
  const { store } = joiner.net
  const core = store.get({
    keyPair: writer,
    manifest: { version: store.manifestVersion, signers: [{ publicKey: writer.publicKey }] }
  })
  t.teardown(() => core.close())
  await core.ready()

  await Promise.all([
    Pairing.cancel(joiner.mailbox, invite, { spec, writer }),
    Pairing.cancel(joiner.mailbox, invite, { spec, writer })
  ])
  t.is(core.length, 2, 'the join and one cancel')
  await waitFor(async () => (await host.db.get('requests')).data.length === 0)
  t.pass('and the room holds it')
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

test('revoke: by the id its row holds', async (t) => {
  const testnet = await makeTestnet(t)
  const { host } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite()
  const [row] = await invites(host.db)
  t.is(await host.pairing.revoke(row.id), true)
  t.is(await host.pairing.revoke(invite), false, 'the code finds nothing left')
  t.is(await host.pairing.revoke('nothing'), false, 'nor does what is neither')
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

// three joins on an invite the host spent, one after the other while none of its devices
// answers: the last one, still waiting, and how to stop the others
async function late(t, testnet, host) {
  const first = await makeJoiner(t, testnet)
  const invite = await host.pairing.invite()
  await first.join(invite)
  await host.pairing.close()
  const stop = new AbortController()
  const seen = new Set()
  let last
  for (let i = 0; i < 3; i++) {
    const { join } = await makeJoiner(t, testnet)
    last = join(invite, { timeout: 0, signal: stop.signal }).catch((e) => e)
    await waitFor(async () => (await refusals(host.db)).some((row) => !seen.has(row.id)))
    for (const row of await refusals(host.db)) seen.add(row.id)
  }
  return { last, stop }
}

test('refused: a spent invite keeps one answer, and the newest of its joiners hears why', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet, { spec: built })
  const { last, stop } = await late(t, testnet, host)
  t.is((await refusals(host.db)).length, 1, 'one row, whoever joined before')

  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  await pairing.ready()
  const err = await last
  t.is(err.code, 'DENIED', 'answered once a device of the host is back')
  t.is(err.reason, 'spent')
  stop.abort()
})

test("refused: below the version that has an invite's secret, a spent invite keeps an answer for each join", async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet)
  const { last, stop } = await late(t, testnet, host)
  t.is((await refusals(host.db)).length, 3)
  stop.abort()
  t.is((await last).code, 'CLOSED')
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

// ─── invites with an address of their own ──────────────────────────────────

test('proven: an invite minted where the version keeps its secret has an address of its own', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing, db } = await makeHost(t, testnet, { spec: built })
  const one = Invite.parse(await pairing.invite({ reuse: true }))
  const two = Invite.parse(await pairing.invite())
  t.ok(one.own, 'marked as its own')
  t.is(one.version, STAMPED, 'in the form the previous release parses, at the start too')
  t.unlike(one.address, db.address, "not the room's")
  t.unlike(one.address, two.address, 'and another for each invite')
  const rows = await invites(db)
  for (const invite of [one, two]) {
    const row = rows.find((r) => r.id === b4a.toHex(invite.id))
    t.is(row.secret?.byteLength, 32, 'its row holds the secret')
    t.alike(Mailbox.getAddress(row.secret), invite.address, 'which owns the address')
  }
})

test("proven: where the version has no field for the secret, an invite is today's and joins as today", async (t) => {
  const testnet = await makeTestnet(t)
  // the release that brings the secret with contract 2, in a database still at 1
  const later = dated(built, 2)
  const host = await makeHost(t, testnet, {
    spec: { ...later, meta: { ...later.meta, version: 2 } }
  })
  const invite = await host.pairing.invite({ reuse: true })
  const parsed = Invite.parse(invite)
  t.alike(parsed.address, host.db.address, "the room's address")
  t.absent(parsed.own)
  t.is(parsed.version, 1, 'in the form every release joins with')
  t.absent((await invites(host.db))[0].secret, 'and no secret on its row')
  const joiner = await makeJoiner(t, testnet)
  const answers = heard(joiner.mailbox)
  t.alike((await joiner.join(invite)).encryptionKey, host.db.encryptionKey, 'it joins as today')
  const answer = c.decode(Response, answers[0])
  t.alike(answers[0], c.encode(Response, answer), 'answered with the answer alone, no tag')

  await host.db.write([['upgrade', { version: 2 }]])
  const after = Invite.parse(await host.pairing.invite())
  t.ok(after.own, 'once the database has the field, an invite has its own address')
  t.unlike(after.address, host.db.address)
})

test("proven: where the built spec has no field for the secret, an invite is today's and joins as today", async (t) => {
  const testnet = await makeTestnet(t)
  // the app on a spec built before the field: its dates name no secret, or it has no dates at all
  const { since } = built.meta
  const { secret, ...invite } = since.types['@cero/invite']
  const unnamed = { ...since, types: { ...since.types, '@cero/invite': invite } }
  t.is(secret, 0, 'the fixture has it from the start')
  for (const [why, dates] of [
    ['no date for the field', unnamed],
    ['no dates', undefined]
  ]) {
    const stale = { ...built, meta: { ...built.meta, since: dates } }
    const host = await makeHost(t, testnet, { spec: stale })
    const code = await host.pairing.invite()
    const parsed = Invite.parse(code)
    t.alike(parsed.address, host.db.address, `${why}: the room's address`)
    t.absent(parsed.own)
    t.absent((await invites(host.db))[0].secret, 'no secret on its row')
    const joiner = await makeJoiner(t, testnet)
    t.alike((await joiner.join(code)).encryptionKey, host.db.encryptionKey, 'it joins as today')
  }
})

test('proven: an invite with its own address tells a build below its stamp to update, and the encoding from before its mark reads the stamp', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet, {
    spec: { ...built, meta: { ...built.meta, version: 2 } }
  })
  await host.db.write([['upgrade', { version: 2 }]])
  const invite = await host.pairing.invite()
  t.ok(Invite.parse(invite).own)

  const joiner = await makeJoiner(t, testnet)
  t.is(await code(joiner.join(invite)), 'BEHIND', 'a build at 1 is told to update')
  // the invite's encoding as it was before the mark, then as it is
  const before = decodeAt('@cero/invite', z32.decode(invite), 2)
  const now = decodeAt('@cero/invite', z32.decode(invite))
  t.is(before.version, STAMPED, 'in the form a build that reads stamps parses')
  t.is(before.stamp, 2, 'with its stamp')
  t.alike(before.address, now.address, 'and every field before the mark')
  t.absent(before.own)
  t.ok(now.own)
})

test('proven: a join on an invite with its own address names it, and is admitted', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const invite = await host.pairing.invite()
  const result = await joiner.join(invite)
  t.alike(result.key, host.db.key)
  t.alike(result.encryptionKey, host.db.encryptionKey)
  t.is((await promises(host.db))[0]?.role, 'member', 'let in')
  const { value } = built.dispatch.decode((await joinOf(joiner.net, result.writer)).body)
  t.alike(value.invite, Invite.parse(invite).id, 'named in the clear')
})

// every message a mailbox hands to a join
function heard(mailbox) {
  const messages = []
  const receive = mailbox.receive.bind(mailbox)
  mailbox.receive = (key, onmessage, opts) =>
    receive(key, (message) => messages.push(message) && onmessage(message), opts)
  return messages
}

// a join waiting on a confirm invite with its own address, and `ignored`: whether a message sent
// to its reply address was read there and settled nothing
async function waitingJoin(t, testnet) {
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const read = new Set()
  const put = joiner.mailbox.inbox.put
  joiner.mailbox.inbox.put = async (m) => read.add(m.id) && put(m)
  const writer = crypto.keyPair()
  const kept = []
  const keep = async (answer) => kept.push(answer)
  const joining = joiner.join(await host.pairing.invite({ confirm: true }), { writer, keep })
  joining.catch(() => {})
  const request = await asked(host.db)
  const reply = Mailbox.getAddress(writer.secretKey)
  const rows = () => joiner.mailbox.inbox.list()
  const ignored = async (message) => {
    await host.mailbox.send(reply, message)
    const id = b4a.toHex(await sentKey(host.net, (await host.mailbox.outbox.list()).at(-1)))
    const unread = async () => (await rows()).some((m) => m.id === id && !m.handled)
    const turned = await waitFor(async () => read.has(id) && !(await unread())).catch(() => false)
    return turned && kept.length === 0
  }
  return { host, joining, request, reply, ignored }
}

test('proven: an untagged acceptance and an untagged denial at the reply address are ignored, the genuine answer lands', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joining, request, ignored } = await waitingJoin(t, testnet)
  // what anyone who ever had the room's first key can write
  const { key, encryptionKey } = host.db
  const accepted = { status: STATUS_ACCEPTED, reason: '', key, encryptionKey, epochs: [] }
  const denied = { status: STATUS_DENIED, reason: 'forged' }
  t.ok(
    await ignored(c.encode(Response, accepted)),
    "an acceptance with the room's keys and no tag settles nothing"
  )
  t.ok(await ignored(c.encode(Response, denied)), 'nor a denial, shorter than a tag')

  await host.pairing.accept(request.id)
  t.alike((await joining).encryptionKey, host.db.encryptionKey, 'the one the invite proves does')
})

test('proven: an answer tagged by anything but its invite and its reply address is ignored', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joining, request, reply, ignored } = await waitingJoin(t, testnet)
  const [{ secret }] = await invites(host.db)
  const { secretKey } = Mailbox.keyPair(secret)
  const denial = c.encode(Response, { status: STATUS_DENIED, reason: 'forged' })
  const other = c.encode(Response, { status: STATUS_DENIED, reason: 'spent' })
  const tags = {
    'another secret': tag(denial, Mailbox.keyPair(crypto.randomBytes(32)).secretKey, reply),
    'for another reply address': tag(denial, secretKey, crypto.encryptionKeyPair().publicKey),
    'of another answer': tag(other, secretKey, reply)
  }
  for (const [why, forged] of Object.entries(tags)) {
    t.ok(await ignored(b4a.concat([forged, denial])), `a tag ${why} settles nothing`)
  }

  await host.pairing.accept(request.id)
  t.alike((await joining).key, host.db.key, 'the genuine answer still lands')
})

test('proven: a denial on an invite with its own address carries its reason', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const joining = joiner.join(await host.pairing.invite({ confirm: true })).catch((e) => e)
  await host.pairing.deny((await asked(host.db)).id, 'not today')
  const err = await joining
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'not today')
  await waitFor(async () => (await refusals(host.db)).length === 0)
  t.pass('and the refusal goes once read')
})

test("proven: a join on a spent invite with its own address is answered spent, under the invite's tag", async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner: one } = await makeHostJoiner(t, testnet, { spec: built })
  const two = await makeJoiner(t, testnet)
  const invite = await host.pairing.invite()
  const [{ secret }] = await invites(host.db)
  await one.join(invite)
  t.alike((await spent(host.db))[0]?.secret, secret, 'the spent row keeps the secret')

  const answers = heard(two.mailbox)
  const writer = crypto.keyPair()
  const err = await two.join(invite, { writer, timeout: 10000 }).catch((e) => e)
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'spent')
  const mine = Mailbox.keyPair(writer.secretKey)
  const answer = proven(answers[0], mine.secretKey, Invite.parse(invite).address)
  t.is(c.decode(Response, answer).reason, 'spent', 'the answer after a tag the invite made')
  t.absent(await member(host.db, two.identity), 'and was not admitted')
})

test('proven: the tag of a fixed answer, the same from either end, over the bytes sent', (t) => {
  const invite = crypto.encryptionKeyPair(b4a.alloc(32, 1))
  const reply = crypto.encryptionKeyPair(b4a.alloc(32, 2))
  const answer = c.encode(Response, { status: STATUS_DENIED, reason: 'spent' })
  const expected = b4a.from(
    '03a71b3fb1b06247002e12d9596f6f5963ab48b5edaf57a8cd170f23f52317a6',
    'hex'
  )
  t.alike(tag(answer, invite.secretKey, reply.publicKey), expected, "from the invite's secret")
  t.alike(tag(answer, reply.secretKey, invite.publicKey), expected, "from the joiner's")
  const message = b4a.concat([expected, answer])
  t.alike(proven(message, reply.secretKey, invite.publicKey), answer, 'the bytes after the tag')
  const other = c.encode(Response, { status: STATUS_DENIED, reason: 'revoked' })
  const swapped = b4a.concat([expected, other])
  t.is(proven(swapped, reply.secretKey, invite.publicKey), null, 'bound to those bytes')
  t.is(proven(answer, reply.secretKey, invite.publicKey), null, 'shorter than a tag: none')
  t.is(tag(answer, invite.secretKey, b4a.alloc(32)), null, 'an address that shares nothing: none')
  t.is(proven(message, reply.secretKey, b4a.alloc(32)), null)
})

// ─── let in through an invite with its own address: a promise ──────────────

const promises = async (db) => (await db.get('requests')).data.filter((row) => row.promised)
const memberOf = member

// a device with the keys a join got: the database, opened with the join's writer or its own
async function opened(t, { net, identity }, { key, encryptionKey, epochs, writer }) {
  const keys = { key, encryptionKey, epochs, keyPair: writer }
  const db = new Database({ store: net.store, identity, network: net, spec: built, ...keys })
  await db.ready()
  t.teardown(() => db.close().catch(() => {}), { order: 1 })
  return db
}

test("promised: a join leaves no member and no seat until the joiner's device claims", async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const reply = await joiner.join(await host.pairing.invite({ role: 'admin' }))
  const [owed] = await promises(host.db)
  t.is(owed?.role, 'admin', "promised at the invite's role")
  t.ok(owed.proof, 'the promise keeps the proof of its join')
  t.is(reply.proof, null, 'which is no chain for its answer to carry')
  t.absent(await member(host.db, joiner.identity), 'no member at the join')
  t.absent((await host.db.get('devices', owed.id)).data, 'and no seat')

  const db = await opened(t, joiner, reply)
  await db.claim()
  t.ok(db.writable, 'its device seats itself')
  t.is((await member(db, joiner.identity))?.role, 'admin', "the member, at the invite's role")
  await waitFor(async () => (await promises(host.db)).length === 0)
  t.is((await member(host.db, joiner.identity))?.role, 'admin')
  t.is((await host.db.get('devices', owed.id)).data?.memberId, joiner.identity.id)
})

test("promised: a join admitted on an invite with the room's address is seated already, its claim appends nothing", async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const reply = await joiner.join(await host.pairing.invite())
  t.is((await member(host.db, joiner.identity))?.role, 'member', 'a member at the join')
  const { key, encryptionKey, epochs, writer: keyPair } = reply
  const { net: network, identity } = joiner
  const keys = { key, encryptionKey, epochs, keyPair }
  const db = new Database({ store: network.store, identity, network, spec, ...keys })
  await db.ready()
  t.teardown(() => db.close().catch(() => {}), { order: 1 })
  await db.claim()
  await waitFor(() => db.writable)
  t.is(db.length, 1, 'its core holds the join alone')
})

test('promised: its keys downloaded settle nothing', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  await joiner.join(await host.pairing.invite())
  const [owed] = await promises(host.db)
  // a download is all a device offering the keys sees, whoever made it
  await host.pairing._replies.get(owed.id).delivered
  const length = host.db.length
  await host.db.call('set-device', { id: hid.encode(host.db.writerKey), name: 'later' })
  t.is(host.db.length, length + 1, 'nothing was written at the download')
  t.is((await promises(host.db)).length, 1, 'the promise stands')
  t.ok(host.pairing._replies.has(owed.id), 'still offered its keys')
  t.absent(await member(host.db, joiner.identity))
})

test("promised: a reader's device claims a member row and no seat", async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const reply = await joiner.join(await host.pairing.invite({ role: 'reader' }))
  const db = await opened(t, joiner, reply)
  await db.claim()
  t.is((await member(db, joiner.identity))?.role, 'reader', 'a member once it claimed')
  t.absent(db.writable, 'with no seat')
  t.is((await db.get('devices', hid.encode(db.writerKey))).data?.memberId, joiner.identity.id)
  await waitFor(async () => (await promises(host.db)).length === 0)
  t.is((await member(host.db, joiner.identity))?.role, 'reader')
})

test('promised: another device of the identity, holding the keys, keeps the promise the join made', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const reply = await joiner.join(await host.pairing.invite())
  const other = await makeMailbox(t, testnet)
  // a device that never joined finds the room on its topic
  for (const net of [host.net, other.net]) await net.join(host.db.discoveryKey).flush()
  // it did not hear the join announced: a member's next write carries the join's core to it
  await host.db.call('set-device', { id: hid.encode(host.db.writerKey), name: 'later' })
  // the keys as its root hands them on, a device key and a writer of its own
  const device = Identity.randomKeyPair()
  const proof = joiner.identity.link(device.publicKey)
  const identity = Identity.from({ ...joiner.identity, device, proof })
  const second = await opened(t, { ...other, identity }, { ...reply, writer: null })
  await second.claim()
  t.ok(second.writable, 'a device that never joined seats itself')
  await waitFor(async () => (await member(host.db, joiner.identity))?.role === 'member')
  t.is((await promises(host.db)).length, 1, 'the device that joined is still offered its keys')

  const first = await opened(t, joiner, reply)
  await first.claim()
  t.ok(first.writable, 'and seats itself, as any device of a member')
  await waitFor(async () => (await promises(host.db)).length === 0)
  t.pass('then the promise is settled')
})

test("promised: a member's other device let in by an invite gets its keys, and is settled once seated", async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const invite = await host.pairing.invite({ reuse: true })
  const first = await opened(t, joiner, await joiner.join(invite))
  await first.claim()
  await waitFor(async () => (await promises(host.db)).length === 0)

  const other = await makeMailbox(t, testnet)
  const device = Identity.randomKeyPair()
  const proof = joiner.identity.link(device.publicKey)
  const identity = Identity.from({ ...joiner.identity, device, proof })
  const reply = await Pairing.join(other.mailbox, invite, { identity, spec: built, timeout: 8000 })
  t.alike(reply.key, host.db.key, 'promised to a member already, it is offered its keys')
  t.is((await promises(host.db)).length, 1, 'until its own device is seated')
  const db = await opened(t, { net: other.net, identity }, reply)
  await db.claim()
  t.ok(db.writable)
  await waitFor(async () => (await promises(host.db)).length === 0)
  t.pass('settled once its own device is seated')
})

test("promised: a reader's other device let in by an invite claims its device row and no seat, is settled, and reads", async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const invite = await host.pairing.invite({ role: 'reader', reuse: true })
  const first = await opened(t, joiner, await joiner.join(invite))
  await first.claim()
  await waitFor(async () => (await promises(host.db)).length === 0)

  const other = await makeMailbox(t, testnet)
  const device = Identity.randomKeyPair()
  const proof = joiner.identity.link(device.publicKey)
  const identity = Identity.from({ ...joiner.identity, device, proof })
  const reply = await Pairing.join(other.mailbox, invite, { identity, spec: built, timeout: 8000 })
  t.is((await promises(host.db)).length, 1, 'promised to a reader already')
  // the promise stands while its device claims twice: the host settles it after
  const done = host.pairing._done
  host.pairing._done = async () => []
  const db = await opened(t, { net: other.net, identity }, reply)
  await db.claim({ timeout: 8000 })
  t.absent(db.writable, 'no seat')
  const { data: seat } = await db.get('devices', hid.encode(db.writerKey))
  t.is(seat?.memberId, joiner.identity.id, 'its device row')
  t.alike(seat?.key, device.publicKey, 'with its device key')
  const { length } = db
  await db.claim({ timeout: 8000 })
  t.is(db.length, length, 'kept, its next claim appends nothing')

  host.pairing._done = done
  const { data: row } = await host.db.put('messages', { text: 'for her' })
  await waitFor(async () => (await promises(host.db)).length === 0)
  t.is((await memberOf(host.db, joiner.identity))?.role, 'reader', 'settled, a reader still')
  await waitFor(async () => (await db.get('messages', row.id)).data?.text === 'for her')
  t.pass('and reads what the room writes')
})

test("promised: a member's device that joined claims only once its view holds its own join", async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const invite = await host.pairing.invite({ reuse: true })
  const first = await opened(t, joiner, await joiner.join(invite))
  await first.claim()

  const other = await makeMailbox(t, testnet)
  const device = Identity.randomKeyPair()
  const proof = joiner.identity.link(device.publicKey)
  const identity = Identity.from({ ...joiner.identity, device, proof })
  const reply = await Pairing.join(other.mailbox, invite, { identity, spec: built })
  const db = await opened(t, { net: other.net, identity }, reply)
  // its view as one still catching up: its member's row is there, what its own join wrote is not
  const get = db.get.bind(db)
  let behind = true
  let looked = 0
  db.get = async (name, query) => {
    if (name === 'members') looked++
    if (!behind || (name !== 'requests' && name !== 'devices')) return get(name, query)
    return { data: typeof query === 'string' ? null : [] }
  }
  const { system } = db.bee
  const read = system.get.bind(system)
  system.get = async (key, opts) =>
    behind && b4a.equals(key, db.writerKey) ? null : read(key, opts)
  const claiming = db.claim()
  await waitFor(() => looked > 0)
  const early = await waitFor(() => db.length > 1, { timeout: 1500 }).catch(() => false)
  t.absent(early, 'no claim is appended ahead of its own join')

  behind = false
  db.emit('update', new Set(['requests']))
  await claiming
  await waitFor(() => db.writable)
  t.is(db.length, 2, 'once its view holds its join, it claims')
})

test('promised: a writer that joins again under another invite is answered under that one', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const writer = crypto.keyPair()
  await joiner.join(await host.pairing.invite(), { writer })
  const [{ id }] = await promises(host.db)
  const earlier = host.pairing._replies.get(id)

  const again = await joiner.join(await host.pairing.invite(), { writer, timeout: 8000 })
  t.alike(again.key, host.db.key, 'its second join gets its keys')
  t.not(host.pairing._replies.get(id), earlier, 'in a post made for the row as it now stands')
  t.ok(earlier.closing || earlier.closed, 'and the earlier one is let go')
})

test('promised: an inviter settles a promise once its device is seated, and a device that did not hear the join learns of the member from that write', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const reply = await joiner.join(await host.pairing.invite())
  const { length } = host.db
  const db = await opened(t, joiner, reply)
  await db.claim()
  await waitFor(async () => (await promises(host.db)).length === 0)
  t.is(host.db.length, length + 1, 'settled by one write of the host')
  t.is((await member(host.db, joiner.identity))?.role, 'member', 'the member stays')
  await waitFor(() => !host.pairing.serving)
  t.is(host.pairing._replies.size, 0, 'and she is offered her keys no more')

  // the joiner goes: what a device opening later learns, it learns from the host's log
  await db.close()
  await joiner.mailbox.close()
  await joiner.net.close()
  const late = await makeMailbox(t, testnet)
  for (const net of [host.net, late.net]) await net.join(host.db.discoveryKey).flush()
  const second = await opened(
    t,
    { net: late.net, identity: host.identity },
    { ...reply, writer: null }
  )
  await waitFor(async () => !!(await member(second, joiner.identity)))
  t.pass('another device of the host has the member, with no other write')
})

test('promised: accepting a waiting join promises at the accepted role, and its device claims', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const joining = joiner.join(await host.pairing.invite({ confirm: true, reuse: true }))
  const request = await asked(host.db)
  await host.pairing.accept(request.id, { role: 'reader' })
  const reply = await joining
  t.is((await promises(host.db))[0]?.role, 'reader', 'promised at the accepted role')
  t.absent(await member(host.db, joiner.identity), 'no member yet')
  t.is(await code(host.pairing.accept(request.id)), 'UNKNOWN', 'accepting again writes nothing')

  const db = await opened(t, joiner, reply)
  await db.claim()
  await waitFor(async () => (await member(host.db, joiner.identity))?.role === 'reader')
  t.is((await promises(host.db)).length, 0)
})

test('promised: a linked device gets its chain in the answer, claims, and keeps its own promise alone', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet, { spec: built })
  const link = async () => {
    const { mailbox, net } = await makeMailbox(t, testnet)
    const device = Identity.randomKeyPair()
    const identity = await Identity.bare(device)
    const invite = await host.pairing.invite({ role: 'owner', confirm: true, ttl: '2h' })
    const joining = Pairing.join(mailbox, invite, { identity, spec: built })
    const mine = (row) => b4a.equals(row.key, device.publicKey)
    const request = await waitFor(async () => (await waiting(host.db)).find(mine))
    await host.pairing.accept(request.id, { proof: host.identity.link(request.key) })
    return { net, device, reply: await joining, id: request.id }
  }
  const phone = await link()
  const tablet = await link()
  const owed = await promises(host.db)
  t.is(owed.length, 2, 'each a promise')
  t.alike(owed.find((row) => row.id === phone.id).proof, phone.reply.proof, 'with its chain')
  t.absent((await host.db.get('devices', phone.id)).data, 'and no seat')

  const { reply, device, net } = phone
  const { publicKey } = host.identity
  const { encryptionKey, proof } = reply
  const identity = Identity.from({ publicKey, encryptionKey, device, proof })
  const db = await opened(t, { net, identity }, reply)
  await db.claim()
  t.ok(db.writable, 'the linked device seats itself')
  const { data: seat } = await db.get('devices', phone.id)
  t.is(seat?.memberId, host.identity.id, 'a device of the host')
  t.alike(seat.proof, proof, 'its seat keeps the chain')
  await waitFor(async () => (await promises(host.db)).length === 1)
  t.is((await promises(host.db))[0].id, tablet.id, "the other device's promise stands")
  t.is((await host.db.get('members')).data.length, 1, 'no member was added')
})

test('promised: a device linked through a device that is then removed is offered no keys', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  // another device of the host's identity, seated: the one that links
  const device = Identity.randomKeyPair()
  const proof = host.identity.link(device.publicKey)
  const linker = Identity.from({ ...host.identity, device, proof })
  const other = await makeMailbox(t, testnet)
  for (const net of [host.net, other.net]) await net.join(host.db.discoveryKey).flush()
  const { key, encryptionKey } = host.db
  const b = await opened(t, { net: other.net, identity: linker }, { key, encryptionKey })
  await b.claim()

  const phone = Identity.randomKeyPair()
  const answers = heard(joiner.mailbox)
  const invite = await host.pairing.invite({ confirm: true })
  const bare = await Identity.bare(phone)
  Pairing.join(joiner.mailbox, invite, { identity: bare, spec: built, timeout: 0 }).catch(() => {})
  const { id } = await asked(host.db)
  // linked and then cut off while the host answers nobody
  await host.pairing.close()
  await host.db.call('accept', { id, proof: linker.link(phone.publicKey) })
  const { data: row } = await host.db.get('requests', id)
  await host.db.call('del-device', { id: hid.encode(b.writerKey) })

  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  await pairing.ready()
  t.is(pairing._replies.size, 0, 'no keys are offered')
  t.is(answers.length, 0, 'and its join hears nothing')
  t.alike(await pairing._done([row]), [row], 'a promise whose chain passes a removed key is over')
  const own = { ...row, proof: null, key: device.publicKey }
  t.alike(await pairing._done([own]), [own], 'as is one to a removed key itself')
  t.alike(await pairing._done([{ ...row, proof: host.identity.link(phone.publicKey) }]), [])

  // a promise through a device its identity then tells the room is removed, as apply left it
  const lost = Identity.randomKeyPair()
  const link = host.identity.link(lost.publicKey)
  const through = Identity.from({ ...host.identity, device: lost, proof: link })
  const told = { ...row, proof: through.link(phone.publicKey) }
  t.alike(await pairing._done([told]), [], 'a promise through a device nobody removed is owed')
  await host.db.call('revoke', { removed: lost.publicKey, standing: phone.publicKey })
  t.alike(await pairing._done([told]), [], 'as it is told as standing')
  await host.db.call('revoke', { removed: lost.publicKey, standing: b4a.alloc(0) })
  t.alike(await pairing._done([told]), [told], 'told removed, it is over and no keys are delivered')
})

test('link: a device told as standing links another once the device that linked it is removed, and the removed one links nobody', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet, { spec: built })
  // the host's phone, since lost, and the tablet it had linked
  const linked = (identity) => {
    const device = Identity.randomKeyPair()
    return Identity.from({ ...identity, device, proof: identity.link(device.publicKey) })
  }
  const phone = linked(host.identity)
  const tablet = linked(phone)
  const told = { removed: phone.device.publicKey, standing: tablet.device.publicKey }
  await host.db.call('revoke', told)

  const ask = async (opts) => {
    const { mailbox } = await makeMailbox(t, testnet)
    const device = Identity.randomKeyPair()
    const identity = await Identity.bare(device)
    const invite = await host.pairing.invite({ role: 'owner', confirm: true })
    const joining = Pairing.join(mailbox, invite, { identity, spec: built, ...opts })
    joining.catch(() => {})
    const mine = (row) => b4a.equals(row.key, device.publicKey)
    const request = await waitFor(async () => (await waiting(host.db)).find(mine))
    return { joining, request }
  }
  const late = await ask({ timeout: 0 })
  const signed = phone.link(late.request.key)
  await t.exception(host.pairing.accept(late.request.id, { proof: signed }), /REFUSED/)
  const { data: row } = await host.db.get('requests', late.request.id)
  t.absent(row.admitted, 'a link the removed device signs lets nobody in')
  await host.pairing.deny(late.request.id)
  t.is(await code(late.joining), 'DENIED', 'and its join is turned away like any other')

  const watch = await ask()
  const proof = tablet.link(watch.request.key)
  await host.pairing.accept(watch.request.id, { proof })
  const reply = await watch.joining
  t.alike(reply.proof, proof, 'one the standing device signs is answered with its chain')
  const owed = await promises(host.db)
  t.ok(
    owed.find((row) => row.id === watch.request.id),
    'and let in'
  )
})

test('withdrawn: a promise denied by a member who may remove reaches the joiner with the reason', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const invite = await host.pairing.invite({ reuse: true })
  const writer = crypto.keyPair()
  await joiner.join(invite, { writer })
  const [owed] = await promises(host.db)

  await host.pairing.deny(owed.id, 'not you')
  t.is((await promises(host.db)).length, 0, 'the promise is withdrawn')
  const answers = heard(joiner.mailbox)
  const err = await joiner.join(invite, { writer, timeout: 8000 }).catch((e) => e)
  t.is(err.code, 'DENIED', 'her join, taken up again, hears it')
  t.is(err.reason, 'not you')
  const mine = Mailbox.keyPair(writer.secretKey)
  const answer = proven(answers[0], mine.secretKey, Invite.parse(invite).address)
  t.is(c.decode(Response, answer).reason, 'not you', "after her invite's tag")
  t.absent(await member(host.db, joiner.identity))
})

test('withdrawn: a device that holds the keys ends its claim DENIED, with the reason, once it reads its promise gone', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const reply = await joiner.join(await host.pairing.invite())
  const [owed] = await promises(host.db)
  await host.pairing.deny(owed.id, 'not you')

  const db = await opened(t, joiner, reply)
  const err = await db.claim({ timeout: 8000 }).catch((e) => e)
  t.is(err?.code, 'DENIED', 'no seat to wait for')
  t.is(err?.reason, 'not you')
  t.is(db.length, 1, 'and nothing claimed')
})

test('withdrawn: a claim appended as its promise is withdrawn ends DENIED too', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const reply = await joiner.join(await host.pairing.invite())
  const [owed] = await promises(host.db)
  const db = await opened(t, joiner, reply)
  // the withdrawal reaches her view after she read the promise, before her claim is on her core
  const append = db.bee.append.bind(db.bee)
  db.bee.append = async (...args) => {
    await host.pairing.deny(owed.id, 'too late')
    await waitFor(async () => (await promises(db)).length === 0)
    return append(...args)
  }
  const err = await db.claim({ timeout: 8000 }).catch((e) => e)
  t.is(err?.code, 'DENIED', 'her wait for the seat ends')
  t.is(err?.reason, 'too late')
  t.absent(db.writable)
  t.absent(await member(host.db, joiner.identity), 'and she is no member')
})

test('withdrawn: a writer turned away under one invite, joining again under another, does not end its claim on the old refusal', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner: one } = await makeHostJoiner(t, testnet, { spec: built })
  const two = await makeJoiner(t, testnet)
  const once = await host.pairing.invite()
  await one.join(once)
  // no device of the host answers, so the refusal stays in the log
  await host.pairing.close()
  const writer = crypto.keyPair()
  const stop = new AbortController()
  const first = two.join(once, { writer, timeout: 0, signal: stop.signal }).catch((e) => e)
  await waitFor(async () => (await refusals(host.db)).length === 1)
  stop.abort()
  await first
  // what the host writes next carries her join to every device
  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  await pairing.ready()
  await pairing.invite()

  const { key, encryptionKey } = host.db
  const keys = { key, encryptionKey, epochs: host.db.keyring.all(), writer }
  const db = await opened(t, two, keys)
  for (const net of [host.net, two.net]) await net.join(host.db.discoveryKey).flush()
  await waitFor(async () => (await refusals(db)).length === 1)
  const err = await db.claim({ timeout: 8000 }).catch((e) => e)
  t.is(err?.code, 'DENIED', 'the refusal of the join its core carries ends its claim')
  t.is(err?.reason, 'spent')
  await db.close()

  // an invite her device has not read yet: her join with it lands on no view, and hers still
  // holds the old refusal
  await host.net.suspend()
  const next = await pairing.invite()
  t.is(await code(two.join(next, { writer, timeout: 2000 })), 'TIMEOUT')
  const again = await opened(t, two, keys)
  t.is((await refusals(again)).length, 1)
  const waited = await again.claim({ timeout: 3000 }).catch((e) => e)
  t.is(waited?.code, 'TIMEOUT', 'which is no answer to the join it carries now')
})

// a member of the host's database at `role`, on its own device, answering joins
async function seated(t, testnet, host, role) {
  const { mailbox, net, identity, join } = await makeJoiner(t, testnet)
  const db = await opened(t, { net, identity }, await join(await host.pairing.invite({ role })))
  await db.claim()
  const pairing = new Pairing({ mailbox, db })
  await pairing.ready()
  t.teardown(() => pairing.close().catch(() => {}), { order: 0 })
  return { db, pairing }
}

test("withdrawn: past its invite, a promise nobody kept is denied 'expired' by a device that may remove, and left alone by one that may not", async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const member = await seated(t, testnet, host, 'member')
  await waitFor(async () => (await promises(host.db)).length === 0)
  const invite = await host.pairing.invite({ ttl: 2000 })
  // only the member's device answers: it may invite, not remove
  await host.pairing.close()
  const denies = []
  const call = member.db.call.bind(member.db)
  member.db.call = async (verb, row) => (verb === 'deny' ? denies.push(row) : call(verb, row))
  await joiner.join(invite)
  const [owed] = await promises(member.db)
  t.ok(member.pairing._replies.has(owed.id), 'offered its keys while the invite lasts')
  await waitFor(() => Date.now() > owed.expires && !member.pairing._replies.has(owed.id))
  await waitFor(() => !member.pairing.serving)
  t.is((await promises(member.db)).length, 1, 'past it, one who may not remove only stops offering')
  t.is(denies.length, 0, 'and denies nothing')

  const pairing = new Pairing({ mailbox: host.mailbox, db: host.db })
  t.teardown(() => pairing.close())
  await pairing.ready()
  await waitFor(async () => (await promises(host.db)).length === 0)
  t.pass('one who may remove withdraws it')
  t.absent(await memberOf(host.db, joiner.identity), 'and nobody became a member')
})

test('withdrawn: a promise under an invite a removal spent ends its claim DENIED, and a join with the invite after hears the same', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const member = await seated(t, testnet, host, 'member')
  await waitFor(async () => (await promises(host.db)).length === 0)
  const invite = await host.pairing.invite({ reuse: true })
  const reply = await joiner.join(invite)
  t.is((await promises(host.db)).length, 1, 'promised, and not claimed yet')

  await host.db.del('members', member.db.identity.id)
  t.is((await promises(host.db)).length, 0, 'the removal withdraws it with its invite')
  const db = await opened(t, joiner, reply)
  const err = await db.claim({ timeout: 8000 }).catch((e) => e)
  t.is(err?.code, 'DENIED', 'no seat to wait for')
  t.is(err?.reason, 'removed')
  t.is(db.length, 1, 'and nothing claimed')

  const other = await makeJoiner(t, testnet)
  const late = await other.join(invite, { timeout: 8000 }).catch((e) => e)
  t.is(late.code, 'DENIED', 'the invite lets nobody else in')
  t.is(late.reason, 'removed')
})

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

test('confirm: a second join of the same writer that waits over its promise owes a rotation', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet, { spec: built })
  const counter = async (name) =>
    (await host.db.view.get(`@${host.db.ns}/counters`, { name }))?.value ?? 0
  const writer = crypto.keyPair()
  const first = await joiner.join(await host.pairing.invite(), { writer })
  t.ok(first.encryptionKey, 'the joiner holds the keys')
  const [{ id }] = await promises(host.db)
  t.is(await counter('_owed'), 0, 'nothing owed while promised')
  const epochs = await counter('epochs')

  const asks = await host.pairing.invite({ confirm: true })
  const second = joiner.join(asks, { writer, timeout: 8000 }).catch((e) => e)
  await waitFor(async () => {
    const { data } = await host.db.get('requests', id)
    return data && !data.promised
  })
  await waitFor(async () => (await counter('_owed')) > 0 || (await counter('epochs')) > epochs)
  await host.pairing.deny(id, 'no')
  t.is((await second).code, 'DENIED', 'the joiner is turned away')
  t.absent(await member(host.db, joiner.identity), 'no member')
})

// ─── keys asked for ────────────────────────────────────────────────────────

const asks = (db) => db.view.find(`@${db.ns}/owed`, {}).toArray()
const texts = async (db) => (await db.get('messages')).data.map((row) => row.text)
const writerId = ({ db }) => hid.encode(db.writerKey)
const device = async (peer) => (await peer.db.get('devices', writerId(peer))).data

// the host's next key, sealed to its device and those of `peers` alone, and a write under it: a
// device left out reads up to there
async function leftOut(host, ...peers) {
  const devices = []
  for (const peer of [host, ...peers]) devices.push(await device(peer))
  await host.db.rotation._rotate(false, devices)
  await host.db.put('messages', { text: 'under' })
}

// a room every device holds the first key of
async function keyed(t, ...roles) {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet, { spec: built })
  const peers = []
  for (const role of roles) peers.push(await seated(t, testnet, host, role))
  await waitFor(async () => (await promises(host.db)).length === 0)
  await host.db.rotate()
  for (const { db } of peers) await waitFor(() => db.keyring.seq === 1)
  return { testnet, host, peers }
}

async function reopened(t, { mailbox, db }) {
  const pairing = new Pairing({ mailbox, db })
  t.teardown(() => pairing.close().catch(() => {}), { order: 0 })
  await pairing.ready()
  return pairing
}

for (const role of ['member', 'reader']) {
  test(`keys asked for: a device of a ${role} left out of the newest key is sent them, reads what was written under it, and closes its row`, async (t) => {
    const { host, peers } = await keyed(t, role)
    const [{ db }] = peers
    const owed = []
    const note = (is) => owed.push(is)
    db.on('update', () => db.owed().then(note, () => {}))
    await leftOut(host)
    await waitFor(async () => (await texts(db)).includes('under'), { timeout: 30000 })
    t.pass('it reads what was written under the key it was left out of')
    t.ok(owed.includes(true), 'owed while its row stood')
    await waitFor(async () => (await asks(host.db)).length === 0 && !(await db.owed()))
    t.pass('and its own device closed its row, the keys saved')
    await waitFor(() => host.pairing._keys.size === 0)
    t.pass('nothing is sent once it closed')
  })
}

test('keys asked for: two devices that hold the keys both send them, and the one that asked ends with one copy', async (t) => {
  const { host, peers } = await keyed(t, 'member', 'member')
  const [holds, asked] = peers
  const id = writerId(asked)
  const { mailbox } = asked.pairing
  await asked.pairing.close()
  await leftOut(host, holds)
  await waitFor(() => host.pairing._keys.has(id) && holds.pairing._keys.has(id))
  t.pass('the owner sends them, and so does a plain member who may not remove')
  const first = host.pairing._keys.get(id)
  await host.db.rotate()
  await waitFor(() => host.pairing._keys.has(id) && host.pairing._keys.get(id) !== first)
  t.pass('and again once the sender learns one more key')

  await reopened(t, { mailbox, db: asked.db })
  await waitFor(async () => (await texts(asked.db)).includes('under'), { timeout: 30000 })
  await waitFor(async () => (await asks(host.db)).length === 0)
  const rows = await asked.db.rotation._epochs()
  const stamps = asked.db.keyring.all().map((e) => e.stamp)
  t.alike(stamps.sort(), rows.map((row) => row.stamp).sort(), 'one copy of each key in the log')
  await waitFor(() => host.pairing._keys.size === 0 && holds.pairing._keys.size === 0)
  t.pass('and both stop once its row closed')
})

test('keys asked for: a secret that fails its commitment is refused and the row stays, until the right one comes', async (t) => {
  const { host, peers } = await keyed(t, 'member')
  const [{ db, pairing }] = peers
  await host.pairing.close()
  await leftOut(host)
  await waitFor(async () => (await asks(db)).length === 1)
  const [row] = await asks(db)
  const top = (await db.rotation._epochs()).reduce((a, b) => (b.epoch > a.epoch ? b : a))
  const reads = []
  const onkeys = pairing._onkeys.bind(pairing)
  pairing._onkeys = async (message) => {
    const out = await onkeys(message)
    reads.push(out)
    return out
  }
  const none = { status: STATUS_DENIED, reason: 'no', key: null, encryptionKey: null, epochs: null }
  await host.mailbox.send(row.reply, c.encode(Response, none), { keep: false })
  await waitFor(() => reads.length === 1)
  t.is(reads[0], false, 'an answer with no keys is turned away')
  const epochs = [{ epoch: top.epoch, stamp: top.stamp, entropy: crypto.randomBytes(32) }]
  const forged = { status: STATUS_ACCEPTED, reason: '', key: db.key, encryptionKey: null, epochs }
  await host.mailbox.send(row.reply, c.encode(Response, forged), { keep: false })
  await waitFor(() => reads.length === 2)
  t.absent(db.keyring.entropy(top.stamp), 'not learned')
  t.is(await db.owed(), true, 'and its row stands')
  t.is(pairing._keys.size, 0, 'a device that holds keys sends its own row none')

  const answer = pairing._answer.bind(pairing)
  pairing._answer = async (...args) => {
    await answer(...args)
    await pairing.close()
  }
  await pairing._sync()
  t.is(pairing._inbox, null, 'a sync its pairing closed under receives at no address')
  await reopened(t, { mailbox: pairing.mailbox, db })
  await reopened(t, host)
  await waitFor(async () => (await texts(db)).includes('under'), { timeout: 30000 })
  await waitFor(async () => !(await db.owed()))
  t.pass('the one that meets it is learned, and closes the row')
})

test('keys asked for: keys signed by a key no seated device holds keep nothing, those a seated device signs are kept, and a stranger sending first does not stop them', async (t) => {
  const { host, peers } = await keyed(t, 'member')
  const [{ db, pairing }] = peers
  await host.pairing.close()
  await leftOut(host)
  await waitFor(async () => (await asks(db)).length === 1)
  const [row] = await asks(db)
  const reads = []
  const onkeys = pairing._onkeys.bind(pairing)
  pairing._onkeys = async (message) => {
    const out = await onkeys(message)
    reads.push(out)
    return out
  }
  const send = (by, writer, stamp, entropy = crypto.randomBytes(32)) => {
    const epochs = [{ epoch: 9, stamp, entropy }]
    const keys = { status: STATUS_ACCEPTED, reason: '', key: db.key, encryptionKey: null, epochs }
    const message = signed(c.encode(Response, keys), {
      room: db.key,
      to: db.writerKey,
      writer,
      secretKey: by.secretKey
    })
    return host.mailbox.send(row.reply, message, { keep: false })
  }
  const stranger = crypto.keyPair()
  for (let stamp = 700; stamp < 704; stamp++) await send(stranger, stranger.publicKey, stamp)
  await send(stranger, host.db.writerKey, 777)
  await waitFor(() => reads.length === 5)
  t.is(db.rotation._kept.size, 0, 'nothing kept from a key no device row holds')

  const real = crypto.randomBytes(32)
  await send(host.db.identity.device, host.db.writerKey, 777, real)
  await waitFor(() => reads.length === 6)
  t.alike(
    db.rotation._kept.get(writerId(host)),
    new Map([[777, [real]]]),
    'a seated device is kept'
  )
})

test('keys asked for: a device removed after it asked is sent nothing, nor is any by a device with no key, with no seat, or behind', async (t) => {
  const testnet = await makeTestnet(t)
  const host = await makeHost(t, testnet, { spec: built })
  const member = await seated(t, testnet, host, 'member')
  await waitFor(async () => (await promises(host.db)).length === 0)
  const row = (peer) => ({ id: writerId(peer), reply: crypto.randomBytes(32) })
  await host.pairing._deliver([row(member)])
  t.is(host.pairing._keys.size, 0, 'a device that holds no key sends none')
  await host.db.rotate()
  await waitFor(() => member.db.keyring.seq === 1)
  await host.pairing._deliver([row(member)])
  t.is(host.pairing._keys.size, 1, 'one that holds keys sends them to a device that stands')
  host.db.emit('update', new Set(['devices']))
  await waitFor(() => host.pairing._keys.size === 0)
  t.pass('until a change of devices shows no row of it')

  await host.pairing.close()
  await leftOut(host)
  await waitFor(async () => (await asks(host.db)).length === 1)
  const [asked] = await asks(host.db)
  await host.db.del('members', member.db.identity.id)
  t.alike(await asks(host.db), [], 'the removal takes its row')
  const pairing = await reopened(t, host)
  t.is(pairing._keys.size, 0, 'and it is sent nothing')
  await pairing._deliver([asked])
  t.is(pairing._keys.size, 0, 'nor would a row left of a device that no longer stands be')

  const joiner = await makeJoiner(t, testnet)
  const db = await opened(t, joiner, await joiner.join(await pairing.invite()))
  await waitFor(async () => (await db.get('devices', writerId(host))).data)
  t.ok(db.keyring.all().length > 0, 'a device handed its keys')
  const idle = await reopened(t, { mailbox: joiner.mailbox, db })
  await idle._deliver([row(host)])
  t.is(idle._keys.size, 0, 'sends none before it took its seat')

  await db.claim()
  await waitFor(async () => (await host.db.get('devices', writerId({ db }))).data)
  await pairing._deliver([row({ db })])
  t.is(pairing._keys.size, 1)
  await host.db.write([['upgrade', { version: host.db.version + 1 }]])
  await waitFor(() => host.db.behind !== null)
  await pairing._deliver([row({ db })])
  t.is(pairing._keys.size, 0, 'and a device that is behind sends none')
})

// ─── an invite made to one member ─────────────────────────────────────────

test("invite: one made to a member is single-use and waits for no accept, and 'to' is her id", async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing, db } = await makeHost(t, testnet)
  const { id } = await Identity.create()
  t.is(await code(pairing.invite({ to: id, reuse: true })), 'INVALID', 'not reusable')
  t.is(await code(pairing.invite({ to: id, confirm: true })), 'INVALID', 'nor confirmed')
  t.is(await code(pairing.invite({ to: 'nobody' })), 'INVALID', 'nor made to what is no id')
  t.alike(await invites(db), [], 'no invite was written')
  await pairing.invite({ to: id })
  t.is((await invites(db))[0].to, id, 'on its row')
})

test('serving: invites made to a member owe no answer, any other does', async (t) => {
  const testnet = await makeTestnet(t)
  const { pairing } = await makeHost(t, testnet)
  await pairing.invite({ to: (await Identity.create()).id })
  t.is(pairing.serving, false, 'her device joins with the keys it was handed')
  await pairing.invite()
  t.is(pairing.serving, true)
})

test('write: the join goes into the writer core once, waiting for nothing, and a join with that writer goes on from it', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, joiner } = await makeHostJoiner(t, testnet)
  const invite = await host.pairing.invite()
  const writer = crypto.keyPair()
  const opts = { identity: joiner.identity, spec, writer }
  await Promise.all([
    Pairing.write(joiner.mailbox, invite, opts),
    Pairing.write(joiner.mailbox, invite, opts)
  ])
  await Pairing.write(joiner.mailbox, invite, opts)
  const key = Hypercore.key({ version: 2, signers: [{ publicKey: writer.publicKey }] })
  const core = joiner.net.store.get({ key })
  await core.ready()
  t.is(core.length, 1, 'one join, however often it is written')
  t.absent(await member(host.db, joiner.identity), 'and nobody heard of it')

  const { key: room } = await joiner.join(invite, { writer })
  t.alike(room, host.db.key, 'the join goes on from it')
  t.is(core.length, 1, 'writing nothing more')
  t.ok(await member(host.db, joiner.identity))
  await core.close()
})
