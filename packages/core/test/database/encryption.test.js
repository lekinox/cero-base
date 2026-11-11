import test from 'brittle'
import b4a from 'b4a'
import Autobee from 'autobee'
import autobeeEncryption from 'autobee/lib/encryption.js'
import crypto from 'hypercore-crypto'
import c from 'compact-encoding'

import { Keyring, EpochAutobee, wraps, seal } from '../../src/database/encryption.js'
import { wrap } from '../../src/database/envelope.js'
import { Database } from '../../src/database/index.js'
import { Identity } from '../../src/identity/index.js'
import { CeroError } from '../../src/lib/errors.js'
import { Network } from '../../src/network/index.js'
import { Mailbox } from '../../src/mailbox/index.js'
import { Pairing } from '../../src/pairing/index.js'
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
  auto.keyring.current = 1
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

test("writes follow the keyring's current epoch", async (t) => {
  const provider = new WriterEncryption(fakeAuto())
  const ctx = fakeCtx()
  const stamped = async () => {
    const block = b4a.alloc(WriterEncryption.PADDING + 4)
    await provider.encrypt(0, block, 0, ctx)
    return block[4]
  }

  t.is(await stamped(), 0, 'starts on the base era')
  provider.auto.keyring.add(1, crypto.hash(b4a.from('e1')))
  t.is(await stamped(), 0, 'holding a secret is not writing under it')
  provider.auto.keyring.current = 1
  t.is(await stamped(), 1, 'advances when the current epoch does')
})

// ─── the security property, at the crypto layer ─────────────────────────────

