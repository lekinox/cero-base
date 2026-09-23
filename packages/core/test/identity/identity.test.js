import test from 'brittle'
import b4a from 'b4a'
import bip39 from 'bip39-mnemonic'
import { Identity } from '../../src/identity/index.js'

const KNOWN_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

test('create: a fresh identity', async (t) => {
  const identity = await Identity.create()
  t.ok(identity instanceof Identity)
  t.is(typeof identity.id, 'string')
  t.is(identity.publicKey.length, 32)
  t.is(identity.secretKey.length, 64)
  t.is(identity.encryptionKey.length, 32)
  t.is(identity.topic.length, 32)
  t.is(identity.toPhrase().split(' ').length, 12)
  t.unlike((await Identity.create()).id, identity.id, 'a different one each call')
})

test('create: words sizes a fresh one, 12 or 24', async (t) => {
  t.is((await Identity.create({ words: 24 })).toPhrase().split(' ').length, 24)
  await t.exception(Identity.create({ words: 13 }), /must be 12 or 24/)
})

test('create: the same seed restores the same identity', async (t) => {
  const identity = await Identity.create()
  const again = await Identity.create({ seed: identity.seed })
  t.is(again.id, identity.id)
  t.alike(again.encryptionKey, identity.encryptionKey)
  t.alike(again.topic, identity.topic)
  const long = Identity.randomBytes(32)
  t.alike((await Identity.create({ seed: long })).seed, long, '32 bytes, a 24-word phrase')
})

test('create: a seed that is not 16 or 32 bytes throws', async (t) => {
  for (const seed of [KNOWN_PHRASE, b4a.alloc(8), b4a.alloc(64), 123, { length: 32 }]) {
    await t.exception(Identity.create({ seed }), /seed must be 16 or 32 bytes/)
  }
})

test('toSeed and toPhrase: the phrase is the seed written out', async (t) => {
  const seed = Identity.toSeed(KNOWN_PHRASE)
  t.is(seed.byteLength, 16)
  t.is(Identity.toPhrase(seed), KNOWN_PHRASE)
  t.is((await Identity.create({ seed })).toPhrase(), KNOWN_PHRASE)
  for (const phrase of ['not a real phrase', '', 'zzz '.repeat(12).trim(), null]) {
    t.exception(() => Identity.toSeed(phrase), /BIP-39 mnemonic/)
  }
})

// ─── instance ─────────────────────────────────────────────────────────────

test('instance is frozen', async (t) => {
  const me = await Identity.create()
  t.exception.all(() => {
    me.id = 'tampered'
  })
})

test('topic is deterministic per identity', async (t) => {
  const me = await Identity.create({ seed: Identity.toSeed(KNOWN_PHRASE) })
  const other = await Identity.create({ seed: Identity.toSeed(KNOWN_PHRASE) })
  t.alike(b4a.toBuffer(me.topic), b4a.toBuffer(other.topic))
})

test('topic differs for different identities', async (t) => {
  const a = await Identity.create()
  const b = await Identity.create()
  t.unlike(b4a.toString(a.topic, 'hex'), b4a.toString(b.topic, 'hex'))
})

// ─── sign / verify ────────────────────────────────────────────────────────

test('sign + verify (instance): round-trips', async (t) => {
  const me = await Identity.create()
  const msg = b4a.from('hello')
  const sig = me.sign(msg)
  t.is(sig.length, 64)
  t.ok(me.verify(msg, sig))
})

test('verify (instance): rejects tampered message', async (t) => {
  const me = await Identity.create()
  const sig = me.sign(b4a.from('hello'))
  t.absent(me.verify(b4a.from('hellp'), sig))
})

test('verify (instance): rejects tampered signature', async (t) => {
  const me = await Identity.create()
  const sig = me.sign(b4a.from('hello'))
  sig[0] ^= 0xff
  t.absent(me.verify(b4a.from('hello'), sig))
})

test('Identity.verify (static): verifies any publicKey', async (t) => {
  const a = await Identity.create()
  const b = await Identity.create()
  const msg = b4a.from('signed by a')
  const sig = a.sign(msg)
  t.ok(Identity.verify(a.publicKey, msg, sig))
  t.absent(Identity.verify(b.publicKey, msg, sig))
})

// ─── randomness ───────────────────────────────────────────────────────────

test('randomBytes: returns the requested size', (t) => {
  t.is(Identity.randomBytes().length, 32)
  t.is(Identity.randomBytes(16).length, 16)
  t.is(Identity.randomBytes(64).length, 64)
})

test('randomBytes: returns different bytes on each call', (t) => {
  const a = Identity.randomBytes(32)
  const b = Identity.randomBytes(32)
  t.unlike(b4a.toString(a, 'hex'), b4a.toString(b, 'hex'))
})

