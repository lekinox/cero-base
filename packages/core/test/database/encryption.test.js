import test from 'brittle'
import b4a from 'b4a'
import Autobee from 'autobee'
import autobeeEncryption from 'autobee/lib/encryption.js'
import crypto from 'hypercore-crypto'
import c from 'compact-encoding'

import { Keyring, EpochAutobee, wraps } from '../../src/database/encryption.js'
import { Database } from '../../src/database/index.js'
import { Identity } from '../../src/identity/index.js'
import { CeroError } from '../../src/lib/errors.js'
import { Network } from '../../src/network/index.js'
import hid from 'hypercore-id-encoding'
import { admission } from '../../src/lib/utils.js'
import {
  makeStore,
  makeTestnet,
  makeMirror,
  randomTopic,
  waitFor,
  waitForMirrored,
  makePeer,
  admit
} from '../helpers/index.js'
import { spec } from '../fixtures/spec/index.js'

const { AutobeeEncryption, WriterEncryption } = autobeeEncryption

// what the patched providers ask of their autobee, as EpochAutobee answers it
function fakeAuto(keyring = new Keyring()) {
  return {
    key: crypto.hash(b4a.from('bootstrap')),
    encryptionKey: crypto.hash(b4a.from('room-key')),
    keyring,
    get keyId() {
      return this.keyring.current
    },
    getEntropy(id) {
      const entropy = this.keyring.entropy(id)
      if (!entropy) throw CeroError.UNKNOWN_EPOCH(id)
      return entropy
    }
  }
}

function fakeCtx() {
  return {
    key: crypto.hash(b4a.from('writer-core')),
    manifest: { version: 2, userData: null }
  }
}

// ─── seam canaries — fail loudly if an autobee upgrade moves our hooks ──────

test('canary: the autobee seams EpochAutobee relies on still exist', (t) => {
  t.is(typeof Autobee.prototype._bumpPendingWriters, 'function', 'drain seam (overridden)')
  t.is(typeof Autobee.prototype._applyWakeupHints, 'function', 'wakeup-hint seam (overridden)')
  t.is(typeof Autobee.prototype.update, 'function', 'update used by the epoch retry')
  t.is(typeof Autobee.prototype.wakeup, 'function', 'wakeup used to revive frozen writers')
  t.ok(EpochAutobee.prototype instanceof Autobee)
})

// our epoch support is a patch on autobee's encryption base class: it only takes effect if autobee
// builds its providers from that same class
test('canary: autobee builds its encryption from the class we patch', (t) => {
  const provider = Autobee.getViewEncryption(b4a.alloc(32), b4a.alloc(32), 'view')
  t.ok(provider instanceof AutobeeEncryption)
})

test('canary: the autobee encryption surface we patch still exists', (t) => {
  const p = WriterEncryption.prototype
  t.is(typeof p.getKeys, 'function', 'getKeys (patched on the base prototype)')
  t.is(typeof p.encrypt, 'function', 'encrypt (patched on the base prototype)')
  t.is(typeof p.blockKey, 'function')
  t.is(typeof p.decrypt, 'function')
  t.is(WriterEncryption.PADDING, 8, 'block padding stays 8 bytes (uint32 key-id at [4,8))')
})

test('canary: every provider construction path is epoch-aware (incl. ActiveWriters)', async (t) => {
  // lib/writers.js news WriterEncryption directly: only the base-prototype patch reaches it
  const auto = fakeAuto()
  auto.keyring.add(1, crypto.hash(b4a.from('canary')))
  const upstream = new WriterEncryption(auto)
  const ctx = fakeCtx()
  t.is((await upstream.getKeys(1, ctx)).id, 1, 'upstream class sees epochs')
  const block = b4a.alloc(WriterEncryption.PADDING + 4)
  await upstream.encrypt(0, block, 0, ctx)
  t.is(block[4], 1, 'and writes under the current one')
})

test('canary: epoch derivation matches the golden vector (independent of shared code)', async (t) => {
  // any drift in the namespace constants, hash-key derivation, or blockKey
  // inputs breaks every epoch>0 block — this pins the exact bytes
  const auto = fakeAuto()
  auto.keyring.add(1, crypto.hash(b4a.from('epoch-1-secret')), 1)
  const keys = await new WriterEncryption(auto).getKeys(1, fakeCtx())
  t.is(
    b4a.toHex(keys.block),
    '4d309cddcdb9be0044267b0957b5cb1bbbb9fb241f55ee52d6bf4398205f9448',
    'block key'
  )
  t.is(
    b4a.toHex(keys.hash),
    'de72c857c3fc024e858e07d0ff3d13b0490d487b436c3e7b80bbb53f41afd957',
    'hash key'
  )
})