test('a peer without the epoch entropy cannot decrypt post-rotation blocks', async (t) => {
  const auto = fakeAuto()
  const ctx = fakeCtx()
  const entropy = crypto.hash(b4a.from('rotation-secret'))
  const text = 'seen only by remaining members'

  const writer = new WriterEncryption(auto)
  writer.auto.keyring.add(1, entropy)
  writer.auto.keyring.current = 1

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

test('keyring validates stamps and entropy, lists by sequence, never picks the write epoch', (t) => {
  const ring = new Keyring()
  t.exception(() => ring.add(0, b4a.alloc(32)), /epoch stamp/)
  t.exception(() => ring.add(1, b4a.alloc(16)), /32 bytes/)
  ring.add(900, b4a.alloc(32, 2), 2)
  ring.add(700, b4a.alloc(32, 1), 1)
  t.alike(
    ring.all().map((e) => e.stamp),
    [700, 900],
    'ordered by sequence, not the stamp value'
  )
  t.is(ring.current, 0, 'the write epoch is picked from the rows, not by adding')
  t.alike(ring.entropy(700), b4a.alloc(32, 1))
  t.is(ring.entropy(3), null)
  ring.remove(900)
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
  // the removal carries its rotation: a rotation of ours would open a second epoch
  t.is(a.db.keyring.seq, 1, 'the removal opened epoch 1')

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
  const keyPair = b.db.keyPair
  await b.db.close()

  await a.db.rotate()
  await a.db.put('messages', { text: 'e1' })
  await a.db.rotate()
  await a.db.put('messages', { text: 'e2' })
  t.is(a.db.keyring.seq, 2)

  // the member returns: same store, identity and writer, walks the chain forward by
  // opening each announcement's envelope in log order
  const back = new Database({
    store: b.store,
    identity: b.identity,
    network: b.network,
    spec,
    key: a.db.key,
    keyPair,
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

  // reopened as an app reopens a room: the delivered epochs are not handed over again
  const { store, identity, db } = joiner
  await db.close()
  const again = new Database({
    store,
    identity,
    spec,
    key: db.key,
    keyPair: db.keyPair,
    encryptionKey
  })
  await again.ready()
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  t.alike(again.keyring.all(), a.db.keyring.all(), 'the delivered epochs were kept')
  t.alike(await texts(again), ['current', 'history'], 'both eras still readable')
})

// ─── production scenarios: recovery, devices, roles, mirrors, stress ───────

test('rotate: a recovered device reads with the epochs its root hands it, then is sealed to', async (t) => {
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])
  await a.db.put('messages', { text: 'pre' })
  await a.db.rotate()
  await a.db.put('messages', { text: 'mid' })
  await a.db.rotate()
  await a.db.put('messages', { text: 'post' })

  // a fresh device with nothing but the seed: the identity re-derived under a new device key,
  // which no envelope in the log is sealed to
  const recoveredId = await Identity.create({ seed: a.identity.seed })
  const blind = await makePeer(t, testnet, {
    topic,
    identity: recoveredId,
    encryptionKey,
    key: a.db.key
  })
  await waitFor(async () => (await texts(blind.db)).includes('pre'))
  await new Promise((r) => setTimeout(r, 1000))
  t.alike(await texts(blind.db), ['pre'], 'the log alone yields the base era only')
  t.is(blind.db.keyring.seq, 0, 'no envelope opens for a device nobody sealed to')
  // an epoch is learned once its announcement applied here and the secret meets its commitment:
  // the second's announcement sits under the first epoch, unreadable until that one is known
  const [first, second] = a.db.keyring.all()
  await blind.db.learn([first, second].map((e) => ({ ...e, entropy: Identity.randomBytes(32) })))
  t.is(blind.db.keyring.seq, 0, 'wrong secrets are refused against the announcement')
  await blind.db.learn(a.db.keyring.all())
  t.ok(blind.db.keyring.entropy(first.stamp), 'the announced one is kept')
  t.is(blind.db.keyring.entropy(second.stamp), null, 'the other waits for its announcement')
  await waitFor(async () => (await texts(blind.db)).includes('mid'))
  await blind.db.learn(a.db.keyring.all())
  await waitFor(async () => (await texts(blind.db)).length === 3)
  t.is(blind.db.keyring.seq, 2, 'handed over again once it applied, the history is complete')
  await blind.db.close()

  // the epochs its root carries make the history readable
  const rec = await makePeer(t, testnet, {
    topic,
    identity: recoveredId,
    encryptionKey,
    key: a.db.key,
    epochs: a.db.keyring.all()
  })
  await waitFor(async () => (await texts(rec.db)).length === 3)
  t.alike(await texts(rec.db), ['mid', 'post', 'pre'], 'full history from the delivered epochs')

  // seated by its own claim, the recovered device writes at the current epoch, the original
  // device decrypts it, and the next rotation seals to the new device row
  await rec.db.claim()
  await rec.db.put('messages', { text: 'recovered' })
  await waitFor(async () => (await texts(a.db)).includes('recovered'))
  await a.db.rotate()
  await waitFor(() => rec.db.keyring.seq === 3)
  t.pass('the recovered device opens the envelope of the next epoch, sealed to it')
})

test('rotate: a reader follows rotations on the device that joined; another needs its root', async (t) => {
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

  // second device, same reader identity, with the epochs the root hands it
  const key = Identity.randomKeyPair()
  const laptop = await makePeer(t, testnet, {
    topic,
    identity: Identity.from({ ...readerId, device: key, proof: readerId.link(key.publicKey) }),
    encryptionKey,
    key: a.db.key,
    epochs: phone.db.keyring.all()
  })
  await waitFor(async () => (await texts(laptop.db)).length === 2)
  t.is(laptop.db.keyring.seq, 1, 'reads what its sibling device read')
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
  const keyPair = first.db.keyPair
  await first.db.close()
  await a.put('messages', { text: 'pre' })
  await a.rotate()
  await a.put('messages', { text: 'post' })
  await waitForMirrored(a)
  const aKey = a.key
  await a.close()
  await aNet.close().catch(() => {})

  // B, the same device, has only the mirror — ciphertext relay — as a path to the data
  const b = await makePeer(t, testnet, {
    topic,
    identity: bId,
    encryptionKey,
    key: aKey,
    keyPair,
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
  const wrapped = [a, b].map(({ db, identity }) => ({
    id: hid.encode(db.writerKey),
    box: Identity.seal(identity.device.publicKey, sealed)
  }))
  await a.db.call('rotate-key', {
    epoch: 0,
    stamp: 12345,
    wrapped: c.encode(wraps, wrapped),
    createdAt: Date.now(),
    commit: crypto.hash(Identity.randomBytes(32)) // does not match `sealed`
  })
  await a.db.bee.update()

  await waitFor(async () => b.errors.some((e) => /commitment/.test(e.message)))
  // the rotation that heals the room may have landed by now: what is never held is the bad one's secret
  t.absent(a.db.keyring.entropy(12345), 'rotator side never adopts the epoch')
  t.absent(b.db.keyring.entropy(12345), 'member refuses an envelope that fails the commitment')
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
  const wrapped = [a, b].map(({ db, identity }) => ({
    id: hid.encode(db.writerKey),
    box: Identity.seal(identity.device.publicKey, Identity.randomBytes(32))
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
  t.pass('the room rotated past the epoch nobody could open, and both read the new one')
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
  t.ok(bee._epochParked, 'parked until the keyring learns an epoch, not dead')
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

test('epoch retry: a frozen writer with no key coming polls nothing, and wakes when it comes', async (t) => {
  const { a, members } = await makeRoom(t, ['member'])
  const [b] = members
  await a.db.put('messages', { text: 'before' })
  await waitFor(async () => (await texts(b.db)).includes('before'))

  const held = []
  const orig = b.db.rotation.learn.bind(b.db.rotation)
  b.db.rotation.learn = async (row) => {
    held.push(row)
  }
  await a.db.rotate()
  await a.db.put('messages', { text: 'after' })
  await waitFor(() => b.db.bee._epochStalled.size > 0)

  let polls = 0
  const update = b.db.bee.update.bind(b.db.bee)
  b.db.bee.update = (...args) => {
    polls++
    return update(...args)
  }
  await new Promise((resolve) => setTimeout(resolve, 2500))
  t.is(polls, 0, 'nothing retries while no key can arrive')

  b.db.rotation.learn = orig
  for (const row of held) await orig(row)
  await waitFor(async () => (await texts(b.db)).includes('after'))
  t.pass('the key arriving woke the frozen writer')
})

test('epoch retry: a writer frozen in the same pass that learns its key still wakes', async (t) => {
  const { a, members } = await makeRoom(t, ['member', 'member'])
  const [b, c] = members
  await a.db.put('messages', { text: 'before' })
  await waitFor(async () => (await texts(c.db)).includes('before'))
  await waitFor(async () => (await texts(b.db)).includes('before'))

  // hold C's next drain, so A's announcement and B's block from the new epoch land in one pass
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const apply = c.db.dispatcher.apply
  let held = false
  c.db.dispatcher.apply = async (...args) => {
    if (!held) {
      held = true
      await gate
    }
    return apply(...args)
  }
  // learning the key awaits its save: slow it, so a wake the learn sets off runs inside the pass
  const save = c.db.rotation._save.bind(c.db.rotation)
  c.db.rotation._save = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return save(...args)
  }

  await a.db.put('messages', { text: 'gate' })
  await waitFor(() => held)
  await a.db.rotate()
  await waitFor(() => b.db.keyring.seq === 1)
  await b.db.put('messages', { text: 'hi' })
  const ns = c.db.store.namespace(c.db.namespace)
  const cores = [b.db.bee.local, a.db.bee.local].map((local) => ({
    length: local.length,
    core: ns.get({ key: local.key, active: false })
  }))
  for (const { core, length } of cores) {
    await core.ready()
    core.download({ start: 0, end: length })
  }
  await waitFor(async () => {
    for (const { core, length } of cores) if (!(await core.has(length - 1))) return false
    return true
  })
  release()

  await waitFor(async () => (await texts(c.db)).includes('hi'), { timeout: 8000 })
  t.pass("C applied B's write without anyone writing again")
})

test('epochs reload: a primed keyring skips re-processing known rotations', async (t) => {
  const { a } = await makeRoom(t, [])
  await a.db.rotate()
  await a.db.rotate()

  let learned = 0
  const learn = a.db.rotation.learn.bind(a.db.rotation)
  a.db.rotation.learn = (row) => {
    learned++
    return learn(row)
  }
  await a.db.rotation.hydrate()
  t.is(learned, 0, 'known epochs are skipped')
})

test('rotate: a rotation a reorder drops is no longer the write key', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const encryptionKey = Identity.randomBytes(32)
  const a = await makePeer(t, testnet, { topic, encryptionKey })
  await a.db.bootstrap({ name: 'a' })
  const b = await makePeer(t, testnet, { topic, encryptionKey, key: a.db.key })
  await admit(a.db, b.db, 'admin')
  await waitFor(async () => b.db.writable)
  await a.db.put('messages', { text: 'pre' })
  await waitFor(async () => (await texts(b.db)).includes('pre'))

  const keyPair = b.db.keyPair
  await b.db.close()
  await b.network.close().catch(() => {})

  // demoted while away, B still sees itself an admin and rotates
  await a.db.set('members', { id: b.identity.id, role: 'member' })
  await a.db.put('messages', { text: 'a-post' })
  const off = new Database({
    store: b.store,
    identity: b.identity,
    spec,
    key: a.db.key,
    keyPair,
    encryptionKey
  })
  await off.ready()
  await off.rotate()
  await off.close()

  const net = new Network({ bootstrap: testnet.bootstrap, store: b.store })
  await net.ready()
  const disc = net.join(topic)
  await disc.flush()
  const back = new Database({
    store: b.store,
    identity: b.identity,
    network: net,
    spec,
    key: a.db.key,
    keyPair,
    encryptionKey
  })
  await back.ready()
  t.teardown(
    async () => {
      await back.close().catch(() => {})
      await disc.destroy().catch(() => {})
      await net.close().catch(() => {})
    },
    { order: 4 }
  )
  await waitFor(async () => (await texts(back)).includes('a-post'), { timeout: 20000 })
  await waitFor(() => back.keyring.current === 0, { timeout: 5000 }).catch(() => {})
  t.absent(
    await back.view.findOne('@cero/epochs', {}),
    'the demotion sorts first: the rotation never lands'
  )
  t.is(back.keyring.current, 0, 'B writes under the key every member holds')
})

test('rotate: a secret that fails its row commitment is never the write key, and the right one replaces it', async (t) => {
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])
  await a.db.rotate()
  const [e] = a.db.keyring.all()
  const joiner = await makePeer(t, testnet, {
    topic,
    encryptionKey,
    key: a.db.key,
    epochs: [{ ...e, entropy: Identity.randomBytes(32) }]
  })
  await waitFor(async () => !!(await joiner.db.view.findOne('@cero/epochs', {})))
  t.is(joiner.db.keyring.current, 0, 'nothing is written under a secret its row does not commit to')
  await joiner.db.learn(a.db.keyring.all())
  t.alike(joiner.db.keyring.entropy(e.stamp), e.entropy, 'the handed-over secret replaces it')
  t.is(joiner.db.keyring.current, e.stamp, 'and is the write key')
})

test('rotate: a member holding a wrong secret for a rotation sealed to it opens its box', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  const learn = b.db.rotation.learn.bind(b.db.rotation)
  b.db.rotation.learn = (row) => {
    b.db.keyring.add(row.stamp, Identity.randomBytes(32), row.epoch)
    return learn(row)
  }
  await a.db.rotate()
  const [e] = a.db.keyring.all()
  await waitFor(async () => !!(await b.db.view.findOne('@cero/epochs', {})))
  t.alike(b.db.keyring.entropy(e.stamp), e.entropy, 'the secret in its box replaces the held one')
  t.is(b.db.keyring.current, e.stamp)
})

test('rotate: a reopen replaces a stashed secret that fails its row commitment', async (t) => {
  const { a } = await makeRoom(t, [])
  await a.db.rotate()
  const [e] = a.db.keyring.all()
  a.db.keyring.add(e.stamp, Identity.randomBytes(32), e.epoch)
  await a.db.rotation._save()
  const { store, key, keyPair, encryptionKey } = a.db
  await a.db.close()

  const again = new Database({ store, identity: a.identity, spec, key, keyPair, encryptionKey })
  await again.ready()
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  t.alike(again.keyring.entropy(e.stamp), e.entropy, 'the secret in its box is learned again')
  t.is(again.keyring.current, e.stamp)
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
  const bWriter = hid.encode(b.db.writerKey)
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
  // equal the devices of the canonical membership {A, B}
  const cleanCurrent = async (db) => {
    const rows = await db.view.find('@cero/epochs', {}).toArray()
    if (!rows.length) return false
    const top = rows.reduce((x, y) => (y.epoch > x.epoch ? y : x))
    if (db.keyring.current !== top.stamp || !db.keyring.entropy(top.stamp)) return false
    const recipients = c.decode(wraps, top.wrapped).map((w) => w.id)
    const expect = [hid.encode(a.db.writerKey), bWriter].sort()
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

  // remove WITHOUT rotating — the healer must rotate on its own
  await a.db.call('del-member', { id: victim.identity.id })
  await waitFor(async () => a.db.keyring.seq >= 2, { timeout: 30000 })

  await a.db.put('messages', { text: 'post' })
  await new Promise((r) => setTimeout(r, 1500))
  t.absent((await texts(victim.db)).includes('post'), 'victim cannot read past the healed epoch')
})

test('rotate: a rotation its database closed under reports nothing, and is done when it opens again', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(() => b.db.writable)
  const { store, identity, network } = a
  const { key, keyPair, encryptionKey } = a.db
  // the owner removes a member and its database closes as the rotation that follows begins
  const rotate = a.db.rotation._rotate.bind(a.db.rotation)
  let closing = null
  a.db.rotation._rotate = (...args) => {
    closing ??= a.db.close()
    return rotate(...args)
  }
  await a.db.del('members', b.identity.id)
  await waitFor(() => closing !== null)
  await closing
  t.is(a.db.keyring.seq, 0, 'closed before its rotation')
  t.alike(
    a.errors.map((e) => e.message),
    [],
    'and nothing is reported'
  )

  const again = new Database({ store, identity, network, spec, key, keyPair, encryptionKey })
  await again.ready()
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  await waitFor(() => again.keyring.seq === 1, { timeout: 10000 }).catch(() => {})
  t.is(again.keyring.seq, 1, 'rotated at its next open, with no write to wake it')
  const [epoch] = await again.view.find('@cero/epochs', {}).toArray()
  const sealed = epoch ? c.decode(wraps, epoch.wrapped).map((w) => w.id) : []
  t.alike(sealed, [hid.encode(again.writerKey)], 'to the devices that stayed')
})

test('rotate: an audit its database closed under reports nothing', async (t) => {
  const { a } = await makeRoom(t, [])
  const db = a.db
  // the audit that follows a write has done its first read when the database closes
  const audit = db.rotation._audit.bind(db.rotation)
  let closing = null
  db.rotation._audit = () => {
    const get = db.get.bind(db)
    db.get = async (...args) => {
      const row = await get(...args)
      closing ??= db.close()
      return row
    }
    return audit()
  }
  await db.put('messages', { text: 'bye' })
  await waitFor(() => closing !== null)
  await closing
  t.alike(
    a.errors.map((e) => e.message),
    [],
    'nothing is reported'
  )
})

test('rotate: an audit that fails while its database is open is reported', async (t) => {
  const { a } = await makeRoom(t, [])
  a.db.rotation._epochs = async () => {
    throw new Error('disk full')
  }
  await a.db.put('messages', { text: 'wakes the audit' })
  await waitFor(() => a.errors.length > 0, { timeout: 5000 }).catch(() => {})
  t.alike(
    a.errors.map((e) => e.message),
    ['disk full']
  )
})

test('rotate: a member leaving on its own is sealed out by a rotation', async (t) => {
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
  t.alike(sealed, [hid.encode(a.db.writerKey)], 'the owner rotated to the devices that stayed')
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
      { id: hid.encode(a.db.writerKey), box: Identity.seal(a.identity.device.publicKey, entropy) }
    ]),
    createdAt: Date.now(),
    commit: crypto.hash(entropy)
  })
  await a.db.bee.update()

  const after = await a.db.view.find('@cero/epochs', {}).toArray()
  t.is(after.length, 1, 'colliding announcement was ignored')
  t.is(a.db.keyring.seq, 1, 'keyring unchanged')
})

