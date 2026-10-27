import test from 'brittle'
import hid from 'hypercore-id-encoding'
import { Identity } from '../../src/identity/index.js'
import { withRole } from '../helpers/index.js'

// Who may remove a member, or change one's rank. By default her rank: a remover or assigner outranks whom she acts on.
// An app's rule on `members` may grant what rank alone refuses, by answering 'grant' (a bare true grants nothing: every
// rule answers it for "no objection"), and refuse what rank allows, by answering false. It is decided before anything
// moves, so a refusal leaves the member as she was: her row, her devices, her seat. The last owner still never leaves

const ts = Date.now()
const someone = (role, name = role) => {
  const key = Identity.randomBytes(32)
  return { id: hid.encode(key), key, role, name, createdAt: ts, updatedAt: ts }
}
const roleOf = async (db, id) => (await db.get('members', id)).data?.role ?? null

test('rank alone: an admin can’t remove or re-rank another admin; an owner can', async (t) => {
  const peer = someone('admin')
  const { db } = await withRole(t, 'admin', { members: [peer] })
  await t.exception(db.del('members', peer.id), /REFUSED/)
  await t.exception(db.set('members', { id: peer.id, role: 'member' }), /REFUSED/)
  t.is(await roleOf(db, peer.id), 'admin', 'untouched')

  const other = someone('admin')
  const { db: owner } = await withRole(t, 'owner', { members: [other] })
  await owner.set('members', { id: other.id, role: 'member' })
  t.is(await roleOf(owner, other.id), 'member', 'the owner re-ranks')
  await owner.del('members', other.id)
  t.is(await roleOf(owner, other.id), null, 'the owner removes')
})

test('a rule answering grant lets an admin remove another admin', async (t) => {
  const peer = someone('admin')
  const { db } = await withRole(t, 'admin', { members: [peer] })
  db.before('del', (ctx) =>
    ctx.name === 'members' && ctx.existing?.name === 'admin' ? 'grant' : undefined
  )
  await db.del('members', peer.id)
  t.is(await roleOf(db, peer.id), null, 'removed')
})

test('a rule answering grant lets an admin demote another admin', async (t) => {
  const peer = someone('admin')
  const { db } = await withRole(t, 'admin', { members: [peer] })
  db.before('set', (ctx) =>
    ctx.name === 'members' && ctx.row?.role === 'member' ? 'grant' : undefined
  )
  await db.set('members', { id: peer.id, role: 'member' })
  t.is(await roleOf(db, peer.id), 'member', 'demoted')
})

test('a bare true grants nothing: rank still decides', async (t) => {
  const peer = someone('admin')
  const { db } = await withRole(t, 'admin', { members: [peer] })
  db.before('del', () => true)
  db.before('set', () => true)
  await t.exception(db.del('members', peer.id), /REFUSED/)
  await t.exception(db.set('members', { id: peer.id, role: 'member' }), /REFUSED/)
  t.is(await roleOf(db, peer.id), 'admin')
})

test('a rule answering false refuses what rank allows, and the member stays as she was', async (t) => {
  const peer = someone('member')
  const { db } = await withRole(t, 'owner', { members: [peer] })
  db.before('del', (ctx) => (ctx.name === 'members' ? false : undefined))
  db.before('set', (ctx) =>
    ctx.name === 'members' && ctx.row?.role !== ctx.existing?.role ? false : undefined
  )
  await t.exception(db.del('members', peer.id), /REFUSED/)
  await t.exception(db.set('members', { id: peer.id, role: 'admin' }), /REFUSED/)
  t.is(await roleOf(db, peer.id), 'member', 'still a member, at her rank')
})

test('one rule refusing wins over another granting', async (t) => {
  const peer = someone('admin')
  const { db } = await withRole(t, 'admin', { members: [peer] })
  db.before('del', (ctx) => (ctx.name === 'members' ? 'grant' : undefined))
  db.before('del', (ctx) => (ctx.name === 'members' ? false : undefined))
  await t.exception(db.del('members', peer.id), /REFUSED/)
  t.is(await roleOf(db, peer.id), 'admin')
})