test('canary: upstream drain body is unchanged (our catch wraps it)', (t) => {
  const src = Autobee.prototype._bumpPendingWriters.toString()
  t.is(
    b4a.toString(crypto.hash(b4a.from(src)), 'hex'),
    // takes { local }, which the wrapper must forward untouched
    '84b0d4fa0e1ad1a748fe3f616c4cd6a9b59ba315a377e18d6a13a3fbee8a7a1b',
    'autobee._bumpPendingWriters changed upstream — re-check the EpochAutobee wrapper'
  )
})

// ─── epoch 0 byte-compat ────────────────────────────────────────────────────

test('epoch 0 keeps the base keys, whatever the keyring holds', async (t) => {
  const ctx = fakeCtx()
  const base = await new WriterEncryption(fakeAuto()).getKeys(0, ctx)
  const auto = fakeAuto()
  auto.keyring.add(1, crypto.hash(b4a.from('e1')), 1)
  const rotated = await new WriterEncryption(auto).getKeys(0, ctx)

  t.alike(rotated.block, base.block, 'block key identical')
  t.alike(rotated.hash, base.hash, 'hash key identical')
  t.is(rotated.id, 0)
})

// ─── epoch separation ───────────────────────────────────────────────────────

test('epoch keys: distinct per epoch, deterministic across peers, unknown throws', async (t) => {
  const entropy = crypto.hash(b4a.from('epoch-1-secret'))
  const ctx = fakeCtx()

  const a = new WriterEncryption(fakeAuto())
  a.auto.keyring.add(1, entropy)
  const k0 = await a.getKeys(0, ctx)
  const k1 = await a.getKeys(1, ctx)
  t.unlike(k1.block, k0.block, 'epoch 1 key differs from base era')

  const b = new WriterEncryption(fakeAuto())
  b.auto.keyring.add(1, entropy)
  t.alike(await b.getKeys(1, ctx), k1, 'same entropy → same keys on another peer')

  await t.exception(a.getKeys(2, ctx), /unknown encryption epoch/, 'missing entropy is an error')
})

test('writes follow the latest keyring epoch', async (t) => {
  const provider = new WriterEncryption(fakeAuto())
  const ctx = fakeCtx()
  const stamped = async () => {
    const block = b4a.alloc(WriterEncryption.PADDING + 4)
    await provider.encrypt(0, block, 0, ctx)
    return block[4]
  }

  t.is(await stamped(), 0, 'starts on the base era')
  provider.auto.keyring.add(1, crypto.hash(b4a.from('e1')))
  t.is(await stamped(), 1, 'advances when the keyring does')
})

// ─── the security property, at the crypto layer ─────────────────────────────

test('a peer without the epoch entropy cannot decrypt post-rotation blocks', async (t) => {
  const auto = fakeAuto()
  const ctx = fakeCtx()
  const entropy = crypto.hash(b4a.from('rotation-secret'))
  const text = 'seen only by remaining members'

  const writer = new WriterEncryption(auto)
  writer.auto.keyring.add(1, entropy)

  const block = b4a.alloc(WriterEncryption.PADDING + text.length)
  block.set(b4a.from(text), WriterEncryption.PADDING)
  await writer.encrypt(0, block, 0, ctx)
  t.is(block[4] | (block[5] << 8), 1, 'block is stamped with epoch id 1')

  const survivor = new WriterEncryption({ ...auto, keyring: new Keyring() })
  survivor.auto.keyring.add(1, entropy)
  const copy = b4a.from(block)
  await survivor.decrypt(0, copy, ctx)
  t.is(b4a.toString(copy.subarray(WriterEncryption.PADDING)), text, 'entropy holder decrypts')

  const removed = new WriterEncryption({ ...auto, keyring: new Keyring() })
  await t.exception(
    removed.decrypt(0, b4a.from(block), ctx),
    /unknown encryption epoch/,
    'base key alone no longer decrypts'
  )
})