test('rotate: a removed device of a member reads nothing written after the rotation', async (t) => {
  // envelopes are sealed to device keys: a lost phone keeps what it had and nothing more, while
  // the member's other device reads on
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])

  const memberId = await Identity.create()
  const phone = Identity.randomKeyPair()
  const dev1 = await makePeer(t, testnet, {
    topic,
    identity: memberId,
    encryptionKey,
    key: a.db.key
  })
  const dev2 = await makePeer(t, testnet, {
    topic,
    identity: Identity.from({ ...memberId, device: phone, proof: memberId.link(phone.publicKey) }),
    encryptionKey,
    key: a.db.key
  })
  await admit(a.db, dev1.db, 'member')
  await admit(a.db, dev2.db, 'member')

  await a.db.put('messages', { text: 'pre' })
  await waitFor(async () => (await texts(dev1.db)).includes('pre'))
  await waitFor(async () => (await texts(dev2.db)).includes('pre'))

  // "lost phone": removing device 2 rotates
  await a.db.call('del-device', { id: hid.encode(dev2.db.writerKey) })
  await a.db.put('messages', { text: 'post' })

  await waitFor(async () => (await texts(dev1.db)).includes('post'))
  t.is(dev1.db.keyring.seq, 1, 'surviving device follows the rotation')

  await new Promise((r) => setTimeout(r, 1500))
  t.alike(await texts(dev2.db), ['pre'], 'the removed device is frozen at the cut')
  t.is(dev2.db.keyring.seq, 0, 'no envelope was sealed to it')
})

