import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import b4a from 'b4a'
import z32 from 'z32'
import c from 'compact-encoding'

import { Network } from '../../src/network/index.js'
import { Identity } from '../../src/identity/index.js'
import { Pairing } from '../../src/pairing/index.js'
import { Invite } from '../../src/pairing/invite.js'
import { CeroError } from '../../src/lib/errors.js'

import { once } from '../helpers/index.js'

test.configure({ timeout: 60000 })

const testnet = await createTestnet(3)

async function makeNet(t, opts = {}) {
  const id = opts.identity || (await Identity.generate())
  const net = new Network({ identity: id, bootstrap: testnet.bootstrap, ...opts })
  await net.ready()
  t.teardown(() => net.close().catch(() => {}), { order: 1 })
  return { net, id }
}

async function makePairing(t, opts = {}) {
  const { net, id } = await makeNet(t, { identity: opts.identity })
  const pairing = new Pairing({ network: net, identity: id, ...opts })
  await pairing.ready()
  t.teardown(() => pairing.close().catch(() => {}), { order: 0 })
  return { pairing, net, identity: id }
}

async function makeHostJoiner(t, opts = {}) {
  const host = await makePairing(t, opts.host || {})
  const joiner = await makePairing(t, opts.joiner || {})
  return { host, joiner }
}

// ─── construction / lifecycle ──────────────────────────────────────────────

test('construction: network required', async (t) => {
  const id = await Identity.generate()
  t.exception.all(() => new Pairing({ identity: id }), /network/)
})

test('construction: identity required', async (t) => {
  const { net } = await makeNet(t)
  t.exception.all(() => new Pairing({ network: net }), /identity/)
})

test('ready() + close() lifecycle', async (t) => {
  const { net, id } = await makeNet(t)
  const pairing = new Pairing({ network: net, identity: id })
  await pairing.ready()
  t.ok(pairing.opened)
  await pairing.close()
  t.ok(pairing.closed)
})

test('ready() is idempotent', async (t) => {
  const { pairing } = await makePairing(t)
  await pairing.ready()
  await pairing.ready()
  t.pass('ready twice ok')
})

test('close() is idempotent', async (t) => {
  const { pairing } = await makePairing(t)
  await pairing.close()
  await pairing.close()
  t.pass('close twice ok')
})

// ─── invite creation / parsing ─────────────────────────────────────────────

test('createInvite returns z32 string', async (t) => {
  const { pairing } = await makePairing(t)
  const str = await pairing.createInvite({ role: 'member' })
  t.is(typeof str, 'string')
  t.ok(/^[ybndrfg8ejkmcpqxot1uwisza345h769]+$/.test(str))
  t.ok(Pairing.isInvite(str))
})

test('Pairing.isInvite: false for garbage', async (t) => {
  t.absent(Pairing.isInvite('garbage'))
  t.absent(Pairing.isInvite(''))
  t.absent(Pairing.isInvite(null))
  t.absent(Pairing.isInvite(123))
})

test('Invite.parse round-trips and signature verifies', async (t) => {
  const { pairing, identity } = await makePairing(t)
  const str = await pairing.createInvite({ role: 'reader' })
  const parsed = Invite.parse(str)
  t.alike(b4a.toBuffer(parsed.publicKey), b4a.toBuffer(identity.publicKey))
  t.is(parsed.role, 'reader')
  t.ok(parsed.verify())
  t.is(parsed.toString(), str)
})

test('Invite.parse: rejects garbage with INVALID_INVITE', async (t) => {
  try {
    Invite.parse('not z32 !!!')
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.code, 'INVALID_INVITE')
  }
})

test('Invite.parse: tampered signature fails', async (t) => {
  const { pairing } = await makePairing(t)
  const str = await pairing.createInvite({ role: 'member' })
  const buf = z32.decode(str)
  buf[buf.length - 1] ^= 0xff
  const tampered = z32.encode(buf)
  try {
    Invite.parse(tampered)
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.code, 'INVALID_INVITE')
  }
})