test('pre-rotation blocks stay readable after the keyring advances', async (t) => {
  const auto = fakeAuto()
  const ctx = fakeCtx()
  const text = 'written before any rotation'

  const writer = new WriterEncryption(auto)
  const block = b4a.alloc(WriterEncryption.PADDING + text.length)
  block.set(b4a.from(text), WriterEncryption.PADDING)
  await writer.encrypt(0, block, 0, ctx)

  const later = new WriterEncryption({ ...auto, keyring: new Keyring() })
  later.auto.keyring.add(1, crypto.hash(b4a.from('e1')))
  await later.decrypt(0, block, ctx)
  t.is(b4a.toString(block.subarray(WriterEncryption.PADDING)), text, 'epoch 0 history intact')
})

// ─── keyring ────────────────────────────────────────────────────────────────

test('keyring validates stamps and entropy, orders by sequence', (t) => {
  const ring = new Keyring()
  t.exception(() => ring.add(0, b4a.alloc(32)), /epoch stamp/)
  t.exception(() => ring.add(1, b4a.alloc(16)), /32 bytes/)
  ring.add(900, b4a.alloc(32, 2), 2)
  ring.add(700, b4a.alloc(32, 1), 1)
  t.is(ring.current, 900, 'current follows the highest sequence, not the stamp value')
  t.is(ring.seq, 2)
  t.alike(ring.entropy(700), b4a.alloc(32, 1))
  t.is(ring.entropy(3), null)
  ring.remove(900)
  t.is(ring.current, 700, 'remove recomputes current from remaining sequences')
  t.is(ring.seq, 1)
  t.is(ring.entropy(900), null)
})

// ─── rotation end-to-end (two-peer testnet) ────────────────────────────────

test.configure({ timeout: 120000 })

// Owner room + admitted members: A bootstraps as owner, then admits each
// peer's identity + writer (the same tx handle.accept performs).
async function makeRoom(t, memberRoles = []) {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const encryptionKey = Identity.randomBytes(32)

  const a = await makePeer(t, testnet, { topic, encryptionKey })
  await a.db.bootstrap({ name: 'owner' })

  const members = []
  for (const role of memberRoles) {
    const m = await makePeer(t, testnet, { topic, encryptionKey, key: a.db.key })
    await admit(a.db, m.db, role)
    members.push(m)
  }
  return { a, members, testnet, topic, encryptionKey }
}

const texts = async (db) => (await db.get('messages')).data.map((r) => r.text).sort()

test('rotate: a removed member cannot decrypt anything written after the rotation', async (t) => {
  const {
    a,
    members: [b, removed]
  } = await makeRoom(t, ['member', 'member'])

  await a.db.put('messages', { text: 'before' })
  await waitFor(async () => (await texts(b.db)).includes('before'))
  await waitFor(async () => (await texts(removed.db)).includes('before'))

  await a.db.call('del-member', { id: removed.identity.id })
  const { epoch } = await a.db.rotate()
  t.is(epoch, 1, 'first rotation opens epoch 1')

  await a.db.put('messages', { text: 'after' })

  await waitFor(async () => (await texts(b.db)).includes('after'))
  t.alike(await texts(b.db), ['after', 'before'], 'remaining member reads everything')
  t.is(b.db.keyring.seq, 1, 'remaining member learned the epoch from its envelope')

  t.alike(await texts(removed.db), ['before'], 'removed member is frozen at the cut')
  t.is(removed.db.keyring.seq, 0, 'removed member never learns the new epoch')
  // the unreadable epoch parks the writer quietly — no crash, no data
  t.absent(
    removed.errors.find((e) => e.code !== 'UNKNOWN_EPOCH'),
    'no unexpected errors on the removed member'
  )
})

test('rotate: an offline member catches up across multiple missed epochs', async (t) => {
  const {
    a,
    members: [b],
    encryptionKey
  } = await makeRoom(t, ['member'])

  await a.db.put('messages', { text: 'e0' })
  await waitFor(async () => (await texts(b.db)).includes('e0'))
  await b.db.close()

  await a.db.rotate()
  await a.db.put('messages', { text: 'e1' })
  await a.db.rotate()
  await a.db.put('messages', { text: 'e2' })
  t.is(a.db.keyring.seq, 2)

  // the member returns: same store + identity, walks the chain forward by
  // opening each announcement's envelope in log order
  const back = new Database({
    store: b.store,
    identity: b.identity,
    network: b.network,
    spec,
    key: a.db.key,
    encryptionKey
  })
  await back.ready()
  t.teardown(() => back.close().catch(() => {}), { order: 4 })

  await waitFor(async () => (await texts(back)).length === 3)
  t.alike(await texts(back), ['e0', 'e1', 'e2'], 'every era readable after catching up')
  t.is(back.keyring.seq, 2, 'chain walked to the newest epoch')
})

