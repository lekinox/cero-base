import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import AbortController from 'bare-abort-controller'
import b4a from 'b4a'
import z32 from 'z32'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import hid from 'hypercore-id-encoding'

import { Network } from '../../src/network/index.js'
import { Identity } from '../../src/identity/index.js'
import { Database } from '../../src/database/index.js'
import { Pairing } from '../../src/pairing/index.js'
import { Invite } from '../../src/pairing/invite.js'
import { STATUS_ACCEPTED } from '../../src/pairing/request.js'
import { Mailbox } from '../../src/mailbox/index.js'
import { Post } from '../../src/mailbox/post.js'
import { getEncoding } from '../../src/lib/spec/index.js'
import { CeroError } from '../../src/lib/errors.js'
import { spec } from '../fixtures/spec/index.js'

import { makeStore, makeBlindPeer, waitFor } from '../helpers/index.js'

test.configure({ timeout: 60000 })

const testnet = await createTestnet(3)
const Knock = getEncoding('@cero/knock')

async function makeMailbox(t, { outbox, ...opts } = {}) {
  const identity = await Identity.create()
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const net = new Network({ identity, bootstrap: testnet.bootstrap, store, ...opts })
  await net.ready()
  t.teardown(() => net.close().catch(() => {}), { order: 2 })
  const mailbox = new Mailbox(net, { outbox })
  t.teardown(() => mailbox.close().catch(() => {}), { order: 1 })
  return { mailbox, net, identity }
}

// a member: the owner of a fresh database, serving its invites
async function makeHost(t, { mirrors, outbox } = {}) {
  const { mailbox, net, identity } = await makeMailbox(t, { mirrors, outbox })
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
  const join = (invite, opts = {}) => Pairing.join(mailbox, invite, { identity, ...opts })
  return { mailbox, net, identity, join }
}

async function makeHostJoiner(t, opts = {}) {
  return { host: await makeHost(t, opts), joiner: await makeJoiner(t) }
}

const sample = () => ({ discoveryKey: crypto.randomBytes(32), address: crypto.randomBytes(32) })
const idOf = (invite) => b4a.toHex(Invite.parse(invite).id)
const invites = async (db) => (await db.get('invites')).data

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
  t.is(record.id, idOf(invite))
  t.alike(Mailbox.getAddress(record.secret), parsed.address, 'the record owns its address')
  t.is(record.role, 'reader')
  t.is(record.reuse, true)
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

test('Invite.parse round-trips: discovery key, address, id', async (t) => {
  const { pairing, db } = await makeHost(t, { mirrors: [crypto.randomBytes(32)] })
  const invite = await pairing.invite()
  const parsed = Invite.parse(invite)
  t.alike(parsed.discoveryKey, db.discoveryKey)
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

test('Invite.create: needs a 32-byte discovery key and address', (t) => {
  t.exception(() => Invite.create({ ...sample(), discoveryKey: b4a.alloc(8) }), /discoveryKey/)
  t.exception(() => Invite.create({ ...sample(), address: null }), /address/)
  t.exception(() => Invite.create({ ...sample(), data: 'clinic' }), /data must be a buffer/)
})

test('Invite proof: only the invite holder proves a reply address', async (t) => {
  const { pairing } = await makeHost(t)
  const invite = Invite.parse(await pairing.invite())
  const reply = crypto.randomBytes(32)
  t.ok(Invite.proven(invite.id, reply, invite.prove(reply)))
  t.absent(
    Invite.proven(invite.id, crypto.randomBytes(32), invite.prove(reply)),
    'bound to the reply'
  )
  const other = Invite.parse(await pairing.invite())
  t.absent(Invite.proven(invite.id, reply, other.prove(reply)), 'bound to the invite')
})

// ─── handshake ─────────────────────────────────────────────────────────────

test('handshake: accept admits the joiner and sends the keys and epochs', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  await host.db.rotate()
  const invite = await host.pairing.invite({ role: 'member' })

  host.pairing.once('candidate', async (request) => {
    t.is(request.invite.role, 'member', 'the request carries the served invite')
    t.alike(request.identity, joiner.identity.publicKey, 'the joiner identity, proven')
    await request.accept()
  })

  const result = await joiner.join(invite)
  t.alike(result.key, host.db.key)
  t.alike(result.encryptionKey, host.db.encryptionKey)
  t.alike(result.epochs, host.db.keyring.all(), 'the epochs, to read the history before')
  t.is(result.writer.publicKey.byteLength, 32, 'a fresh writer, returned to open the database')

  const { data: member } = await host.db.get('members', hid.encode(joiner.identity.publicKey))
  t.is(member.role, 'member', 'admitted before the reply went out')
})

test('handshake: accept checks the role and the expiry first', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)

  // an invite capped at member, and one with no role, which leaves only the rank check
  const capped = await host.pairing.invite({ role: 'member' })
  const open = await host.pairing.invite()
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

test('handshake: a member can deny with a reason', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  host.pairing.on('candidate', (request) => request.deny('not-today'))

  const err = await joiner.join(invite).catch((e) => e)
  t.is(err.code, 'DENIED')
  t.is(err.reason, 'not-today')
})