test('Invite expiry: past expires → expired true', async (t) => {
  const { pairing } = await makePairing(t)
  const str = await pairing.createInvite({ role: 'member', expiresIn: -1000 })
  const inv = Invite.parse(str)
  t.ok(inv.expired)
})

test('Invite expiry: future or zero → not expired', async (t) => {
  const { pairing } = await makePairing(t)
  const a = await pairing.createInvite({ role: 'member' }) // 0 = no expiry
  const b = await pairing.createInvite({ role: 'member', expiresIn: 3600_000 })
  t.absent(Invite.parse(a).expired)
  t.absent(Invite.parse(b).expired)
})

// ─── encoding options ──────────────────────────────────────────────────────

test('inviteEncoding round-trips invite.data', async (t) => {
  const StringEnc = c.string
  const { pairing } = await makePairing(t, { inviteEncoding: StringEnc })
  const str = await pairing.createInvite({ role: 'member', data: 'hello world' })

  const inv = Invite.parse(str, { encoding: StringEnc })
  t.is(inv._rawData, 'hello world')
})

// ─── handshake: host + joiner ──────────────────────────────────────────────

test('handshake: host confirms, joiner resolves with keys', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)

  const inviteStr = await host.pairing.createInvite({ role: 'member' })

  const roomKey = Identity.randomBytes(32)
  const roomEnc = Identity.randomBytes(32)
  const extra = b4a.from('hello-additional')

  const handled = once(host.pairing, 'candidate', 30000).then(async (c) => {
    t.alike(b4a.toBuffer(c.invite.publicKey), b4a.toBuffer(host.identity.publicKey))
    await c.confirm({ key: roomKey, encryptionKey: roomEnc, additional: extra })
  })

  const result = await joiner.pairing.join(inviteStr, {
    userData: b4a.from('alice'),
    timeout: 30000
  })
  t.alike(b4a.toBuffer(result.key), b4a.toBuffer(roomKey))
  t.alike(b4a.toBuffer(result.encryptionKey), b4a.toBuffer(roomEnc))
  t.alike(b4a.toBuffer(result.additional), b4a.toBuffer(extra))
  await handled
})

test('handshake: candidate.userData decoded with joinerEncoding', async (t) => {
  const Enc = c.string
  const { host, joiner } = await makeHostJoiner(t, {
    host: { joinerEncoding: Enc },
    joiner: { joinerEncoding: Enc }
  })

  const inviteStr = await host.pairing.createInvite({ role: 'member' })
  const roomKey = Identity.randomBytes(32)

  const handled = once(host.pairing, 'candidate', 30000).then(async (c) => {
    t.is(c.userData, 'alice-rocks')
    await c.confirm({ key: roomKey })
  })

  const result = await joiner.pairing.join(inviteStr, { userData: 'alice-rocks', timeout: 30000 })
  t.alike(b4a.toBuffer(result.key), b4a.toBuffer(roomKey))
  await handled
})

test('handshake: host can deny with reason', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const inviteStr = await host.pairing.createInvite({ role: 'member' })

  host.pairing.on('candidate', (c) => {
    c.deny('not-today').catch(() => {})
  })

  try {
    await joiner.pairing.join(inviteStr, { userData: b4a.from('alice'), timeout: 30000 })
    t.fail('should reject')
  } catch (err) {
    t.is(err.code, 'DENIED')
    t.is(err.reason, 'not-today')
  }
})

test('join: userData is required, and a buffer without a joinerEncoding', async (t) => {
  const { pairing } = await makePairing(t)
  const inviteStr = await pairing.createInvite()
  t.is((await pairing.join(inviteStr).catch((e) => e)).code, 'REQUIRED')
  const err = await pairing.join(inviteStr, { userData: { name: 'alice' } }).catch((e) => e)
  t.is(err.code, 'INVALID')
})