test('rotate: keyring survives a reopen via local userData', async (t) => {
  const { a } = await makeRoom(t, [])
  await a.db.put('messages', { text: 'one' })
  await a.db.rotate()
  await a.db.put('messages', { text: 'two' })
  await a.db.rotate()
  await a.db.put('messages', { text: 'three' })

  const known = a.db.keyring.all()
  const keyPair = a.db.keyPair // the swapped device writer — same local core on reopen
  await a.db.close()

  const again = new Database({
    store: a.db.store,
    identity: a.identity,
    spec,
    key: a.db.key,
    keyPair,
    encryptionKey: a.db.encryptionKey
  })
  await again.ready()
  t.teardown(() => again.close().catch(() => {}), { order: 4 })

  t.is(again.keyring.seq, 2, 'keyring primed from userData on boot')
  t.alike(again.keyring.all(), known, 'stamps, sequences and entropies persisted intact')
  t.alike(await texts(again), ['one', 'three', 'two'], 'all epochs readable after reopen')
})

test('rotate: a member without the remove permission cannot rotate', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(async () => b.db.writable)
  await waitFor(
    async () => (await b.db.get('members')).data.length === 2,
    'member sees both member rows'
  )

  await t.exception(b.db.rotate(), /remove permission/, 'plain member is rejected')
  t.is(a.db.keyring.seq, 0, 'no epoch was opened')
})

test('rotate: concurrent rotations from two admins converge, both readable', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['admin'])
  await waitFor(async () => b.db.writable)
  await waitFor(async () => (await b.db.get('members')).data.length === 2)

  await Promise.all([a.db.rotate(), b.db.rotate()])

  await waitFor(async () => a.db.keyring.seq === 2 && b.db.keyring.seq === 2)
  t.is(a.db.keyring.seq, 2, 'both rotations linearized as consecutive epochs')
  t.is(a.db.keyring.current, b.db.keyring.current, 'peers agree on the current stamp')
  t.alike(
    a.db.keyring.entropy(a.db.keyring.current),
    b.db.keyring.entropy(b.db.keyring.current),
    'peers agree on the latest secret'
  )

  await a.db.put('messages', { text: 'post' })
  await waitFor(async () => (await texts(b.db)).includes('post'))
  t.pass('writes after concurrent rotations replicate and decrypt')
})

test('rotate: a post-rotation joiner reads full history from delivered epochs', async (t) => {
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])
  await a.db.put('messages', { text: 'history' })
  await a.db.rotate()
  await a.db.put('messages', { text: 'current' })

  // simulate the pairing-confirm delivery: latest keys handed over at join
  const joiner = await makePeer(t, testnet, {
    topic,
    encryptionKey,
    key: a.db.key,
    epochs: a.db.keyring.all()
  })
  await waitFor(async () => (await texts(joiner.db)).length === 2)
  t.alike(await texts(joiner.db), ['current', 'history'], 'joiner reads both eras')
})

// ─── production scenarios: recovery, devices, roles, mirrors, stress ───────

test('rotate: seed-phrase recovery re-derives everything — reads, claims, writes', async (t) => {
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])
  await a.db.put('messages', { text: 'pre' })
  await a.db.rotate()
  await a.db.put('messages', { text: 'mid' })
  await a.db.rotate()
  await a.db.put('messages', { text: 'post' })

  // a fresh device with nothing but the seed: identity re-derived, own device
  // writer (as the cero layer always mints), no userData, no delivered
  // epochs — the log replay alone must hydrate keys
  const recoveredId = await Identity.create({ seed: a.identity.seed })
  const rec = await makePeer(t, testnet, {
    topic,
    identity: recoveredId,
    keyPair: Identity.randomKeyPair(),
    encryptionKey,
    key: a.db.key
  })
  await waitFor(async () => (await texts(rec.db)).length === 3)
  t.alike(await texts(rec.db), ['mid', 'post', 'pre'], 'full history from the log alone')
  t.is(rec.db.keyring.seq, 2, 'both epochs recovered via envelopes in the log')

  // once admitted, the recovered device writes at the current epoch and the
  // original device decrypts it
  const sig = a.identity.sign(admission(a.db.key, rec.db.writerKey, a.db.writerKey))
  await a.db.call('add-writer', {
    master: a.identity.publicKey,
    writer: rec.db.writerKey,
    sig,
    ts: Date.now()
  })
  await waitFor(async () => rec.db.writable)
  await rec.db.put('messages', { text: 'recovered' })
  await waitFor(async () => (await texts(a.db)).includes('recovered'))
  t.pass('recovered device writes, original device decrypts at the latest epoch')
})

