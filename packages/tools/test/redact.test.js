import test from 'brittle'
import b4a from 'b4a'
import { redact } from '../src/redact.js'

test('redact: masks denylisted field names by default', async (t) => {
  const mask = redact()
  const out = mask('members', { name: 'jb', secret: 'shh', token: 'abc' })
  t.is(out.name, 'jb', 'non-secret field passes through')
  t.is(out.secret, '‹redacted:string›', 'denylisted name masked')
  t.is(out.token, '‹redacted:string›')
})

test('redact: masks encryptionKey and mnemonic by default', async (t) => {
  const mask = redact()
  const out = mask('identity', {
    publicKey: b4a.alloc(32),
    encryptionKey: b4a.alloc(32),
    mnemonic: 'word word word'
  })
  t.is(out.encryptionKey, '‹redacted:bytes(32)›', 'encryptionKey masked')
  t.is(out.mnemonic, '‹redacted:string›', 'mnemonic masked')
  t.alike(out.publicKey, b4a.alloc(32), 'publicKey passes through')
})

test('redact: masks explicit field paths; buffers show their size', async (t) => {
  const mask = redact({ fields: ['profile.apiKey'] })
  const out = mask('x', { profile: { name: 'jb', apiKey: b4a.alloc(32) } })
  t.is(out.profile.name, 'jb', 'untargeted nested field intact')
  t.is(out.profile.apiKey, '‹redacted:bytes(32)›', 'buffer masked with its length, content hidden')
})

test('redact: predicate match, denylist disabled', async (t) => {
  const mask = redact({ deny: false, match: (k) => k.startsWith('x_') })
  const out = mask('x', { keep: 1, x_hidden: 2, secret: 'kept' })
  t.is(out.keep, 1)
  t.is(out.x_hidden, '‹redacted:number›', 'predicate-matched field masked')
  t.is(out.secret, 'kept', 'denylist off — secret passes through')
})

test('redact: leaves non-objects and arrays of primitives untouched', async (t) => {
  const mask = redact()
  t.is(mask('x', null), null)
  t.is(mask('x', 'plain'), 'plain')
  t.alike(mask('x', [1, 2, 3]), [1, 2, 3])
})
