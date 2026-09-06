import test from 'brittle'
import b4a from 'b4a'
import bip39 from 'bip39-mnemonic'
import { Identity } from '../../src/identity/index.js'

const KNOWN_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// ─── factories ────────────────────────────────────────────────────────────

test('generate: produces a fresh identity', async (t) => {
  const me = await Identity.generate()
  t.ok(me instanceof Identity)
  t.is(typeof me.id, 'string')
  t.is(me.publicKey.length, 32)
  t.is(me.secretKey.length, 64)
  t.is(me.encryptionKey.length, 32)
  t.is(me.topic.length, 32)
  t.is(me.seed.length, 16)
})

test('generate: two calls yield different identities', async (t) => {
  const a = await Identity.generate()
  const b = await Identity.generate()
  t.unlike(a.id, b.id)
  t.unlike(b4a.toString(a.seed, 'hex'), b4a.toString(b.seed, 'hex'))
})

test('fromSeed: deterministic — same seed yields same identity', async (t) => {
  const seed = Identity.randomBytes(32)
  const a = await Identity.fromSeed(seed)
  const b = await Identity.fromSeed(seed)
  t.is(a.id, b.id)
  t.alike(b4a.toBuffer(a.publicKey), b4a.toBuffer(b.publicKey))
  t.alike(b4a.toBuffer(a.encryptionKey), b4a.toBuffer(b.encryptionKey))
  t.alike(b4a.toBuffer(a.topic), b4a.toBuffer(b.topic))
})

test('fromSeed: rejects invalid input', async (t) => {
  await t.exception.all(() => Identity.fromSeed('not a buffer'), /seed must be/)
  await t.exception.all(() => Identity.fromSeed(b4a.alloc(8)), /seed must be/)
  await t.exception.all(() => Identity.fromSeed(null), /seed must be/)
})

test('fromPhrase: round-trip via phrase', async (t) => {
  const me = await Identity.fromPhrase(KNOWN_PHRASE)
  t.is(me.toPhrase(), KNOWN_PHRASE)
})

test('fromPhrase: same phrase yields same identity on every call', async (t) => {
  const a = await Identity.fromPhrase(KNOWN_PHRASE)
  const b = await Identity.fromPhrase(KNOWN_PHRASE)
  t.is(a.id, b.id)
})

test('fromPhrase: rejects invalid phrase', async (t) => {
  await t.exception.all(() => Identity.fromPhrase('not a real phrase'), /valid BIP39/)
  await t.exception.all(() => Identity.fromPhrase(''), /valid BIP39/)
  await t.exception.all(() => Identity.fromPhrase(null), /valid BIP39/)
})

test('seed ↔ phrase round-trip is stable', async (t) => {
  const phrase = Identity.genPhrase()
  const seed = Identity.toSeed(phrase)
  t.is(Identity.toPhrase(seed), phrase)
})

// ─── instance ─────────────────────────────────────────────────────────────

test('instance is frozen', async (t) => {
  const me = await Identity.generate()
  t.exception.all(() => {
    me.id = 'tampered'
  })
})

test('topic is deterministic per identity', async (t) => {
  const me = await Identity.fromPhrase(KNOWN_PHRASE)
  const other = await Identity.fromPhrase(KNOWN_PHRASE)
  t.alike(b4a.toBuffer(me.topic), b4a.toBuffer(other.topic))
})

test('topic differs for different identities', async (t) => {
  const a = await Identity.generate()
  const b = await Identity.generate()
  t.unlike(b4a.toString(a.topic, 'hex'), b4a.toString(b.topic, 'hex'))
})

// ─── sign / verify ────────────────────────────────────────────────────────

test('sign + verify (instance): round-trips', async (t) => {
  const me = await Identity.generate()
  const msg = b4a.from('hello')
  const sig = me.sign(msg)
  t.is(sig.length, 64)
  t.ok(me.verify(msg, sig))
})

test('verify (instance): rejects tampered message', async (t) => {
  const me = await Identity.generate()
  const sig = me.sign(b4a.from('hello'))
  t.absent(me.verify(b4a.from('hellp'), sig))
})

test('verify (instance): rejects tampered signature', async (t) => {
  const me = await Identity.generate()
  const sig = me.sign(b4a.from('hello'))
  sig[0] ^= 0xff
  t.absent(me.verify(b4a.from('hello'), sig))
})

test('Identity.verify (static): verifies any publicKey', async (t) => {
  const a = await Identity.generate()
  const b = await Identity.generate()
  const msg = b4a.from('signed by a')
  const sig = a.sign(msg)
  t.ok(Identity.verify(a.publicKey, msg, sig))
  t.absent(Identity.verify(b.publicKey, msg, sig))
})

// ─── predicates ───────────────────────────────────────────────────────────

test('isSeed: accepts 16- and 32-byte buffers', (t) => {
  t.ok(Identity.isSeed(b4a.alloc(16)))
  t.ok(Identity.isSeed(b4a.alloc(32)))
  t.ok(Identity.isSeed(new Uint8Array(16)))
  t.ok(Identity.isSeed(new Uint8Array(32)))
})