test('rotate: reader-role member (no writer) follows rotations on every device', async (t) => {
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])
  const readerId = await Identity.create()
  const phone = await makePeer(t, testnet, {
    topic,
    identity: readerId,
    encryptionKey,
    key: a.db.key
  })
  await admit(a.db, phone.db, 'reader')
  await a.db.put('messages', { text: 'pre' })
  await waitFor(async () => (await texts(phone.db)).includes('pre'))

  await a.db.rotate()
  await a.db.put('messages', { text: 'post' })
  await waitFor(async () => (await texts(phone.db)).includes('post'))
  t.is(phone.db.keyring.seq, 1, 'reader unsealed its envelope without being a writer')

  // second device, same reader identity, joining after the rotation
  const laptop = await makePeer(t, testnet, {
    topic,
    identity: await Identity.create({ seed: readerId.seed }),
    encryptionKey,
    key: a.db.key
  })
  await waitFor(async () => (await texts(laptop.db)).length === 2)
  t.is(laptop.db.keyring.seq, 1, 'every device of the member is covered by one envelope')
})

test('rotate: a member syncs a rotated room through a blind mirror, writer offline', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const topic = randomTopic()
  const encryptionKey = Identity.randomBytes(32)

  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const aId = await Identity.create()
  const aNet = new Network({ bootstrap: testnet.bootstrap, store, mirrors: [mirror] })
  await aNet.ready()
  const aDisc = aNet.join(topic)
  await aDisc.flush()
  const a = new Database({ store, identity: aId, network: aNet, spec, encryptionKey })
  await a.ready()
  t.teardown(
    async () => {
      await a.close().catch(() => {})
      await aNet.close().catch(() => {})
    },
    { order: 5 }
  )
  await a.bootstrap({ name: 'a' })
  // B joins from another device while A is online, so the rotation seals to it; its join is on
  // the mirror, where A's later nodes link it
  const bId = await Identity.create()
  const opts = { topic, identity: bId, encryptionKey, key: a.key, mirrors: [mirror] }
  const first = await makePeer(t, testnet, opts)
  await admit(a, first.db, 'reader')
  await waitForMirrored(first.db)
  await first.db.close()
  await a.put('messages', { text: 'pre' })
  await a.rotate()
  await a.put('messages', { text: 'post' })
  await waitForMirrored(a)
  const aKey = a.key
  await a.close()
  await aNet.close().catch(() => {})

  // B has only the mirror — ciphertext relay — as a path to the data
  const b = await makePeer(t, testnet, {
    topic,
    identity: bId,
    encryptionKey,
    key: aKey,
    mirrors: [mirror]
  })
  await waitFor(async () => {
    await b.db.bee.update()
    return (await texts(b.db)).length === 2
  })
  t.alike(await texts(b.db), ['post', 'pre'], 'rotated data flows through the mirror')
  t.is(b.db.keyring.seq, 1, 'epoch learned from the mirrored announcement')
})

test('rotate: ten consecutive rotations stay consistent for members and joiners', async (t) => {
  const {
    a,
    members: [b],
    testnet,
    topic,
    encryptionKey
  } = await makeRoom(t, ['member'])

  await a.db.put('messages', { text: 'r0' })
  for (let i = 1; i <= 10; i++) {
    await a.db.rotate()
    await a.db.put('messages', { text: `r${i}` })
  }
  t.is(a.db.keyring.seq, 10)

  await waitFor(async () => (await texts(b.db)).length === 11)
  t.is(b.db.keyring.seq, 10, 'member walked all ten epochs')

  const joiner = await makePeer(t, testnet, {
    topic,
    encryptionKey,
    key: a.db.key,
    epochs: a.db.keyring.all()
  })
  await waitFor(async () => (await texts(joiner.db)).length === 11)

  // zero data loss: every peer holds the identical row set across all epochs
  const expected = await texts(a.db)
  t.is(expected.length, 11, 'writer kept every row')
  t.alike(await texts(b.db), expected, 'member row set identical to the writer')
  t.alike(await texts(joiner.db), expected, 'joiner row set identical to the writer')
})