test('handshake: a reply for another database is ignored', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  host.pairing.on('candidate', (request) =>
    request._respond({ status: STATUS_ACCEPTED, reason: '', key: crypto.randomBytes(32) })
  )

  const err = await joiner.join(invite, { timeout: 3000 }).catch((e) => e)
  t.is(err.code, 'TIMEOUT')
})

test('handshake: a knock without the invite proof, or claiming another identity, is dropped', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite({ reuse: true })
  const parsed = Invite.parse(invite)

  const seen = []
  host.pairing.on('candidate', async (request) => {
    seen.push(request.identity)
    await request.accept()
  })

  const reply = crypto.randomBytes(32)
  const noProof = { proof: crypto.randomBytes(64), identity: joiner.identity.publicKey }
  // holds the invite, but claims an identity it cannot sign for
  const victim = { proof: parsed.prove(reply), identity: (await Identity.create()).publicKey }
  for (const forged of [noProof, victim]) {
    const knock = { id: parsed.id, reply, writer: crypto.randomBytes(32), ...forged }
    knock.signature = crypto.randomBytes(64)
    const post = new Post(joiner.net, parsed.address, c.encode(Knock, knock))
    t.teardown(() => post.close())
    await post.ready()
    await post.delivered
  }

  await joiner.join(invite)
  t.alike(seen, [joiner.identity.publicKey], 'only the real knock became a candidate')
})

test('pending: a request stays listed until it is settled', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  const knocked = new Promise((resolve) => host.pairing.once('candidate', resolve))
  const joining = joiner.join(invite)

  const request = await knocked
  t.alike([...host.pairing.pending], [request])
  await request.accept()
  t.is(host.pairing.pending.size, 0)
  await joining
})

// ─── joiner errors ─────────────────────────────────────────────────────────

test('join: needs a mailbox and an identity; a writer, if given, is a keypair', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  const { identity, mailbox } = joiner
  await t.exception(Pairing.join(null, invite, { identity }), /mailbox/)
  await t.exception(Pairing.join(mailbox, invite, {}), /identity/)
  const writer = crypto.randomBytes(32)
  await t.exception(Pairing.join(mailbox, invite, { identity, writer }), /writer/)
})

test('join: invalid invite → INVALID_INVITE, expired → EXPIRED', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  t.is((await joiner.join('not-an-invite').catch((e) => e)).code, 'INVALID_INVITE')
  const invite = await host.pairing.invite({ ttl: -1000 })
  t.is((await joiner.join(invite).catch((e) => e)).code, 'EXPIRED')
})

