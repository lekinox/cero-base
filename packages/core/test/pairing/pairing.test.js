import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
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
import { Response, STATUS_ACCEPTED } from '../../src/pairing/request.js'
import { Mailbox } from '../../src/mailbox/index.js'
import { getEncoding } from '../../src/lib/spec/index.js'
import { CeroError } from '../../src/lib/errors.js'
import { spec } from '../fixtures/spec/index.js'

import { makeStore, makeBlindPeer, waitFor } from '../helpers/index.js'

test.configure({ timeout: 60000 })

const testnet = await createTestnet(3)

async function makeMailbox(t, opts = {}) {
  const identity = await Identity.create()
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const net = new Network({ identity, bootstrap: testnet.bootstrap, store, ...opts })
  await net.ready()
  t.teardown(() => net.close().catch(() => {}), { order: 2 })
  const mailbox = new Mailbox(net)
  t.teardown(() => mailbox.close().catch(() => {}), { order: 1 })
  return { mailbox, net, identity }
}

// a member: the owner of a fresh database, answering its joins
async function makeHost(t, { mirrors } = {}) {
  const { mailbox, net, identity } = await makeMailbox(t, { mirrors })
  const db = new Database({ store: net.store, identity, network: net, spec })
  await db.ready()
  await db.bootstrap({ name: 'host' })
  t.teardown(() => db.close().catch(() => {}), { order: 1 })
  const pairing = new Pairing({ mailbox, db })
  await pairing.ready()
  t.teardown(() => pairing.close().catch(() => {}), { order: 0 })
  return { pairing, mailbox, net, db, identity }
}

async function makeJoiner(t, { mirrors } = {}) {
  const { mailbox, net, identity } = await makeMailbox(t, { mirrors })
  const join = (invite, opts = {}) => Pairing.join(mailbox, invite, { identity, spec, ...opts })
  return { mailbox, net, identity, join }
}

async function makeHostJoiner(t, opts = {}) {
  return { host: await makeHost(t, opts), joiner: await makeJoiner(t) }
}

const sample = () => ({
  key: crypto.randomBytes(32),
  address: crypto.randomBytes(32),
  link: { key: crypto.randomBytes(32), length: 1 }
})
const invites = async (db) => (await db.get('invites')).data
const member = async (db, identity) =>
  (await db.get('members', hid.encode(identity.publicKey))).data

// ─── construction / lifecycle ──────────────────────────────────────────────

test('construction: a mailbox and a database', async (t) => {
  const { mailbox } = await makeMailbox(t)
  t.exception.all(() => new Pairing({ db: {} }), /mailbox/)
  t.exception.all(() => new Pairing({ mailbox }), /db/)
})

test('ready() + close() lifecycle, both idempotent', async (t) => {
  const { pairing } = await makeHost(t)
  await pairing.ready()
  t.ok(pairing.opened)
  await pairing.close()
  await pairing.close()
  t.ok(pairing.closed)
})

// ─── invites ───────────────────────────────────────────────────────────────