test('join: invalid invite → INVALID_INVITE', async (t) => {
  const { joiner } = await makeHostJoiner(t)
  try {
    await joiner.pairing.join('not-an-invite-string', { timeout: 5000 })
    t.fail('should reject')
  } catch (err) {
    t.is(err.code, 'INVALID_INVITE')
  }
})

test('join: expired invite → EXPIRED', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const inviteStr = await host.pairing.createInvite({ role: 'member', expiresIn: -1000 })
  try {
    await joiner.pairing.join(inviteStr, { timeout: 5000 })
    t.fail('should reject')
  } catch (err) {
    t.is(err.code, 'EXPIRED')
  }
})

test('join: timeout when no host running', async (t) => {
  const { joiner } = await makeHostJoiner(t)
  // Mint an invite from an unrelated, never-started host identity.
  const hostId = await Identity.generate()
  // We need a valid invite even though there's no host listening — borrow
  // host.pairing.createInvite logic by constructing a Pairing without ready().
  // Simpler: spin up a temporary host pairing, create an invite, then close host.
  const { net } = await makeNet(t, { identity: hostId })
  const host = new Pairing({ network: net, identity: hostId })
  await host.ready()
  const inviteStr = await host.createInvite({ role: 'member' })
  await host.close()

  try {
    await joiner.pairing.join(inviteStr, { userData: b4a.from('x'), timeout: 1500 })
    t.fail('should time out')
  } catch (err) {
    t.is(err.code, 'TIMEOUT')
  }
})

test('close during in-flight join → CLOSED', async (t) => {
  const { joiner } = await makeHostJoiner(t)
  const hostId = await Identity.generate()
  const { net } = await makeNet(t, { identity: hostId })
  const host = new Pairing({ network: net, identity: hostId })
  await host.ready()
  const inviteStr = await host.createInvite({ role: 'member' })
  await host.close()

  const joinPromise = joiner.pairing.join(inviteStr, { userData: b4a.from('x'), timeout: 30000 })
  // close after a tiny delay to let the join start
  setTimeout(() => {
    joiner.pairing.close().catch(() => {})
  }, 200)
  try {
    await joinPromise
    t.fail('should reject')
  } catch (err) {
    t.is(err.code, 'CLOSED')
  }
})

test('multiple candidates handled sequentially', async (t) => {
  const { host, joiner: j1 } = await makeHostJoiner(t)
  const j2 = await makePairing(t)

  const invite1 = await host.pairing.createInvite({ role: 'member' })
  const invite2 = await host.pairing.createInvite({ role: 'reader' })

  const roomKey = Identity.randomBytes(32)

  let seen = 0
  host.pairing.on('candidate', async (c) => {
    seen++
    await c.confirm({ key: roomKey })
  })

  const r1 = await j1.pairing.join(invite1, { userData: b4a.from('one'), timeout: 30000 })
  const r2 = await j2.pairing.join(invite2, { userData: b4a.from('two'), timeout: 30000 })

  t.alike(b4a.toBuffer(r1.key), b4a.toBuffer(roomKey))
  t.alike(b4a.toBuffer(r2.key), b4a.toBuffer(roomKey))
  t.is(seen, 2)
})

test('additional from c.confirm is delivered to joiner', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const inviteStr = await host.pairing.createInvite({ role: 'member' })
  const additional = b4a.from('opaque-payload')
  const roomKey = Identity.randomBytes(32)

  host.pairing.on('candidate', async (c) => {
    await c.confirm({ key: roomKey, additional })
  })

  const result = await joiner.pairing.join(inviteStr, {
    userData: b4a.from('alice'),
    timeout: 30000
  })
  t.alike(b4a.toBuffer(result.additional), b4a.toBuffer(additional))
})

// ─── error class ───────────────────────────────────────────────────────────