test('rotate: an envelope failing its commitment is rejected, not adopted', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(async () => (await a.db.get('members')).data.length === 2)

  // a malicious/buggy rotator: envelopes carry one secret, the commitment
  // another — every honest member must refuse the epoch
  const sealed = Identity.randomBytes(32)
  const wrapped = [
    { id: a.identity.id, box: Identity.seal(a.identity.publicKey, sealed) },
    { id: b.identity.id, box: Identity.seal(b.identity.publicKey, sealed) }
  ]
  await a.db.call('rotate-key', {
    epoch: 0,
    stamp: 12345,
    wrapped: c.encode(wraps, wrapped),
    createdAt: Date.now(),
    commit: crypto.hash(Identity.randomBytes(32)) // does not match `sealed`
  })
  await a.db.bee.update()

  await waitFor(async () => b.errors.some((e) => /commitment/.test(e.message)))
  t.is(a.db.keyring.seq, 0, 'rotator side never adopts the epoch')
  t.is(b.db.keyring.seq, 0, 'member refuses an envelope that fails the commitment')
})

test('rotate: an admin sealing the owner out is healed', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['admin'])
  await waitFor(async () => b.db.writable)
  await waitFor(async () => (await b.db.get('members')).data.length === 2)

  // every envelope fails the commitment, the admin's own too: one it could open would switch it
  // to the epoch at apply, before its announcement flushed, and nobody could read that block
  const commit = crypto.hash(Identity.randomBytes(32))
  const wrapped = [a, b].map(({ identity }) => ({
    id: identity.id,
    box: Identity.seal(identity.publicKey, Identity.randomBytes(32))
  }))
  await b.db.call('rotate-key', {
    epoch: 0,
    stamp: 12345,
    wrapped: c.encode(wraps, wrapped),
    createdAt: Date.now(),
    commit
  })

  await waitFor(() => a.db.keyring.seq >= 2 && a.db.keyring.seq === b.db.keyring.seq, {
    timeout: 30000
  })
  await a.db.put('messages', { text: 'after' })
  await waitFor(async () => (await texts(b.db)).includes('after'))
  t.pass('the room re-keyed past the epoch nobody could open, and both read the new one')
})

test('wakeup hints: UNKNOWN_EPOCH parks and retries instead of closing the bee', async (t) => {
  const { a } = await makeRoom(t, [])
  const bee = a.db.bee

  // simulate upstream surfacing UNKNOWN_EPOCH from the wakeup-hint read —
  // patched on Autobee.prototype so it sits under EpochAutobee's override
  const orig = Autobee.prototype._applyWakeupHints
  Autobee.prototype._applyWakeupHints = async function () {
    const err = new Error('unknown epoch')
    err.code = 'UNKNOWN_EPOCH'
    throw err
  }
  t.teardown(() => {
    Autobee.prototype._applyWakeupHints = orig
  })

  // upstream's real call site — one line OUTSIDE its guarded drain path
  await bee._flushWakeup()

  t.ok(!bee.closing && !bee.closed, 'bee survived the epoch-blind hint')
  t.ok(bee._epochRetry, 'epoch retry scheduled — parked, not dead')
})

test('epoch retry: a writer frozen over an unknown epoch recovers when the key arrives', async (t) => {
  const { a, members } = await makeRoom(t, ['member'])
  const [b] = members
  await a.db.put('messages', { text: 'before' })
  await waitFor(async () => (await texts(b.db)).includes('before'))

  // hold b's epoch announcements — the rotation applies but b never learns
  // the key, so a's post-rotation block freezes a's writer on b
  const held = []
  const orig = b.db.rotation.learn.bind(b.db.rotation)
  b.db.rotation.learn = async (row) => {
    held.push(row)
  }

  await a.db.rotate()
  await a.db.put('messages', { text: 'after' })
  await waitFor(() => b.db.bee._epochStalled.size > 0)

  // the key arrives late (the held announcement) — the scheduled retry must
  // wake the frozen writer; a bare update() would strand it forever
  b.db.rotation.learn = orig
  for (const row of held) await orig(row)
  await waitFor(async () => (await texts(b.db)).includes('after'))
  t.pass('frozen writer recovered via the wakeup retry')
})

test('epochs reload: a primed keyring skips re-processing known rotations', async (t) => {
  const { a } = await makeRoom(t, [])
  await a.db.rotate()
  await a.db.rotate()

  const { version } = a.db.keyring
  await a.db.rotation.hydrate()
  t.is(a.db.keyring.version, version, 'known epochs are skipped, the keyring untouched')
})