test('invite: a z32 string, kept in the database', async (t) => {
  const { pairing, db } = await makeHost(t)
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

test('invite: the role is a rank', async (t) => {
  const { pairing } = await makeHost(t)
  await t.exception(pairing.invite({ role: 'volunteer' }), /not a rank/)
})

test('invite: ttl is ms or a duration', async (t) => {
  const { pairing } = await makeHost(t)
  const inMs = Invite.parse(await pairing.invite({ ttl: 60_000 }))
  t.ok(Math.abs(inMs.expires - Date.now() - 60_000) < 5000)
  t.is(Invite.parse(await pairing.invite()).expires, 0, 'no ttl, no expiry')
  await t.exception(pairing.invite({ ttl: 'soon' }), /not a duration/)
})

test('invite: a rank above member is single-use', async (t) => {
  const { pairing } = await makeHost(t)
  await t.exception(pairing.invite({ role: 'admin', reuse: true }), /at most member/)
  t.ok(await pairing.invite({ role: 'member', reuse: true }))
  t.ok(await pairing.invite({ role: 'admin' }))
})

test('Invite.parse round-trips: key, address, id', async (t) => {
  const { pairing, db } = await makeHost(t, { mirrors: [crypto.randomBytes(32)] })
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
  const { pairing } = await makeHost(t)
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
  const { host, joiner } = await makeHostJoiner(t)
  await host.db.rotate()
  const invite = await host.pairing.invite({ role: 'member' })
  host.pairing.on('candidate', () => t.fail('no candidate: nobody has to accept'))

  const result = await joiner.join(invite)
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
  const { host, joiner } = await makeHostJoiner(t)
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
  const { host, joiner: one } = await makeHostJoiner(t)
  const two = await makeJoiner(t)
  const invite = await host.pairing.invite({ role: 'reader', reuse: true })

  t.alike((await one.join(invite)).key, host.db.key)
  t.alike((await two.join(invite)).key, host.db.key)
  t.is((await member(host.db, one.identity)).role, 'reader')
  t.is((await member(host.db, two.identity)).role, 'reader')
  t.is((await invites(host.db)).length, 1, 'the invite stays')
})

test('join: a single-use invite admits once; a second joiner times out', async (t) => {
  const { host, joiner: one } = await makeHostJoiner(t)
  const two = await makeJoiner(t)
  const invite = await host.pairing.invite()

  await one.join(invite)
  t.is((await two.join(invite, { timeout: 3000 }).catch((e) => e)).code, 'TIMEOUT')
  t.absent(await member(host.db, two.identity), 'and was not admitted')
})

test('join: a member joining again from another device keeps its record', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite({ role: 'member', reuse: true })
  await joiner.join(invite)
  const before = await member(host.db, joiner.identity)
  await host.db.call('set-member', { ...before, role: 'admin', updatedAt: Date.now() })

  // the same identity on a second device, with a writer of its own
  const device = await makeMailbox(t)
  const result = await Pairing.join(device.mailbox, invite, { identity: joiner.identity, spec })
  const after = await member(host.db, joiner.identity)
  t.is(after.role, 'admin', 'the role it was given since')
  t.is(after.createdAt, before.createdAt)
  const writer = Hypercore.key({ version: 2, signers: [{ publicKey: result.writer.publicKey }] })
  t.is((await host.db.get('devices', hid.encode(writer))).data?.memberId, joiner.identity.id)
})

test('join: a fresh invite takes over from one that admits nobody', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const revoked = await host.pairing.invite()
  await host.pairing.revoke(revoked)
  const writer = crypto.keyPair()
  const err = await joiner.join(revoked, { writer, timeout: 2000 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT', 'the revoked invite admits nobody')

  // the same writer, as a join resumed with a new invite keeps it
  const result = await joiner.join(await host.pairing.invite(), { writer })
  t.alike(result.key, host.db.key)
  t.ok(await member(host.db, joiner.identity))
})

test('join: a reply for another database is ignored', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  await host.pairing.close()
  const writer = crypto.keyPair()
  const forged = { status: STATUS_ACCEPTED, reason: '', key: crypto.randomBytes(32) }
  await host.mailbox.send(Mailbox.getAddress(writer.secretKey), c.encode(Response, forged))

  const err = await joiner.join(invite, { writer, timeout: 3000 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT')
})

test('expiry: a joiner admitted past its invite is removed, not answered', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
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

// ─── confirm invites: a member accepts ─────────────────────────────────────

test('confirm: a join waits as a candidate until a member accepts it', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite({ role: 'member', confirm: true })
  const asked = new Promise((resolve) => host.pairing.once('candidate', resolve))
  const joining = joiner.join(invite)

  const request = await asked
  t.alike(request.identity, joiner.identity.publicKey, 'the joiner identity, proven')
  t.is(request.invite.role, 'member')
  t.alike([...host.pairing.pending], [request], 'listed until settled')
  t.absent(await member(host.db, joiner.identity), 'not admitted yet')

  await request.accept()
  t.alike((await joining).key, host.db.key)
  t.is((await member(host.db, joiner.identity)).role, 'member')
  await waitFor(() => host.pairing.pending.size === 0)
  await waitFor(async () => (await host.db.get('requests')).data.length === 0)
  t.pass('the request settles once the joiner read its keys')
})

test('confirm: accept checks the role and the expiry first', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const capped = await host.pairing.invite({ role: 'member', confirm: true })
  const open = await host.pairing.invite({ confirm: true })
  const requests = []
  host.pairing.on('candidate', (request) => requests.push(request))
  const joining = [joiner.join(capped).catch((e) => e), joiner.join(open).catch((e) => e)]
  await waitFor(() => requests.length === 2)
  const [first, second] = requests[0].invite.role ? requests : [...requests].reverse()

  await t.exception(first.accept({ role: 'owner' }), /exceeds the invite role/)
  await t.exception(second.accept({ role: 'volunteer' }), /not a rank/)
  first.invite.expires = 1
  await t.exception(first.accept(), /expired/)
  await first.deny('no')
  await second.deny('no')
  for (const err of await Promise.all(joining)) t.is(err.code, 'DENIED')
})

test('confirm: a member can deny with a reason', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite({ confirm: true })
  host.pairing.on('candidate', (request) => request.deny('not-today'))

  const err = await joiner.join(invite).catch((e) => e)
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'not-today')
  t.alike((await host.db.get('requests')).data, [])
  t.absent(await member(host.db, joiner.identity))
})