test('revoke: revoked invite is no longer accepted', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const inviteStr = await host.pairing.createInvite({ role: 'member' })

  t.is(host.pairing.revoke(inviteStr), true, 'revoke returned true')
  t.is(host.pairing.revoke(inviteStr), false, 'revoking again returns false')

  // The host's candidate handler should never fire for a revoked invite, so
  // the joiner just times out.
  let candidateFired = false
  host.pairing.on('candidate', () => {
    candidateFired = true
  })

  await t.exception.all(
    joiner.pairing.join(inviteStr, { userData: b4a.from('alice'), timeout: 2000 }),
    /TIMEOUT|timed out/i
  )
  t.absent(candidateFired, 'host never saw a candidate for the revoked invite')
})

// ─── observability: invite state machine ──────────────────────────────────

test('candidate event delivers an object with confirm/deny/userData/invite', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const inviteStr = await host.pairing.createInvite({ role: 'member' })
  const roomKey = Identity.randomBytes(32)

  const captured = new Promise((resolve) => host.pairing.once('candidate', resolve))
  const joining = joiner.pairing.join(inviteStr, { userData: b4a.from('alice'), timeout: 30000 })

  const cand = await captured
  t.is(typeof cand.confirm, 'function', 'candidate.confirm is a function')
  t.is(typeof cand.deny, 'function', 'candidate.deny is a function')
  t.alike(b4a.toBuffer(cand.userData), b4a.toBuffer(b4a.from('alice')))
  t.ok(cand.invite, 'candidate carries the matched invite record')

  await cand.confirm({ key: roomKey })
  await joining
})

test('single-use invite: confirming once consumes it; a second joiner times out', async (t) => {
  const { host, joiner: j1 } = await makeHostJoiner(t)
  const j2 = await makePairing(t)
  const inviteStr = await host.pairing.createInvite({ role: 'member' })
  const roomKey = Identity.randomBytes(32)

  host.pairing.once('candidate', async (c) => {
    await c.confirm({ key: roomKey })
  })

  const first = await j1.pairing.join(inviteStr, { userData: b4a.from('one'), timeout: 30000 })
  t.alike(b4a.toBuffer(first.key), b4a.toBuffer(roomKey))

  // After the first confirm, the host's _invites map has dropped this invite.
  // A second joiner reaches the host's swarm but no Member matches → times out.
  await t.exception.all(
    j2.pairing.join(inviteStr, { userData: b4a.from('two'), timeout: 2000 }),
    /TIMEOUT|timed out/i
  )
})

test('multi-use invite: a second joiner is also admitted', async (t) => {
  const { host, joiner: j1 } = await makeHostJoiner(t)
  const j2 = await makePairing(t)
  const inviteStr = await host.pairing.createInvite({ role: 'member', reuse: true })
  const roomKey = Identity.randomBytes(32)

  host.pairing.on('candidate', async (c) => {
    await c.confirm({ key: roomKey })
  })

  const first = await j1.pairing.join(inviteStr, { userData: b4a.from('one'), timeout: 30000 })
  t.alike(b4a.toBuffer(first.key), b4a.toBuffer(roomKey))

  // reuse keeps the invite alive, so the second joiner is admitted too
  const second = await j2.pairing.join(inviteStr, { userData: b4a.from('two'), timeout: 30000 })
  t.alike(b4a.toBuffer(second.key), b4a.toBuffer(roomKey))
})

test('close during in-flight join cancels the joiner promptly', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const inviteStr = await host.pairing.createInvite({ role: 'member' })
  // Host never confirms — joiner would normally wait `timeout`.
  const pending = joiner.pairing.join(inviteStr, { userData: b4a.from('x'), timeout: 30000 })

  setTimeout(() => joiner.pairing.close().catch(() => {}), 100)
  await t.exception.all(pending, /closed|denied|CLOSED|DENIED/i)
})

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

// ─── suspend / resume ─────────────────────────────────────────────────────