test('randomKeyPair: returns valid ed25519 keypair', (t) => {
  const { publicKey, secretKey, id } = Identity.randomKeyPair()
  t.is(publicKey.length, 32)
  t.is(secretKey.length, 64)
  t.is(typeof id, 'string')
})

test('randomKeyPair: different on each call', (t) => {
  const a = Identity.randomKeyPair()
  const b = Identity.randomKeyPair()
  t.unlike(a.id, b.id)
})

// ─── derivation properties ────────────────────────────────────────────────

test('encryptionKey is derived independently from publicKey', async (t) => {
  const me = await Identity.create({ seed: Identity.toSeed(KNOWN_PHRASE) })
  // Encryption key shouldn't equal publicKey
  t.unlike(b4a.toString(me.publicKey, 'hex'), b4a.toString(me.encryptionKey, 'hex'))
  // But it should be deterministic
  const other = await Identity.create({ seed: Identity.toSeed(KNOWN_PHRASE) })
  t.alike(b4a.toBuffer(me.encryptionKey), b4a.toBuffer(other.encryptionKey))
})

test('id is z32-encoded publicKey', async (t) => {
  const me = await Identity.create()
  // z32 encoding of 32 bytes is 52 characters
  t.is(me.id.length, 52)
  // It only contains z32 alphabet (no '0', '2', 'v', 'l', etc.)
  t.ok(/^[ybndrfg8ejkmcpqxot1uwisza345h769]+$/.test(me.id))
})

// ─── BIP39 language coverage ──────────────────────────────────────────────
//
// bip39-mnemonic's mnemonicToEntropy auto-detects the wordlist, so any
// BIP39 phrase in a supported language should derive to the same seed
// and thus the same Identity.

const LANGUAGES = ['english', 'spanish', 'french', 'italian', 'japanese']

test('create: each BIP39 language maps the same entropy to the same identity', async (t) => {
  const en = await Identity.create({ seed: Identity.toSeed(KNOWN_PHRASE) })
  const entropy = bip39.mnemonicToEntropy(KNOWN_PHRASE)

  for (const language of LANGUAGES) {
    const phrase = bip39.entropyToMnemonic(entropy, { language })
    const id = await Identity.create({ seed: Identity.toSeed(phrase) })
    t.alike(b4a.toBuffer(id.publicKey), b4a.toBuffer(en.publicKey), `${language} → same identity`)
  }
})

test('create: a japanese phrase (ideographic space delimiter) is accepted', async (t) => {
  const entropy = bip39.mnemonicToEntropy(KNOWN_PHRASE)
  const jp = bip39.entropyToMnemonic(entropy, { language: 'japanese' })
  t.ok(jp.includes('　'), 'japanese phrase uses ideographic space')
  const id = await Identity.create({ seed: Identity.toSeed(jp) })
  const en = await Identity.create({ seed: Identity.toSeed(KNOWN_PHRASE) })
  t.alike(b4a.toBuffer(id.publicKey), b4a.toBuffer(en.publicKey))
})

// secretKey, encryptionKey and seed must not be enumerable: one
// JSON.stringify or structured logger would leak the whole identity
test('serialization redacts key material', async (t) => {
  const id = await Identity.create()
  t.alike(JSON.parse(JSON.stringify(id)), { id: id.id }, 'toJSON exposes only the public id')

  const shown = id[Symbol.for('nodejs.util.inspect.custom')]()
  t.is(shown, `Identity(${id.id})`, 'inspect shows only the id')
  t.absent(shown.includes(b4a.toString(id.secretKey, 'hex')), 'no secret bytes in inspect')

  t.ok(b4a.isBuffer(id.secretKey), 'direct property access still works internally')
})

// ─── sealed boxes (key-rotation envelopes) ─────────────────────────────────

test('seal/unseal: only the addressed identity can open, on any of its devices', async (t) => {
  const alice = await Identity.create()
  const eve = await Identity.create()
  const secret = Identity.randomBytes(32)

  const box = Identity.seal(alice.publicKey, secret)
  t.unlike(box, secret, 'sealed box is not the plaintext')

  t.alike(alice.unseal(box), secret, 'addressee opens it')
  t.is(eve.unseal(box), null, 'anyone else gets null')

  const aliceLaptop = await Identity.create({ seed: alice.seed })
  t.alike(aliceLaptop.unseal(box), secret, 'same seed on another device opens it too')
})

test('unseal: corrupt or truncated boxes return null, never throw', async (t) => {
  const id = await Identity.create()
  const box = Identity.seal(id.publicKey, Identity.randomBytes(32))
  box[0] ^= 0xff
  t.is(id.unseal(box), null, 'corrupt box')
  t.is(id.unseal(box.subarray(0, 10)), null, 'truncated box')
  t.is(id.unseal(null), null, 'not a buffer')
})