test('rotate: the first device removal rotates by itself, sealing the removed one out', async (t) => {
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])
  const phone = Identity.randomKeyPair()
  const proof = a.identity.link(phone.publicKey)
  const dev = await makePeer(t, testnet, {
    topic,
    identity: Identity.from({ ...a.identity, seed: null, device: phone, proof }),
    encryptionKey,
    key: a.db.key
  })
  await waitFor(async () => (await dev.db.get('members', a.identity.id)).data)
  await dev.db.claim()
  await a.db.put('messages', { text: 'pre' })
  await waitFor(async () => (await texts(dev.db)).includes('pre'))

  await a.db.call('del-device', { id: hid.encode(dev.db.writerKey) })
  await waitFor(() => a.db.keyring.seq >= 1, { timeout: 30000 })
  await a.db.put('messages', { text: 'post' })
  await new Promise((r) => setTimeout(r, 1500))
  t.alike(await texts(dev.db), ['pre'], 'the removed device reads nothing written after')
})

// an admin's own batch: what apply reads, without the dry run an honest write goes through
// a host answering joins, and a joiner let in through its invite: promised a seat, holding the
// keys, with `open` to open the database on her device
async function promised(t, testnet) {
  const host = await makePeer(t, testnet)
  await host.db.bootstrap({ name: 'host' })
  const pairing = new Pairing({ mailbox: new Mailbox(host.network), db: host.db })
  await pairing.ready()
  t.teardown(() => pairing.close().catch(() => {}), { order: 0 })
  t.teardown(() => pairing.mailbox.close().catch(() => {}), { order: 1 })

  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const network = new Network({ bootstrap: testnet.bootstrap, store })
  await network.ready()
  t.teardown(() => network.close().catch(() => {}), { order: 6 })
  const mailbox = new Mailbox(network)
  t.teardown(() => mailbox.close().catch(() => {}), { order: 1 })
  const identity = await Identity.create()
  const join = async (opts, as = identity) => {
    const reply = await Pairing.join(mailbox, await pairing.invite(opts), { identity: as, spec })
    const { key, encryptionKey, epochs, writer: keyPair } = reply
    return { key, encryptionKey, epochs, keyPair }
  }
  const open = async (keys) => {
    const db = new Database({ store, identity, network, spec, ...keys })
    await db.ready()
    t.teardown(() => db.close().catch(() => {}), { order: 5 })
    return db
  }
  return { host, pairing, join, open }
}

const named = async (db) => {
  const rows = await db.view.find(`@${db.ns}/epochs`, {}).toArray()
  const top = rows.reduce((a, b) => (b.epoch > a.epoch ? b : a))
  return c.decode(wraps, top.wrapped).map((w) => w.id)
}

test('rotate: a device promised a seat is sealed to, and reads what was written since once it claims', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, join, open } = await promised(t, testnet)
  // the keys are hers before the rotation: its secret is not among them
  const keys = await join()
  await host.db.rotate()
  const [{ id }] = (await host.db.get('requests')).data
  t.ok((await named(host.db)).includes(id), 'the rotation names the promised device')
  await host.db.put('messages', { text: 'after the rotation' })

  const db = await open(keys)
  await db.claim()
  await waitFor(async () => (await texts(db)).includes('after the rotation'))
  t.is(db.keyring.seq, 1, 'she opened her envelope from the log')
  await waitFor(async () => (await host.db.get('requests')).data.length === 0)
  await host.db.rotation._audit()
  t.is(host.db.keyring.seq, 1, 'and her seat is no reason to rotate again: she was named')
})

test('rotate: a promise made since the last rotation is no reason to rotate, one dropped with no seat is', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, join } = await promised(t, testnet)
  await host.db.rotate()
  await join()
  const [{ id }] = (await host.db.get('requests')).data
  t.absent((await named(host.db)).includes(id), 'promised after the rotation: not named')
  await host.db.rotation._audit()
  t.is(host.db.keyring.seq, 1, 'which calls for no rotation')

  await host.db.rotate()
  t.ok((await named(host.db)).includes(id), 'the next one names it')
  await host.db.call('del-request', { id })
  await host.db.rotation._audit()
  t.is(host.db.keyring.seq, 3, 'dropped with no seat, the room rotates away from it')
})

test('rotate: a device that claimed its seat and is removed before its promise was settled is not sealed, and reads nothing written since', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, pairing, join, open } = await promised(t, testnet)
  const keys = await join()
  // the host answers no more: nobody settles the promise
  await pairing.close()
  const db = await open(keys)
  await db.claim()
  const id = hid.encode(db.writerKey)
  await waitFor(async () => (await host.db.get('devices', id)).data)
  t.ok((await host.db.get('requests', id)).data?.promised, 'seated, its promise not settled')

  await host.db.call('del-device', { id })
  t.is(host.db.keyring.seq, 1, 'its removal carried the rotation')
  t.absent((await named(host.db)).includes(id), 'which does not name it')
  await host.db.put('messages', { text: 'after the removal' })
  await waitFor(async () => (await db.rotation._epochs()).length > 0)
  t.is(db.keyring.seq, 0, 'it reads the announcement and opens no envelope')
  t.absent((await texts(db)).includes('after the removal'), 'nor anything written since')
})

test('rotate: a promise never kept whose invite ran out is not sealed', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, join } = await promised(t, testnet)
  await join({ ttl: 1500 })
  const [{ id, expires }] = (await host.db.get('requests')).data
  await host.db.rotate()
  t.ok((await named(host.db)).includes(id), 'named while its invite lasts')
  await waitFor(() => Date.now() > expires)
  await host.db.rotate()
  t.absent((await named(host.db)).includes(id), 'and no more once it ran out')
})

test('rotate: a device linked through a device that is then removed is not sealed', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, pairing, join } = await promised(t, testnet)
  // another device of the host's identity, seated: the one that links
  const device = Identity.randomKeyPair()
  const proof = host.identity.link(device.publicKey)
  const linker = Identity.from({ ...host.identity, device, proof })
  const { key, encryptionKey } = host.db
  const b = await makePeer(t, testnet, { topic: host.topic, identity: linker, key, encryptionKey })
  await b.db.claim()

  const phone = Identity.randomKeyPair()
  join({ confirm: true }, await Identity.bare(phone)).catch(() => {})
  const waiting = async () => (await host.db.get('requests', { admitted: false })).data[0]
  const { id } = await waitFor(waiting)
  // the host answers no more: the promise stays as apply leaves it
  await pairing.close()
  await host.db.call('accept', { id, proof: linker.link(phone.publicKey) })
  const { data: row } = await host.db.get('requests', id)
  await host.db.rotate()
  t.ok((await named(host.db)).includes(id), 'sealed while every key of its chain stands')

  await host.db.call('del-device', { id: hid.encode(b.db.writerKey) })
  t.absent(
    (await host.db.get('requests', id)).data,
    'its promise goes with the device that linked it'
  )
  t.is(host.db.keyring.seq, 2, 'the removal carried a rotation')
  t.absent((await named(host.db)).includes(id), 'which does not name it')
  const { rotation } = host.db
  t.absent(await rotation._stands(row), 'a promise whose chain passes a removed key stands no more')
  const own = { ...row, proof: null, key: device.publicKey }
  t.absent(await rotation._stands(own), 'nor one to a removed key itself')
  t.ok(await rotation._stands({ ...row, proof: host.identity.link(phone.publicKey) }))
})