test('confirm: accepting one join spends a single-use invite, the others are dropped', async (t) => {
  const { host, joiner: one } = await makeHostJoiner(t)
  const two = await makeJoiner(t)
  const invite = await host.pairing.invite({ role: 'admin', confirm: true })
  const requests = []
  host.pairing.on('candidate', (request) => requests.push(request))
  const joining = [one, two].map((j) => j.join(invite, { timeout: 5000 }).catch((e) => e))
  await waitFor(() => requests.length === 2)

  await requests[0].accept()
  await waitFor(() => host.pairing.pending.size === 0)
  t.alike(
    (await host.db.get('requests')).data.filter((row) => !row.admitted),
    [],
    'the other request went with the invite'
  )
  await requests[1].accept()
  const results = await Promise.all(joining)
  t.is(results.filter((r) => r.key).length, 1, 'one joiner admitted')
  t.is(results.filter((r) => r.code === 'TIMEOUT').length, 1, 'accepting the other does nothing')
})

// ─── joiner errors ─────────────────────────────────────────────────────────

test('join: needs a mailbox, an identity and a spec; a writer, if given, is a keypair', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  const { identity, mailbox } = joiner
  await t.exception(Pairing.join(null, invite, { identity, spec }), /mailbox/)
  await t.exception(Pairing.join(mailbox, invite, { spec }), /identity/)
  await t.exception(Pairing.join(mailbox, invite, { identity }), /spec/)
  const writer = crypto.randomBytes(32)
  await t.exception(Pairing.join(mailbox, invite, { identity, spec, writer }), /writer/)
})

test('join: invalid invite → INVALID_INVITE, expired → EXPIRED', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  t.is((await joiner.join('not-an-invite').catch((e) => e)).code, 'INVALID_INVITE')
  const invite = await host.pairing.invite({ ttl: -1000 })
  t.is((await joiner.join(invite).catch((e) => e)).code, 'EXPIRED')
})

test('join: times out when no member answers', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  await host.pairing.close()
  t.is((await joiner.join(invite, { timeout: 1500 }).catch((e) => e)).code, 'TIMEOUT')
})

test('join: waiting for good still ends when the invite expires', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const soon = await host.pairing.invite({ ttl: 1500 })
  const later = await host.pairing.invite({ ttl: '30d' })
  await host.pairing.close()
  t.is((await joiner.join(soon, { timeout: 0 }).catch((e) => e)).code, 'EXPIRED')
  const err = await joiner.join(later, { timeout: 1500 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT', 'an expiry past the timer range does not fire early')
})

test('join: closing the mailbox stops it with CLOSED', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  await host.pairing.close()
  const joining = joiner.join(invite, { timeout: 0 }).catch((e) => e)
  await joiner.mailbox.close()
  t.is((await joining).code, 'CLOSED')
  t.is((await joiner.join(invite).catch((e) => e)).code, 'CLOSED', 'and once it is closed')
})

test('join: an abort signal stops it', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  const controller = new AbortController()
  const joining = joiner.join(invite, { timeout: 0, signal: controller.signal }).catch((e) => e)
  controller.abort()
  t.is((await joining).code, 'CLOSED')
})

// ─── invite lifecycle ──────────────────────────────────────────────────────

test('revoke: dropped from the database, it admits nobody', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  t.is(await host.pairing.revoke(invite), true)
  t.is(await host.pairing.revoke(invite), false, 'revoking again finds nothing')
  t.alike(await invites(host.db), [])

  t.is((await joiner.join(invite, { timeout: 2000 }).catch((e) => e)).code, 'TIMEOUT')
  t.absent(await member(host.db, joiner.identity))
})

test('expiry: a member who can remove drops the invite once it runs out', async (t) => {
  const host = await makeHost(t)
  await host.pairing.invite({ ttl: 1000 })
  t.is((await invites(host.db)).length, 1)
  await waitFor(async () => (await invites(host.db)).length === 0, { timeout: 10000 })
  t.pass('the log stops admitting it')
})

test('expiry: an invite reaching its expiry this very millisecond is still watched', async (t) => {
  const host = await makeHost(t)
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
  const host = await makeHost(t)
  t.is(host.pairing.serving, false)
  const invite = await host.pairing.invite()
  t.is(host.pairing.serving, true)
  await host.pairing.revoke(invite)
  t.is(host.pairing.serving, false)
})

// ─── resilience ────────────────────────────────────────────────────────────

test('a resumed join hears the reply to its earlier join', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
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
  const again = await makeJoiner(t)
  const opts = { identity: joiner.identity, spec, writer }
  t.alike((await Pairing.join(again.mailbox, invite, opts)).key, host.db.key)
})

test('offline: member and joiner are never online together, the mirror carries both ways', async (t) => {
  const mirror = await makeBlindPeer(t, testnet)
  // both run the app's mirror; the member's database is mirrored, which keeps it connected
  const host = await makeHost(t, { mirrors: [mirror.publicKey] })
  const invite = await host.pairing.invite()
  await host.net.suspend()

  const joiner = await makeJoiner(t, { mirrors: [mirror.publicKey] })
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

test('teardown shared testnet', async (t) => {
  await testnet.destroy()
  t.pass()
})