test('rotate: no tx batching; concurrent rotations run one after the other', async (t) => {
  const { a } = await makeRoom(t, [])
  await t.exception(
    a.db.tx((tx) => tx.rotate()),
    /inside tx/,
    'rotation cannot be batched'
  )
  const [first, second] = await Promise.all([a.db.rotate(), a.db.rotate()])
  t.is(first.epoch, 1)
  t.is(second.epoch, 2, 'the second waited its turn')
})

// ─── divergent concurrent rotations (the review scenario) ──────────────────

test('rotate: divergent offline removals converge — no data loss, both targets revoked', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const encryptionKey = Identity.randomBytes(32)

  // A owner, B admin (writable), C and D plain members
  const a = await makePeer(t, testnet, { topic, encryptionKey })
  await a.db.bootstrap({ name: 'a' })
  const b = await makePeer(t, testnet, { topic, encryptionKey, key: a.db.key })
  const cPeer = await makePeer(t, testnet, { topic, encryptionKey, key: a.db.key })
  const dPeer = await makePeer(t, testnet, { topic, encryptionKey, key: a.db.key })
  await admit(a.db, b.db, 'admin')
  await admit(a.db, cPeer.db, 'member')
  await admit(a.db, dPeer.db, 'member')

  await a.db.put('messages', { text: 'pre' })
  await waitFor(async () => b.db.writable && (await texts(b.db)).includes('pre'))
  await waitFor(async () => (await texts(cPeer.db)).includes('pre'))
  await waitFor(async () => (await texts(dPeer.db)).includes('pre'))

  // B drops offline (same store, no network) and, unaware of anything A does,
  // removes D and rotates
  const bKeyPair = b.db.keyPair
  await b.db.close()
  await b.network.close().catch(() => {})
  const bOff = new Database({
    store: b.store,
    identity: b.identity,
    spec,
    key: a.db.key,
    keyPair: bKeyPair,
    encryptionKey
  })
  await bOff.ready()
  await bOff.call('del-member', { id: dPeer.identity.id })
  await bOff.rotate()
  await bOff.put('messages', { text: 'b-post' })
  await bOff.close()

  // meanwhile A, online, removes C and rotates
  await a.db.call('del-member', { id: cPeer.identity.id })
  await a.db.rotate()
  await a.db.put('messages', { text: 'a-post' })

  // B comes back online — the partitions merge and the healer converges them
  const bNet = new Network({ bootstrap: testnet.bootstrap, store: b.store })
  await bNet.ready()
  const bDisc = bNet.join(topic)
  await bDisc.flush()
  const bBack = new Database({
    store: b.store,
    identity: b.identity,
    network: bNet,
    spec,
    key: a.db.key,
    keyPair: bKeyPair,
    encryptionKey
  })
  await bBack.ready()
  t.teardown(
    async () => {
      await bBack.close().catch(() => {})
      await bDisc.destroy().catch(() => {})
      await bNet.close().catch(() => {})
    },
    { order: 4 }
  )

  // no data loss: both admins read both divergent tails (content-addressed
  // stamps mean linearization can never orphan already-written blocks)
  await waitFor(async () => {
    const at = await texts(a.db)
    const bt = await texts(bBack)
    return at.includes('b-post') && bt.includes('a-post')
  })
  t.alike(await texts(a.db), ['a-post', 'b-post', 'pre'], 'A reads every tail')
  t.alike(await texts(bBack), ['a-post', 'b-post', 'pre'], 'B reads every tail')

  // convergence: the healer rotates until the current epoch's recipients
  // equal canonical membership {A, B}
  const cleanCurrent = async (db) => {
    const rows = await db.view.find('@cero/epochs', {}).toArray()
    if (!rows.length) return false
    const top = rows.reduce((x, y) => (y.epoch > x.epoch ? y : x))
    if (db.keyring.current !== top.stamp || !db.keyring.entropy(top.stamp)) return false
    const recipients = c.decode(wraps, top.wrapped).map((w) => w.id)
    const expect = [a.identity.id, b.identity.id].sort()
    return (
      recipients.length === 2 &&
      recipients
        .slice()
        .sort()
        .every((v, i) => v === expect[i])
    )
  }
  await waitFor(async () => (await cleanCurrent(a.db)) && (await cleanCurrent(bBack)), {
    timeout: 60000
  })
  t.pass('healed: current epoch is sealed to exactly the surviving members')

  // both removed members are cut off from anything written after convergence
  await a.db.put('messages', { text: 'final' })
  await waitFor(async () => (await texts(bBack)).includes('final'))
  await new Promise((r) => setTimeout(r, 1500))
  t.absent((await texts(cPeer.db)).includes('final'), 'C (removed by A) cannot read post-heal data')
  t.absent((await texts(dPeer.db)).includes('final'), 'D (removed by B) cannot read post-heal data')
})