function batch(db, ops) {
  return db.bee.append(ops.map(([name, op]) => wrap(db.version, db.spec.dispatch.encode(name, op))))
}

test('rotate: epochs announced in a batch apply refuses are learned by no one', async (t) => {
  const {
    a,
    members: [x, b]
  } = await makeRoom(t, ['admin', 'member'])
  await waitFor(async () => x.db.writable && b.db.writable)
  await waitFor(async () => (await x.db.get('devices')).data.length === 3)

  const { data: devices } = await x.db.get('devices')
  const others = devices.filter((d) => d.id !== hid.encode(x.db.writerKey))
  const stamps = [1000, 1001, 1002]
  const rotations = stamps.map((stamp) => {
    const entropy = Identity.randomBytes(32)
    const wrapped = c.encode(wraps, seal(others, entropy))
    return [
      '@cero/rotate-key',
      { epoch: 0, stamp, wrapped, createdAt: 1, commit: crypto.hash(entropy) }
    ]
  })
  const invite = { id: 'ff', role: 'owner', reuse: false, confirm: false, expires: 0, createdAt: 1 }
  await batch(x.db, [...rotations, ['@cero/add-invite', invite]])

  const refused = (p) => p.errors.some((e) => e.code === 'REFUSED')
  await waitFor(() => refused(a) && refused(b))
  t.is(
    (await a.db.view.find('@cero/epochs', {}).toArray()).length,
    0,
    'an admin cannot mint an owner: nothing landed'
  )
  for (const p of [a, b]) {
    t.absent(
      stamps.some((stamp) => p.db.keyring.entropy(stamp)),
      'and no secret of the batch is held'
    )
  }

  await a.db.call('del-member', { id: x.identity.id })
  await waitFor(() => a.db.keyring.seq >= 1 && b.db.keyring.current === a.db.keyring.current, {
    timeout: 30000
  })
  await a.db.put('messages', { text: 'after' })
  const raw = await a.db.bee.local.get(a.db.bee.local.length - 1, { raw: true })
  t.is(b4a.readUInt32LE(raw, 4), a.db.keyring.current, 'the owner writes under the heal')
  t.absent(stamps.includes(a.db.keyring.current), 'never under an epoch the removed admin minted')
})

test('rotate: an announcement whose envelopes do not decode never lands, so a later removal still rotates', async (t) => {
  const {
    a,
    members: [x]
  } = await makeRoom(t, ['admin'])
  await waitFor(async () => x.db.writable)

  const wrapped = b4a.from([0xff, 0xff, 0xff])
  await batch(x.db, [
    [
      '@cero/rotate-key',
      { epoch: 0, stamp: 4242, wrapped, createdAt: 1, commit: crypto.randomBytes(32) }
    ]
  ])
  await x.db.put('messages', { text: 'after it' })
  await waitFor(async () => (await texts(a.db)).includes('after it'))
  t.is((await a.db.view.find('@cero/epochs', {}).toArray()).length, 0, 'no epoch row')

  await a.db.call('del-member', { id: x.identity.id })
  const healed = await waitFor(() => a.db.keyring.seq >= 1, { timeout: 15000 }).then(
    () => true,
    () => false
  )
  t.ok(healed, 'the removal rotates')
})

// the epoch a block of this device's log was written under
const stampAt = async (db, i) => b4a.readUInt32LE(await db.bee.local.get(i, { raw: true }), 4)

// the devices the newest key is sealed to
async function sealedTo(db) {
  const rows = await db.view.find('@cero/epochs', {}).toArray()
  if (!rows.length) return []
  const top = rows.reduce((x, y) => (y.epoch > x.epoch ? y : x))
  return c
    .decode(wraps, top.wrapped)
    .map((w) => w.id)
    .sort()
}

const seats = (...peers) => peers.map((p) => hid.encode(p.db.writerKey)).sort()

// a member's two devices in the owner's room, the second linked by her identity
async function twoDevices(t, { a, testnet, topic, encryptionKey }, role) {
  const identity = await Identity.create()
  const phone = Identity.randomKeyPair()
  const linked = Identity.from({
    ...identity,
    device: phone,
    proof: identity.link(phone.publicKey)
  })
  const opts = { topic, encryptionKey, key: a.db.key }
  const first = await makePeer(t, testnet, { ...opts, identity })
  const second = await makePeer(t, testnet, { ...opts, identity: linked })
  await admit(a.db, first.db, role)
  await admit(a.db, second.db, role)
  await waitFor(async () => first.db.writable && (await first.db.get('devices')).data.length === 3)
  return [first, second]
}

test('rotate: a removal carries its rotation, the next write is under a key the removed member is not handed, and the key check adds none', async (t) => {
  const {
    a,
    members: [b, removed]
  } = await makeRoom(t, ['member', 'member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 3)
  const length = a.db.length
  let after = false
  let checked = false
  const check = a.db.rotation._audit.bind(a.db.rotation)
  a.db.rotation._audit = async () => {
    const counts = after
    await check()
    if (counts) checked = true
  }

  await a.db.del('members', removed.identity.id)
  t.is(a.db.keyring.seq, 1, 'the key is in place as the removal resolves')
  t.is(a.db.length, length + 2, 'the removal, then the rotation in a block of its own')
  t.alike(await sealedTo(a.db), seats(a, b), 'sealed to the devices that stay')

  after = true
  await a.db.put('messages', { text: 'after' })
  t.is(await stampAt(a.db, a.db.length - 1), a.db.keyring.current, 'the next write is under it')
  await waitFor(async () => (await texts(b.db)).includes('after'))
  t.absent(removed.db.keyring.entropy(a.db.keyring.current), 'a key the removed device never holds')
  t.absent((await texts(removed.db)).includes('after'), 'so it does not read the write')

  await waitFor(() => checked)
  t.is(
    (await a.db.view.find('@cero/epochs', {}).toArray()).length,
    1,
    'the key check found nothing to do'
  )
})

test('rotate: a member leaving carries no rotation', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['admin'])
  await waitFor(async () => b.db.writable && (await b.db.get('devices')).data.length === 2)
  const length = b.db.length

  await b.db.del('members', b.identity.id)
  t.is(b.db.length, length + 1, 'her removal and nothing after it')
  t.alike(
    b.errors.map((e) => e.message),
    [],
    'no rotation was tried'
  )
  await waitFor(() => a.db.keyring.seq === 1, { timeout: 30000 })
  t.alike(await sealedTo(a.db), seats(a), 'the owner rotated to the devices that stayed')
})