test('a rule sees whether rank alone allows it, whom it is about, and the change', async (t) => {
  const low = someone('member', 'low')
  const high = someone('admin', 'high')
  const { db } = await withRole(t, 'admin', { members: [low, high] })
  const seen = []
  db.before('del', (ctx) => {
    if (ctx.name === 'members') seen.push([ctx.existing.name, ctx.ranked, ctx.role])
  })
  db.before('set', (ctx) => {
    if (ctx.name === 'members' && ctx.row.role !== ctx.existing.role) {
      seen.push([ctx.existing.name, ctx.row.role, ctx.ranked])
    }
  })
  await db.set('members', { id: low.id, role: 'admin' }).catch(() => {})
  await db.del('members', high.id).catch(() => {})
  await db.del('members', low.id).catch(() => {})
  // a write runs once as a dry run, then for real: each verdict is seen in both
  t.alike(
    [...new Set(seen.map((s) => JSON.stringify(s)))].map((s) => JSON.parse(s)),
    [
      ['low', 'admin', true],
      ['high', false, 'admin'],
      // low was made admin just before: rank alone no longer allows it
      ['low', false, 'admin']
    ]
  )
})

test('a grant still never takes away the last owner', async (t) => {
  const { db, identity } = await withRole(t, 'owner', { members: [someone('member')] })
  db.before('del', (ctx) => (ctx.name === 'members' ? 'grant' : undefined))
  await t.exception(db.del('members', identity.id), /last owner/)
  t.is(await roleOf(db, identity.id), 'owner')
})

test('grant means nothing on other writes: only false refuses there', async (t) => {
  const { db } = await withRole(t, 'member')
  db.before('put', () => 'grant')
  const { data } = await db.put('messages', { text: 'hi' })
  t.is(data.text, 'hi')
})

test('after hooks still fire for a removal and a re-rank decided by a rule', async (t) => {
  const peer = someone('admin')
  const other = someone('admin')
  const { db } = await withRole(t, 'admin', { members: [peer, other] })
  db.before('del', (ctx) => (ctx.name === 'members' ? 'grant' : undefined))
  db.before('set', (ctx) => (ctx.name === 'members' ? 'grant' : undefined))
  const fired = []
  db.after('del', (ctx) => void (ctx.name === 'members' && fired.push(`del ${ctx.existing.name}`)))
  db.after('set', (ctx) => void (ctx.name === 'members' && fired.push(`set ${ctx.row.role}`)))
  await db.del('members', peer.id)
  await db.set('members', { id: other.id, role: 'member' })
  t.alike([...new Set(fired)], ['del admin', 'set member'], 'each lands, its after hooks fire')
})

test('a grant never demotes the last owner either', async (t) => {
  const { db, identity } = await withRole(t, 'owner', { members: [someone('admin')] })
  db.before('set', (ctx) => (ctx.name === 'members' ? 'grant' : undefined))
  await t.exception(db.set('members', { id: identity.id, role: 'admin' }), /last owner/)
  t.is(await roleOf(db, identity.id), 'owner')
})

test('a grant counts only for a member who writes: a reader is refused, whatever a rule says', async (t) => {
  const target = someone('member')
  const { db } = await withRole(t, 'reader', { members: [target] })
  db.before('del', (ctx) => (ctx.name === 'members' ? 'grant' : undefined))
  db.before('set', (ctx) => (ctx.name === 'members' ? 'grant' : undefined))
  await t.exception(db.del('members', target.id), /REFUSED/)
  await t.exception(db.set('members', { id: target.id, role: 'admin' }), /REFUSED/)
  t.is(await roleOf(db, target.id), 'member')
})

test('a rank cero has no name for is refused, granted or not', async (t) => {
  const target = someone('member')
  const { db } = await withRole(t, 'owner', { members: [target] })
  db.before('set', (ctx) => (ctx.name === 'members' ? 'grant' : undefined))
  await t.exception(db.set('members', { id: target.id, role: 'emperor' }))
  t.is(await roleOf(db, target.id), 'member')
})

test('a rank named after an object’s own keys is no rank either', async (t) => {
  const target = someone('member')
  const { db } = await withRole(t, 'owner', { members: [target] })
  db.before('set', (ctx) => (ctx.name === 'members' ? 'grant' : undefined))
  for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    await t.exception(db.set('members', { id: target.id, role }), undefined, role)
  }
  t.is(await roleOf(db, target.id), 'member')
})