test('isSeed: rejects everything else', (t) => {
  t.absent(Identity.isSeed(null))
  t.absent(Identity.isSeed(undefined))
  t.absent(Identity.isSeed('string'))
  t.absent(Identity.isSeed(123))
  t.absent(Identity.isSeed(b4a.alloc(8)))
  t.absent(Identity.isSeed(b4a.alloc(64)))
  t.absent(Identity.isSeed({ length: 32 }))
})

test('isPhrase: accepts valid BIP39 mnemonic', (t) => {
  t.ok(Identity.isPhrase(KNOWN_PHRASE))
  t.ok(Identity.isPhrase(Identity.genPhrase()))
  t.ok(Identity.isPhrase(Identity.genPhrase(24)))
})

test('isPhrase: rejects invalid input', (t) => {
  t.absent(Identity.isPhrase(''))
  t.absent(Identity.isPhrase('one two three'))
  t.absent(Identity.isPhrase('zzz '.repeat(12).trim())) // not real words
  t.absent(Identity.isPhrase(null))
  t.absent(Identity.isPhrase(b4a.alloc(32)))
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

test('genPhrase: 12 words by default', (t) => {
  const phrase = Identity.genPhrase()
  t.is(phrase.split(' ').length, 12)
  t.ok(Identity.isPhrase(phrase))
})

test('genPhrase: supports 24 words', (t) => {
  const phrase = Identity.genPhrase(24)
  t.is(phrase.split(' ').length, 24)
  t.ok(Identity.isPhrase(phrase))
})

test('genPhrase: rejects other word counts', (t) => {
  t.exception.all(() => Identity.genPhrase(13), /must be 12 or 24/)
  t.exception.all(() => Identity.genPhrase(0), /must be 12 or 24/)
})

// ─── derivation properties ────────────────────────────────────────────────

test('encryptionKey is derived independently from publicKey', async (t) => {
  const me = await Identity.fromPhrase(KNOWN_PHRASE)
  // Encryption key shouldn't equal publicKey
  t.unlike(b4a.toString(me.publicKey, 'hex'), b4a.toString(me.encryptionKey, 'hex'))
  // But it should be deterministic
  const other = await Identity.fromPhrase(KNOWN_PHRASE)
  t.alike(b4a.toBuffer(me.encryptionKey), b4a.toBuffer(other.encryptionKey))
})

test('id is z32-encoded publicKey', async (t) => {
  const me = await Identity.generate()
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

test('fromPhrase: each BIP39 language maps the same entropy to the same identity', async (t) => {
  const en = await Identity.fromPhrase(KNOWN_PHRASE)
  const entropy = bip39.mnemonicToEntropy(KNOWN_PHRASE)

  for (const language of LANGUAGES) {
    const phrase = bip39.entropyToMnemonic(entropy, { language })
    t.ok(Identity.isPhrase(phrase), `${language} phrase recognised`)
    const id = await Identity.fromPhrase(phrase)
    t.alike(b4a.toBuffer(id.publicKey), b4a.toBuffer(en.publicKey), `${language} → same identity`)
  }
})

test('fromPhrase: japanese phrase (ideographic space delimiter) is accepted', async (t) => {
  const entropy = bip39.mnemonicToEntropy(KNOWN_PHRASE)
  const jp = bip39.entropyToMnemonic(entropy, { language: 'japanese' })
  t.ok(jp.includes('　'), 'japanese phrase uses ideographic space')
  const id = await Identity.fromPhrase(jp)
  const en = await Identity.fromPhrase(KNOWN_PHRASE)
  t.alike(b4a.toBuffer(id.publicKey), b4a.toBuffer(en.publicKey))
})

// secretKey, encryptionKey and seed must not be enumerable: one
// JSON.stringify or structured logger would leak the whole identity
test('serialization redacts key material', async (t) => {
  const id = await Identity.generate()
  t.alike(JSON.parse(JSON.stringify(id)), { id: id.id }, 'toJSON exposes only the public id')

  const shown = id[Symbol.for('nodejs.util.inspect.custom')]()
  t.is(shown, `Identity(${id.id})`, 'inspect shows only the id')
  t.absent(shown.includes(b4a.toString(id.secretKey, 'hex')), 'no secret bytes in inspect')

  t.ok(b4a.isBuffer(id.secretKey), 'direct property access still works internally')
})

// ─── sealed boxes (key-rotation envelopes) ─────────────────────────────────

test('seal/unseal: only the addressed identity can open, on any of its devices', async (t) => {
  const alice = await Identity.generate()
  const eve = await Identity.generate()
  const secret = Identity.randomBytes(32)

  const box = Identity.seal(alice.publicKey, secret)
  t.unlike(box, secret, 'sealed box is not the plaintext')

  t.alike(alice.unseal(box), secret, 'addressee opens it')
  t.is(eve.unseal(box), null, 'anyone else gets null')

  const aliceLaptop = await Identity.fromSeed(alice.seed)
  t.alike(aliceLaptop.unseal(box), secret, 'same seed on another device opens it too')
})

test('unseal: corrupt or truncated boxes return null, never throw', async (t) => {
  const id = await Identity.generate()
  const box = Identity.seal(id.publicKey, Identity.randomBytes(32))
  box[0] ^= 0xff
  t.is(id.unseal(box), null, 'corrupt box')
  t.is(id.unseal(box.subarray(0, 10)), null, 'truncated box')
  t.is(id.unseal(null), null, 'not a buffer')
})