test('rotate: soft delete in a rotated room auto-rotates (healer)', async (t) => {
  const {
    a,
    members: [victim]
  } = await makeRoom(t, ['member'])
  await a.db.put('messages', { text: 'pre' })
  await a.db.rotate() // activates rotation policy for the room
  await waitFor(async () => victim.db.keyring.seq === 1)

  // remove WITHOUT rotating — the healer must re-key on its own
  await a.db.call('del-member', { id: victim.identity.id })
  await waitFor(async () => a.db.keyring.seq >= 2, { timeout: 30000 })

  await a.db.put('messages', { text: 'post' })
  await new Promise((r) => setTimeout(r, 1500))
  t.absent((await texts(victim.db)).includes('post'), 'victim cannot read past the healed epoch')
})

test('rotate: a member leaving on its own is re-keyed out', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(() => b.db.writable)

  await b.db.del('members', b.identity.id)
  await waitFor(async () => !(await a.db.get('members', b.identity.id)).data)
  await waitFor(() => a.db.keyring.seq === 1, { timeout: 30000 })
  const [epoch] = await a.db.view.find('@cero/epochs', {}).toArray()
  const sealed = c.decode(wraps, epoch.wrapped).map((w) => w.id)
  t.alike(sealed, [a.identity.id], 'the owner re-keyed to who stayed')
})

test('rotate: a stamp collision is rejected deterministically', async (t) => {
  const { a } = await makeRoom(t, [])
  const { epoch } = await a.db.rotate()
  t.is(epoch, 1)
  const rows = await a.db.view.find('@cero/epochs', {}).toArray()
  const taken = rows[0].stamp

  const entropy = Identity.randomBytes(32)
  await a.db.call('rotate-key', {
    epoch: 0,
    stamp: taken, // collides with the existing epoch's stamp
    wrapped: c.encode(wraps, [
      { id: a.identity.id, box: Identity.seal(a.identity.publicKey, entropy) }
    ]),
    createdAt: Date.now(),
    commit: crypto.hash(entropy)
  })
  await a.db.bee.update()

  const after = await a.db.view.find('@cero/epochs', {}).toArray()
  t.is(after.length, 1, 'colliding announcement was ignored')
  t.is(a.db.keyring.seq, 1, 'keyring unchanged')
})

test('rotate: device-level removal does NOT revoke reads — identity envelopes reach all devices', async (t) => {
  // Pins a documented limitation: epoch envelopes are sealed to the member's
  // IDENTITY key, which every device of that member holds. del-device revokes
  // write access only; a removed (e.g. stolen) device still unseals future
  // epochs. Cutting a device off requires excluding its identity entirely.
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])

  const memberId = await Identity.create()
  const dev1 = await makePeer(t, testnet, {
    topic,
    identity: memberId,
    keyPair: Identity.randomKeyPair(),
    encryptionKey,
    key: a.db.key
  })
  const dev2 = await makePeer(t, testnet, {
    topic,
    identity: memberId,
    keyPair: Identity.randomKeyPair(),
    encryptionKey,
    key: a.db.key
  })
  await admit(a.db, dev1.db, 'member')
  await admit(a.db, dev2.db, 'member')

  await a.db.put('messages', { text: 'pre' })
  await waitFor(async () => (await texts(dev1.db)).includes('pre'))
  await waitFor(async () => (await texts(dev2.db)).includes('pre'))

  // "lost phone": remove device 2, then rotate
  await a.db.call('del-device', { id: hid.encode(dev2.db.writerKey) })
  await a.db.rotate()
  await a.db.put('messages', { text: 'post' })

  await waitFor(async () => (await texts(dev1.db)).includes('post'))
  t.is(dev1.db.keyring.seq, 1, 'surviving device follows the rotation')

  await waitFor(async () => (await texts(dev2.db)).includes('post'))
  t.is(
    dev2.db.keyring.seq,
    1,
    'REMOVED device still unseals the epoch — identity envelopes cannot exclude one device'
  )
})