test('rotate: a member who may not remove takes her own device out with no rotation', async (t) => {
  const room = await makeRoom(t, [])
  const [first, second] = await twoDevices(t, room, 'member')
  const length = first.db.length

  await first.db.del('devices', hid.encode(second.db.writerKey))
  t.is(first.db.length, length + 1, 'the removal and nothing after it')
  t.alike(
    first.errors.map((e) => e.message),
    [],
    'no rotation was tried'
  )
  await waitFor(() => room.a.db.keyring.seq === 1, { timeout: 30000 })
  t.alike(await sealedTo(room.a.db), seats(room.a, first), 'a device that may remove rotated')
})

test('rotate: an admin taking her other device out carries the rotation', async (t) => {
  const room = await makeRoom(t, [])
  const [first, second] = await twoDevices(t, room, 'admin')
  const length = first.db.length

  await first.db.del('devices', hid.encode(second.db.writerKey))
  t.is(first.db.keyring.seq, 1, 'the key is in place as the removal resolves')
  t.is(first.db.length, length + 2)
  t.alike(await sealedTo(first.db), seats(room.a, first), 'sealed to the devices that stay')
})

test('rotate: a device taken out by its writer key carries the rotation too', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 2)

  await a.db.removeWriter(b.db.keyPair.publicKey)
  t.is(a.db.keyring.seq, 1)
  t.alike(await sealedTo(a.db), seats(a))
})

test('rotate: a removal carries its rotation to a device promised a seat, which reads on once it claims', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, pairing, join, open } = await promised(t, testnet)
  const { key, encryptionKey } = host.db
  const removed = await makePeer(t, testnet, { topic: host.topic, key, encryptionKey })
  await admit(host.db, removed.db)
  // let in by an accept: a removal withdraws the promise an invite made on its own
  const joining = join({ confirm: true, reuse: true })
  const waits = (row) => !row.admitted
  const { id } = await waitFor(async () => (await host.db.get('requests')).data.find(waits))
  await pairing.accept(id)
  const keys = await joining

  await host.db.del('members', removed.identity.id)
  t.is(host.db.keyring.seq, 1, 'the key is in place as the removal resolves')
  t.alike(
    await sealedTo(host.db),
    [...seats(host), id].sort(),
    'sealed to the device that stays and to the one promised a seat'
  )
  await host.db.put('messages', { text: 'after the removal' })

  const db = await open(keys)
  await db.claim()
  await waitFor(async () => (await texts(db)).includes('after the removal'))
  t.is(db.keyring.seq, 1, 'she opened her envelope from the log')
  await waitFor(async () => (await host.db.get('requests')).data.length === 0)
  await host.db.rotation._audit()
  t.is(host.db.keyring.seq, 1, 'and her seat is no reason to rotate again: she was named')
})

test('rotate: a removal of nobody, or one a rule refuses, appends no rotation', async (t) => {
  const {
    members: [x, y]
  } = await makeRoom(t, ['admin', 'admin'])
  await waitFor(async () => x.db.writable && (await x.db.get('members')).data.length === 3)
  const length = x.db.length

  await x.db.del('members', b4a.toString(Identity.randomBytes(32), 'hex'))
  const err = await x.db.del('members', y.identity.id).catch((e) => e)
  t.is(err.code, 'REFUSED', 'an admin does not outrank an admin')
  t.is(x.db.length, length, 'nothing was appended')
  t.absent(await x.db.view.findOne('@cero/epochs', {}), 'no rotation among it')

  await x.db.put('messages', { text: 'still writing' })
  t.is(x.db.length, length + 1, 'and writes go on')
})

test('rotate: a removal racing rotate() waits its turn, sealed to the devices that stay', async (t) => {
  const {
    a,
    members: [b, removed]
  } = await makeRoom(t, ['member', 'member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 3)

  const [first] = await Promise.all([a.db.rotate(), a.db.del('members', removed.identity.id)])
  t.is(first.epoch, 1)
  t.is(a.db.keyring.seq, 2, 'the carried rotation is the second')
  t.is((await a.db.view.find('@cero/epochs', {}).toArray()).length, 2)
  t.alike(await sealedTo(a.db), seats(a, b))
})

test('rotate: a write made between a removal and its key goes in after the key, under it', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 2)
  const rotate = a.db.rotation._rotate.bind(a.db.rotation)
  let racing = null
  a.db.rotation._rotate = (...args) => {
    racing ??= a.db.put('messages', { text: 'racing' })
    return rotate(...args)
  }

  await a.db.del('members', b.identity.id)
  await racing
  t.is(a.db.keyring.seq, 1)
  t.is(await stampAt(a.db, a.db.length - 1), a.db.keyring.current)
})

test('rotate: a write on its way when a removal starts goes in before it, not between it and its key', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 2)
  const own = []
  let release = null
  const held = new Promise((resolve) => (release = resolve))
  a.db.on('apply', (e) => {
    if (!b4a.equals(e.writerKey, a.db.writerKey)) return
    own.push(`${e.op}-${e.name}`)
    // a removal that overtook the write lets it in here, before the key
    if (e.op === 'del') release()
  })
  const dry = a.db._dryRun.bind(a.db)
  a.db._dryRun = async (ops) => {
    if (ops[0][0] === 'add-messages') await held
    return dry(ops)
  }

  const put = a.db.put('messages', { text: 'on its way' })
  const del = a.db.del('members', b.identity.id)
  await waitFor(() => a.db.rotation.carrying !== null)
  release()
  await Promise.all([put, del])
  t.alike(own.slice(-3), ['add-messages', 'del-member', 'rotate-key'])
})

test('rotate: a failure between a removal and its key is reported, and the key check rotates', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 2)
  let checks = 0
  const check = a.db.rotation._audit.bind(a.db.rotation)
  a.db.rotation._audit = () => {
    checks++
    return check()
  }
  const announce = a.db.rotation._announce.bind(a.db.rotation)
  let failed = false
  a.db.rotation._announce = async (...args) => {
    if (failed) return announce(...args)
    failed = true
    // the key check the removal woke finds a rotation on its way and does nothing
    const seen = checks
    await waitFor(() => checks > seen)
    throw new Error('disk full')
  }

  await a.db.del('members', b.identity.id)
  t.absent((await a.db.get('members', b.identity.id)).data, 'the removal landed')
  t.is(a.db.keyring.seq, 0, 'with no key')
  t.alike(
    a.errors.map((e) => e.message),
    ['disk full']
  )
  await waitFor(() => a.db.keyring.seq === 1)
  t.alike(await sealedTo(a.db), seats(a), 'the key check rotated to the devices that stay')
})

test('rotate: a device with no seat is refused a removal as it is any write', async (t) => {
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])
  const stranger = await makePeer(t, testnet, { topic, encryptionKey, key: a.db.key })
  await waitFor(async () => (await stranger.db.get('members', a.identity.id)).data)

  const err = await stranger.db.del('members', a.identity.id).catch((e) => e)
  t.is(err.code, 'NOT_WRITABLE')
})

test('rotate: a write waiting for a removal and its key is CLOSED when its database closes meanwhile', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 2)
  const rotate = a.db.rotation._rotate.bind(a.db.rotation)
  let waiting = null
  a.db.rotation._rotate = async (...args) => {
    waiting = a.db.put('messages', { text: 'waiting' }).catch((e) => e)
    await a.db.close()
    return rotate(...args)
  }

  await a.db.del('members', b.identity.id)
  t.is((await waiting).code, 'CLOSED')
  t.alike(a.errors, [], 'and the rotation it closed under reports nothing')
})