test('join: times out when nobody serves the invite', async (t) => {
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

test('multiple joiners, one invite each', async (t) => {
  const { host, joiner: one } = await makeHostJoiner(t)
  const two = await makeJoiner(t)
  const first = await host.pairing.invite({ role: 'member' })
  const second = await host.pairing.invite({ role: 'reader' })

  const roles = []
  host.pairing.on('candidate', async (request) => {
    roles.push(request.invite.role)
    await request.accept()
  })

  await one.join(first)
  await two.join(second)
  t.alike(roles, ['member', 'reader'])
})

test('revoke: dropped from the database, no longer served', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  t.is(await host.pairing.revoke(invite), true)
  t.is(await host.pairing.revoke(invite), false, 'revoking again finds nothing')
  t.alike(await invites(host.db), [])

  let fired = false
  host.pairing.on('candidate', () => {
    fired = true
  })
  t.is((await joiner.join(invite, { timeout: 2000 }).catch((e) => e)).code, 'TIMEOUT')
  t.absent(fired)
})

test('single-use invite: accepting once consumes it; a second joiner times out', async (t) => {
  const { host, joiner: one } = await makeHostJoiner(t)
  const two = await makeJoiner(t)
  const invite = await host.pairing.invite()
  host.pairing.once('candidate', (request) => request.accept())

  await one.join(invite)
  await waitFor(async () => (await invites(host.db)).length === 0)
  t.pass('consumed')
  t.is((await two.join(invite, { timeout: 2000 }).catch((e) => e)).code, 'TIMEOUT')
})

test('multi-use invite: a second joiner is also admitted', async (t) => {
  const { host, joiner: one } = await makeHostJoiner(t)
  const two = await makeJoiner(t)
  const invite = await host.pairing.invite({ reuse: true })
  host.pairing.on('candidate', (request) => request.accept())

  t.alike((await one.join(invite)).key, host.db.key)
  t.alike((await two.join(invite)).key, host.db.key)
  t.is((await invites(host.db)).length, 1, 'the invite stays')
})

test('an invite expired at the member is consumed without a candidate', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite({ ttl: '1h' })
  // the joiner's copy is still valid, the member's clock says otherwise
  host.pairing._invites.get(idOf(invite)).expires = 1

  let fired = false
  host.pairing.on('candidate', () => {
    fired = true
  })
  const controller = new AbortController()
  const joining = joiner.join(invite, { timeout: 0, signal: controller.signal }).catch((e) => e)
  await waitFor(async () => (await invites(host.db)).length === 0, { timeout: 30000 })
  t.absent(fired)
  controller.abort()
  await joining
})

// ─── resilience ────────────────────────────────────────────────────────────

test('a resumed join hears the reply to an earlier knock', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const invite = await host.pairing.invite()
  const writer = crypto.keyPair()

  // the joiner knocks, then stops before the member answers
  const knocked = new Promise((resolve) => host.pairing.once('candidate', resolve))
  const controller = new AbortController()
  const first = joiner.join(invite, { writer, signal: controller.signal }).catch((e) => e)
  const request = await knocked
  controller.abort()
  t.is((await first).code, 'CLOSED')
  await request.accept()

  // the invite is consumed, so the new knock goes unanswered: only the earlier reply can land
  const again = await makeJoiner(t)
  const result = await Pairing.join(again.mailbox, invite, { identity: joiner.identity, writer })
  t.alike(result.key, host.db.key)
})

test('an invite is consumed only once its reply is kept', async (t) => {
  let keep, sent
  const kept = new Promise((resolve) => {
    keep = resolve
  })
  const sending = new Promise((resolve) => {
    sent = resolve
  })
  const outbox = {
    list: async () => [],
    put: () => {
      sent()
      return kept
    },
    del: async () => {}
  }
  const { host, joiner } = await makeHostJoiner(t, { outbox })
  const invite = await host.pairing.invite()
  host.pairing.once('candidate', (request) => request.accept())
  const controller = new AbortController()
  const joining = joiner.join(invite, { timeout: 0, signal: controller.signal }).catch((e) => e)

  await sending
  t.is((await invites(host.db)).length, 1, 'still served while the reply is not kept')
  keep()
  await waitFor(async () => (await invites(host.db)).length === 0)
  t.pass('consumed once kept')
  controller.abort()
  await joining
})

test('offline: member and joiner are never online together, the mirror carries both ways', async (t) => {
  const mirror = await makeBlindPeer(t, testnet)
  // both run the app's mirror; the member's database is mirrored, which keeps it connected
  const host = await makeHost(t, { mirrors: [mirror.publicKey] })
  const invite = await host.pairing.invite()
  await host.net.suspend()

  const joiner = await makeJoiner(t, { mirrors: [mirror.publicKey] })
  const knocked = holds(mirror, Invite.parse(invite).address)
  const joining = joiner.join(invite, { timeout: 60000 })
  await knocked
  await joiner.net.suspend()

  const accepted = new Promise((resolve) => {
    host.pairing.once('candidate', async (request) => {
      await request.accept()
      resolve()
    })
  })
  await host.net.resume()
  await accepted
  await waitFor(async () => (await host.mailbox.outbox.list()).length === 0, { timeout: 30000 })
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