test('suspend()/resume(): flips _blind.suspended', async (t) => {
  const { pairing } = await makePairing(t)
  t.absent(pairing.suspended, 'starts not suspended')
  t.absent(pairing._blind.suspended)

  await pairing.suspend()
  t.ok(pairing.suspended)
  t.ok(pairing._blind.suspended)

  await pairing.resume()
  t.absent(pairing.suspended)
  t.absent(pairing._blind.suspended)
})

test('suspend(): idempotent', async (t) => {
  const { pairing } = await makePairing(t)
  await pairing.suspend()
  await pairing.suspend()
  t.ok(pairing.suspended)
})

test('resume(): no-op when not suspended', async (t) => {
  const { pairing } = await makePairing(t)
  await pairing.resume()
  t.absent(pairing.suspended)
})

test('suspend(): no-op after close', async (t) => {
  const { pairing } = await makePairing(t)
  await pairing.close()
  await pairing.suspend()
  await pairing.resume()
  t.pass('suspend/resume after close did not throw')
})

// ─── B9.4: host-side invite expiry / deny ─────────────────────────────────

test('host drops expired invite: _oncandidate removes it from _invites without emitting candidate', async (t) => {
  const { pairing } = await makePairing(t)

  // Mint an invite that is already expired on the host side.
  const inviteStr = await pairing.createInvite({ role: 'member', expiresIn: -1000 })
  t.is(pairing._invites.size, 1, 'invite registered before candidate arrives')

  // Locate the invite id so we can build a minimal fake req.
  const [[id]] = pairing._invites

  let candidateFired = false
  pairing.on('candidate', () => {
    candidateFired = true
  })

  // Simulate a candidate arriving for this invite.
  await pairing._oncandidate({ inviteId: b4a.from(id, 'hex'), userData: null, open: () => {} })

  t.is(pairing._invites.size, 0, 'expired invite removed from _invites')
  t.absent(candidateFired, 'candidate event not emitted for expired invite')
})

test('host deny: _invites entry removed and joiner receives DENIED', async (t) => {
  const { host, joiner } = await makeHostJoiner(t)
  const inviteStr = await host.pairing.createInvite({ role: 'member' })

  t.is(host.pairing._invites.size, 1, 'invite registered before handshake')

  const candidateHandled = once(host.pairing, 'candidate', 30000).then(async (c) => {
    await c.deny('rejected')
    t.is(host.pairing._invites.size, 0, '_invites cleared after deny (single-use)')
    t.ok(c._settled, 'candidate marked settled after deny')
  })

  try {
    await joiner.pairing.join(inviteStr, { userData: b4a.from('alice'), timeout: 30000 })
    t.fail('joiner should have been denied')
  } catch (err) {
    t.is(err.code, 'DENIED')
    t.is(err.reason, 'rejected')
  }
  await candidateHandled
})

// ─── teardown shared testnet ──────────────────────────────────────────────

test('teardown shared testnet', async (t) => {
  await testnet.destroy()
  t.pass('testnet destroyed')
})

// one BlindPairing per network — per-handle instances each added swarm +
// DHT listeners and a protomux channel per connection (O(rooms) listeners).
test('pairing: handles on one network share a single BlindPairing', async (t) => {
  const { net, id } = await makeNet(t)
  const a = new Pairing({ network: net, identity: id })
  const b = new Pairing({ network: net, identity: await Identity.generate() })
  await a.ready()
  await b.ready()
  t.teardown(() => Promise.all([a.close(), b.close()]).catch(() => {}))

  t.is(a._blind, b._blind, 'same shared instance')

  await a.close()
  t.ok(b._blind && !b.closed, 'closing one pairing leaves the shared instance alive')
  const invite = await b.createInvite({ role: 'member' })
  t.ok(typeof invite === 'string' && invite.length > 0, 'surviving pairing still mints invites')
})
