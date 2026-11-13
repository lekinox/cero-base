import test from 'brittle'
import b4a from 'b4a'
import c from 'compact-encoding'

import { Identity } from '../../src/identity/index.js'
import { Invite } from '../../src/pairing/invite.js'
import { Pass } from '../../src/pairing/index.js'
import { wraps } from '../../src/database/encryption.js'
import { MAX_PASS } from '../../src/lib/constants.js'

const key = Identity.randomBytes(32)
const link = { key: Identity.randomBytes(32), length: 1 }
const fields = (extra = {}) => ({
  invite: Invite.create({ key, address: Identity.randomBytes(32), own: true, link }).toString(),
  key,
  encryptionKey: Identity.randomBytes(32),
  epochs: [{ epoch: 1, stamp: 2, entropy: Identity.randomBytes(32) }],
  data: b4a.from('team'),
  ...extra
})
const device = (identity) => ({ key: identity.device.publicKey })

test('pass: each device it is sealed to opens what it carries, and a device it is not sealed to nothing', async (t) => {
  const [phone, laptop, other] = await Promise.all([1, 2, 3].map(() => Identity.create()))
  const sealed = fields()
  const pass = Pass.seal([device(phone), device(laptop)], sealed)
  t.alike(Pass.open(phone, pass), sealed)
  t.alike(Pass.open(laptop, pass), sealed, 'a second device')
  t.is(Pass.open(other, pass), null)
  const bare = Pass.open(phone, Pass.seal([device(phone)], fields({ epochs: undefined })))
  t.alike(bare.epochs, [], 'no epochs: none')
})

test('pass: a key no device holds the secret of gets no box, the others theirs', async (t) => {
  const phone = await Identity.create()
  const pass = Pass.seal([{ key: b4a.alloc(32) }, device(phone)], fields())
  t.is(c.decode(wraps, pass).length, 1, 'one box')
  t.ok(Pass.open(phone, pass))
})

test('pass: what is not one is INVALID, sealed or opened', async (t) => {
  const phone = await Identity.create()
  t.exception(() => Pass.seal([{ key: b4a.alloc(31) }], fields()), /INVALID/, 'a key of no size')
  t.exception(() => Pass.seal([device(phone)], fields({ invite: 'nope' })), /INVALID/)
  const other = Identity.randomBytes(32)
  t.exception(
    () => Pass.seal([device(phone)], fields({ key: other })),
    /INVALID/,
    'keys of another room'
  )
  t.exception(() => Pass.open(phone, b4a.from('junk')), /INVALID/)
  const box = Identity.seal(phone.device.publicKey, b4a.from('junk'))
  const junk = c.encode(wraps, [{ id: phone.device.id, box }])
  t.exception(() => Pass.open(phone, junk), /INVALID/, 'a box that opens to junk')
})

test('pass: whether one fits what a room keeps is known before its invite exists, and holds once it does', async (t) => {
  const phone = await Identity.create()
  const { invite, ...keys } = fields()
  const entropy = Identity.randomBytes(32)
  const epochs = (n) =>
    Array.from({ length: n }, (_, i) => ({ epoch: i + 1, stamp: i + 2, entropy }))
  t.ok(Pass.fits([device(phone)], keys))
  t.absent(Pass.fits([device(phone)], { ...keys, epochs: epochs(2000) }), 'too many keys')
  let n = 1600
  while (Pass.fits([device(phone)], { ...keys, epochs: epochs(n + 1) })) n++
  const sealed = Pass.seal([device(phone)], { ...keys, epochs: epochs(n), invite })
  t.ok(sealed.byteLength <= MAX_PASS, 'the most that fits, sealed with a real invite, is kept')
})