test('rotate: a removal whose database closes while it reads the devices is CLOSED', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 2)
  const staying = a.db.rotation._staying.bind(a.db.rotation)
  a.db.rotation._staying = async (ops) => {
    const devices = await staying(ops)
    await a.db.close()
    return devices
  }

  const err = await a.db.del('members', b.identity.id).catch((e) => e)
  t.is(err.code, 'CLOSED')
})

// a key check whose reads straddle a member's removal: the epochs before it, the rest after
function straddling(db, id) {
  const r = db.rotation
  const epochs = r._epochs.bind(r)
  let read = null
  const reading = new Promise((resolve) => (read = resolve))
  r._epochs = async () => {
    r._epochs = epochs
    const rows = await epochs()
    read()
    await waitFor(async () => !(await db.get('members', id)).data)
    return rows
  }
  return { check: r._audit(), reading }
}

test('rotate: a key check that starts while a removal is on its way adds no rotation', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 2)
  const staying = a.db.rotation._staying.bind(a.db.rotation)
  let check = null
  a.db.rotation._staying = async (ops) => {
    const devices = await staying(ops)
    const started = straddling(a.db, b.identity.id)
    check = started.check
    await started.reading
    return devices
  }

  await a.db.del('members', b.identity.id)
  t.is(a.db.keyring.seq, 1, 'carried')
  await check
  t.is((await a.db.view.find('@cero/epochs', {}).toArray()).length, 1, 'one rotation, one removal')
})

