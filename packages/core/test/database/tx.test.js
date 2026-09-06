import test from 'brittle'

import { Database } from '../../src/database/index.js'
import { Identity } from '../../src/identity/index.js'
import { makeStore } from '../helpers/index.js'
import { spec } from '../fixtures/spec/index.js'

test.configure({ timeout: 60000 })

async function open(t, role = 'owner') {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = await Identity.generate()
  const db = new Database({ store, identity, spec })
  await db.ready()
  await db.bootstrap({ name: 'tx', isMobile: false })
  await db.call('add-member', {
    id: identity.id,
    key: db.writerKey,
    role,
    name: 'me',
    createdAt: 1,
    updatedAt: 1
  })
  t.teardown(() => db.close().catch(() => {}), { order: 5 })
  return { db, identity }
}

// the local log grows one block per op; a transaction appends them together,
// so the tell is the count — N for the batch, or 0 when any of it is refused
const len = (db) => db.bee.local.length
const texts = async (db) =>
  (await db.get('messages')).data.sort((a, b) => a.index - b.index).map((r) => r.text)

// ─── atomic at the append ─────────────────────────────────────────────────

test('tx: every op lands, in one append, and the callback result comes back', async (t) => {
  const { db } = await open(t)
  const before = len(db)

  const result = await db.tx(async (tx) => {
    await tx.put('messages', { text: 'one' })
    await tx.put('messages', { text: 'two' })
    await tx.put('messages', { text: 'three' })
    return 'done'
  })

  t.is(result, 'done', 'tx resolves to what the callback returned')
  t.alike(await texts(db), ['one', 'two', 'three'], 'all three rows landed')
  t.is(len(db), before + 3, 'appended together')
})

test('tx: a nested tx joins the outer batch', async (t) => {
  const { db } = await open(t)
  const before = len(db)

  await db.tx(async (outer) => {
    await outer.put('messages', { text: 'outer' })
    await outer.tx(async (inner) => {
      await inner.put('messages', { text: 'inner' })
    })
  })

  t.alike(await texts(db), ['outer', 'inner'], 'both rows landed')
  t.is(len(db), before + 2, 'appended together — the inner tx did not split the batch')
})

test('tx: fn must take the transaction handle', async (t) => {
  const { db } = await open(t)
  // a callback that ignores the handle would write to the db and lose atomicity
  await t.exception(
    db.tx(() => {}),
    /INVALID/
  )
})

// ─── all or nothing ───────────────────────────────────────────────────────

test('tx: a refused op rejects the whole transaction and appends nothing', async (t) => {
  const { db } = await open(t, 'reader')
  const before = len(db)

  await t.exception(
    db.tx(async (tx) => {
      await tx.put('messages', { text: 'nope' })
    }),
    /REFUSED/,
    'a reader cannot write, and hears about it'
  )

  t.alike(await texts(db), [], 'nothing landed')
  t.is(len(db), before, 'nothing was appended')
})

test('tx: one refused op takes its allowed siblings with it', async (t) => {
  const { db } = await open(t, 'member')

  // a member may add a reader, and may write messages — but may not evict
  const reader = await Identity.generate()
  await db.call('add-member', {
    id: reader.id,
    key: Identity.randomKeyPair().publicKey,
    role: 'reader',
    name: 'r',
    createdAt: 1,
    updatedAt: 1
  })
  const before = len(db)

  await t.exception(
    db.tx(async (tx) => {
      await tx.put('messages', { text: 'allowed on its own' })
      await tx.call('del-member', { id: reader.id })
    }),
    /REFUSED/
  )

  t.alike(await texts(db), [], 'the allowed put did not land either')
  t.ok((await db.get('members', reader.id)).data, 'and the reader is still a member')
  t.is(len(db), before, 'nothing was appended')
})

test('tx: a throwing callback appends nothing and the error propagates', async (t) => {
  const { db } = await open(t)
  const before = len(db)

  await t.exception(
    db.tx(async (tx) => {
      await tx.put('messages', { text: 'doomed' })
      throw new Error('boom')
    }),
    /boom/
  )

  t.alike(await texts(db), [], 'the put before the throw did not land')
  t.is(len(db), before, 'nothing was appended')
})

// ─── no-ops never reach the log ───────────────────────────────────────────

test('tx: a transaction that changes nothing appends nothing', async (t) => {
  const { db } = await open(t)
  const before = len(db)

  // set() itself short-circuits on a missing id before ever writing, so go
  // through call(): the op reaches the dry-run, whose handler finds no row and
  // touches nothing — a genuine no-op at the apply layer
  await db.tx(async (tx) => {
    await tx.call('set-messages', { id: 'ghost', text: 'x' })
  })

  t.absent((await db.get('messages', 'ghost')).data, 'no row')
  t.is(len(db), before, 'and no append for an op that did nothing')
})

test('tx: a no-op beside a real change still appends', async (t) => {
  const { db } = await open(t)
  const before = len(db)

  await db.tx(async (tx) => {
    await tx.call('set-messages', { id: 'ghost', text: 'x' })
    await tx.put('messages', { text: 'real' })
  })

  t.alike(await texts(db), ['real'], 'the real change landed')
  // the skip is whole-batch: a no-op still travels
  // with real changes rather than being dropped from the middle of a batch
  t.is(len(db), before + 2, 'the no-op rode along; nothing was dropped mid-batch')
})

// ─── ordering and lifecycle ───────────────────────────────────────────────

test('tx: concurrent transactions land in call order', async (t) => {
  const { db } = await open(t)

  await Promise.all([
    db.tx((tx) => tx.put('messages', { text: 'first' })),
    db.tx((tx) => tx.put('messages', { text: 'second' })),
    db.tx((tx) => tx.put('messages', { text: 'third' }))
  ])

  t.alike(await texts(db), ['first', 'second', 'third'], 'serialized in the order they were called')
})

test('tx: racing close settles as CLOSED, not a raw error', async (t) => {
  const { db } = await open(t)

  const closing = db.close()
  const err = await db
    .tx((tx) => tx.put('messages', { text: 'late' }))
    .then(
      () => null,
      (e) => e
    )
  await closing

  t.ok(err, 'the write did not silently succeed against a closing db')
  t.is(err.code, 'CLOSED', 'and it is a clean cero error')
})