test('rotate: a key check that began before a removal and decides after it adds no rotation', async (t) => {
  const {
    a,
    members: [b]
  } = await makeRoom(t, ['member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 2)

  const { check, reading } = straddling(a.db, b.identity.id)
  await reading
  await a.db.del('members', b.identity.id)
  t.is(a.db.keyring.seq, 1, 'carried')
  await check
  t.is((await a.db.view.find('@cero/epochs', {}).toArray()).length, 1, 'one rotation, one removal')
})

test('rotate: a removal a reorder refuses after its key was sealed leaves the member in, and the next rotation is sealed to her again', async (t) => {
  const {
    a,
    members: [b, kept],
    testnet,
    topic,
    encryptionKey
  } = await makeRoom(t, ['admin', 'member'])
  await waitFor(async () => b.db.writable && (await b.db.get('devices')).data.length === 3)
  await waitFor(async () => (await kept.db.get('devices')).data.length === 3)

  const { keyPair } = b.db
  await b.db.close()
  await b.network.close().catch(() => {})

  // promoted while the admin is away: an admin does not outrank an admin
  await a.db.set('members', { id: kept.identity.id, role: 'admin' })
  const opts = {
    store: b.store,
    identity: b.identity,
    spec,
    key: a.db.key,
    keyPair,
    encryptionKey,
    onerror() {}
  }
  const off = new Database(opts)
  await off.ready()
  await off.del('members', kept.identity.id)
  t.is(off.keyring.seq, 1, 'the removal carried its key')
  t.alike(await sealedTo(off), seats(a, { db: off }), 'sealed to the devices it saw staying')
  await off.close()

  const net = new Network({ bootstrap: testnet.bootstrap, store: b.store })
  await net.ready()
  const disc = net.join(topic)
  await disc.flush()
  const back = new Database({ ...opts, network: net })
  await back.ready()
  t.teardown(
    async () => {
      await back.close().catch(() => {})
      await disc.destroy().catch(() => {})
      await net.close().catch(() => {})
    },
    { order: 4 }
  )

  const everyone = seats(a, { db: back }, kept).join()
  const sealedIn = async ({ db }) =>
    (await sealedTo(db)).join() === everyone && !!db.keyring.entropy(db.keyring.current)
  await waitFor(async () => (await sealedIn(a)) && (await sealedIn(kept)), { timeout: 30000 })
  t.pass('the newest key is sealed to all three, and she holds it')
  t.is(
    (await a.db.get('members', kept.identity.id)).data?.role,
    'admin',
    'the promotion sorts first: the removal is refused'
  )
})

// what the log keeps: 1 while a rotation is owed, 0 once one cleared it, null when none ever was
const owed = async (db) =>
  (await db.view.get(`@${db.ns}/counters`, { name: '_owed' }))?.value ?? null

test('rotate: a device handed its keys, which no key ever named, leaves while the owner is away: the owner rotates at its return, and it reads nothing written after', async (t) => {
  const {
    a,
    members: [m],
    testnet,
    topic,
    encryptionKey
  } = await makeRoom(t, ['member'])
  await waitFor(() => m.db.writable)
  await a.db.rotate()
  await waitFor(() => m.db.keyring.seq === 1)
  const { store, identity, network } = a
  const { key, keyPair } = a.db
  const staying = seats(a, m)
  await a.db.close()

  // let in by a member who may not remove, with the keys that member holds
  const opts = { topic, encryptionKey, key, epochs: m.db.keyring.all() }
  const n = await makePeer(t, testnet, opts)
  await admit(m.db, n.db, 'member')
  await m.db.put('messages', { text: 'pre' })
  await waitFor(async () => (await texts(n.db)).includes('pre'))
  t.alike(await sealedTo(m.db), staying, 'the newest key does not name her device')
  await n.db.del('members', n.identity.id)
  await waitFor(async () => !(await m.db.get('members', n.identity.id)).data)
  t.is(await owed(m.db), 1, 'her leaving owes a rotation, which nobody here may make')

  const again = new Database({ store, identity, network, spec, key, keyPair, encryptionKey })
  await again.ready()
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  await waitFor(() => again.keyring.seq === 2, { timeout: 30000 })
  t.alike(await sealedTo(again), staying, 'the owner rotated to the devices that stayed')
  t.is(await owed(again), 0, 'and nothing is owed')
  await again.put('messages', { text: 'post' })
  await waitFor(async () => (await texts(m.db)).includes('post'))
  await waitFor(async () => (await n.db.rotation._epochs()).length === 2)
  t.is(n.db.keyring.seq, 1, 'she reads the announcement and opens no envelope')
  t.absent((await texts(n.db)).includes('post'), 'nor anything written after')
})

test('rotate: a promise withdrawn after its keys were delivered is followed by a rotation, and its device reads nothing written after', async (t) => {
  const testnet = await makeTestnet(t)
  const { host, join, open } = await promised(t, testnet)
  await host.db.rotate()
  const keys = await join()
  const [{ id }] = (await host.db.get('requests')).data
  t.absent((await named(host.db)).includes(id), 'the newest key does not name her: it was handed')

  await host.db.call('deny', { id, reason: 'no' })
  await waitFor(() => host.db.keyring.seq === 2, { timeout: 30000 })
  t.is(await owed(host.db), 0, 'the rotation cleared what the withdrawal owed')
  await host.db.put('messages', { text: 'after' })
  const db = await open(keys)
  await waitFor(async () => (await db.rotation._epochs()).length === 2)
  t.is(db.keyring.seq, 1, 'she holds what she was handed and opens no envelope')
  t.absent((await texts(db)).includes('after'), 'so she reads nothing written after')
})

test('rotate: a leave owes a rotation on every device and after a view is applied again, and one rotation by a device that may remove clears it', async (t) => {
  const {
    a,
    members: [b, stays],
    encryptionKey
  } = await makeRoom(t, ['member', 'member'])
  await waitFor(() => b.db.writable)
  // the owner's key check waits: what the leave owes stays owed meanwhile
  a.db.rotation._audit = async () => {}
  await b.db.del('members', b.identity.id)
  await waitFor(async () => (await owed(a.db)) === 1 && (await owed(stays.db)) === 1)
  t.is(await owed(b.db), 1, 'owed on the device that left, on the owner and on a member')

  const { store, identity, network } = stays
  const { key, keyPair } = stays.db
  await stays.db.close()
  const meta = { ...spec.meta, rules: spec.meta.rules + 1 }
  const opts = { store, identity, network, key, keyPair, encryptionKey }
  const again = new Database({ ...opts, spec: { ...spec, meta } })
  await again.ready()
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  t.is((await again.dispatcher.built(again.view))[1], meta.rules, 'her view was applied again')
  t.is(await owed(again), 1, 'and owes the same')

  delete a.db.rotation._audit
  a.db.rotation.heal()
  await waitFor(() => a.db.keyring.seq === 1, { timeout: 30000 })
  await waitFor(async () => (await owed(again)) === 0)
  t.is(await owed(a.db), 0, 'cleared on every device')
  await a.db.rotation._audit()
  t.is((await a.db.rotation._epochs()).length, 1, 'by one rotation')
  t.alike(await sealedTo(a.db), seats(a, { db: again }), 'sealed to the devices that stayed')
})

test('rotate: two removals at once, each rotation naming the device the other removed, end on a rotation that names only seated devices, with nothing owed', async (t) => {
  const {
    a,
    members: [b, x, y],
    testnet,
    topic,
    encryptionKey
  } = await makeRoom(t, ['admin', 'member', 'member'])
  await waitFor(async () => b.db.writable && (await b.db.get('devices')).data.length === 4)
  const [staying, withX, withY] = [seats(a, b), seats(a, b, x), seats(a, b, y)]
  const { keyPair } = b.db
  await b.db.close()
  await b.network.close().catch(() => {})

  const opts = {
    store: b.store,
    identity: b.identity,
    spec,
    key: a.db.key,
    keyPair,
    encryptionKey,
    onerror() {}
  }
  const off = new Database(opts)
  await off.ready()
  await off.del('members', y.identity.id)
  t.alike(await sealedTo(off), withX, 'away, the admin sealed to the one the owner removes')
  await off.close()
  await a.db.del('members', x.identity.id)
  t.alike(await sealedTo(a.db), withY, 'and the owner to the one the admin removed')

  const net = new Network({ bootstrap: testnet.bootstrap, store: b.store })
  await net.ready()
  const disc = net.join(topic)
  await disc.flush()
  const back = new Database({ ...opts, network: net })
  await back.ready()
  t.teardown(
    async () => {
      await back.close().catch(() => {})
      await disc.destroy().catch(() => {})
      await net.close().catch(() => {})
    },
    { order: 4 }
  )
  const settled = async (db) =>
    (await sealedTo(db)).join() === staying.join() &&
    (await owed(db)) === 0 &&
    !!db.keyring.entropy(db.keyring.current)
  await waitFor(async () => (await settled(a.db)) && (await settled(back)), { timeout: 60000 })
  t.ok((await a.db.rotation._epochs()).length > 2, 'one more than the two the removals carried')
  t.absent((await a.db.get('members', x.identity.id)).data)
  t.absent((await a.db.get('members', y.identity.id)).data, 'both removals stand')
})

test('rotate: a removal that carries its rotation leaves nothing owed, and the key check adds no rotation', async (t) => {
  const {
    a,
    members: [b, removed]
  } = await makeRoom(t, ['member', 'member'])
  await waitFor(async () => (await a.db.get('devices')).data.length === 3)
  await a.db.del('members', removed.identity.id)
  t.is(await owed(a.db), 0, 'owed by the removal, cleared by the rotation it carried')
  await a.db.rotation._audit()
  t.is((await a.db.rotation._epochs()).length, 1, 'exactly one rotation')
  await waitFor(() => b.db.keyring.seq === 1)
  t.is(await owed(b.db), 0, 'and the same on a device that stayed')
})

test('rotate: a join and a new device owe nothing, and cause no rotation on the creation key or once the newest key names them', async (t) => {
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])
  const opts = { topic, encryptionKey, key: a.db.key }
  const m = await makePeer(t, testnet, opts)
  await admit(a.db, m.db, 'member')
  const device = Identity.randomKeyPair()
  const proof = a.identity.link(device.publicKey)
  const linked = Identity.from({ ...a.identity, seed: null, device, proof })
  const d = await makePeer(t, testnet, { ...opts, identity: linked })
  await waitFor(async () => (await d.db.get('members', a.identity.id)).data)
  await d.db.claim()
  await waitFor(async () => (await a.db.get('devices')).data.length === 3)
  await a.db.rotation._audit()
  t.is(a.db.keyring.seq, 0, 'the creation key names nobody, and they rotate nothing')
  t.is(await owed(a.db), null, 'and nothing is owed')

  await a.db.rotate()
  t.alike(await sealedTo(a.db), seats(a, m, d), 'a rotation names all three')
  await a.db.put('messages', { text: 'hello' })
  await waitFor(async () => (await texts(m.db)).includes('hello'))
  await waitFor(async () => (await texts(d.db)).includes('hello'))
  await a.db.rotation._audit()
  await d.db.rotation._audit()
  t.is(a.db.keyring.seq, 1, 'the key that names them is still the newest')
  t.is((await a.db.rotation._epochs()).length, 1, 'whichever device that may remove checks')
  t.is(await owed(a.db), 0, 'and nothing is owed')
})

test('rotate: a seated device of a plain member that the newest key does not name is sealed the next key by a device that may remove, with nobody removed, and reads what is written after', async (t) => {
  const { a, testnet, topic, encryptionKey } = await makeRoom(t, [])
  await a.db.rotate()
  t.alike(await sealedTo(a.db), seats(a), 'the newest key names the one device there is')
  // handed that key at her join, which it could not name
  const opts = { topic, encryptionKey, key: a.db.key, epochs: a.db.keyring.all() }
  const m = await makePeer(t, testnet, opts)
  await admit(a.db, m.db, 'member')

  await waitFor(() => m.db.keyring.seq === 2, { timeout: 30000 })
  t.alike(await sealedTo(a.db), seats(a, m), 'the next key does')
  t.is((await a.db.view.find('@cero/removals', {}).toArray()).length, 0, 'nobody was removed')
  t.is(await owed(a.db), 0, 'and nothing was owed')
  await a.db.put('messages', { text: 'after' })
  await waitFor(async () => (await texts(m.db)).includes('after'))
  t.pass('she reads what is written under it')
  await a.db.rotation._audit()
  t.is((await a.db.rotation._epochs()).length, 2, 'one rotation named her, and no more follow')
})
