import test from 'brittle'
import process from 'process'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import { Readable } from 'streamx'

import { Storage } from '../../src/storage/index.js'
import { observe } from '../helpers/index.js'
import database from '../fixtures/spec/local/db/index.js'

const spec = {
  database,
  meta: {
    ns: 'cero',
    refs: {
      master: { kind: 'single' },
      keypair: { kind: 'single' },
      settings: { kind: 'single' },
      drafts: { kind: 'collection' },
      'handle-keypairs': { kind: 'collection' }
    }
  }
}

const backends = ['rocks', 'bee']

async function make(t, backend) {
  const dir = await t.tmp()
  const storage = Storage[backend](dir, { spec })
  await storage.ready()
  t.teardown(() => storage.close())
  return { storage, dir }
}

// ─── factories + lifecycle ───────────────────────────────────────────────────

for (const backend of backends) {
  test(`[${backend}] ready/close: opens and closes cleanly`, async (t) => {
    const dir = await t.tmp()
    const storage = Storage[backend](dir, { spec })
    await storage.ready()
    t.is(storage.opened, true)
    t.is(storage.closed, false)
    await storage.close()
    t.is(storage.closed, true)
  })

  test(`[${backend}] backend reports correct value`, async (t) => {
    const { storage } = await make(t, backend)
    t.is(storage.backend, backend)
  })

  test(`[${backend}] store exposes a Corestore`, async (t) => {
    const { storage } = await make(t, backend)
    t.ok(storage.store)
    t.is(typeof storage.store.ready, 'function')
    t.is(typeof storage.store.get, 'function')
  })

  test(`[${backend}] close is idempotent`, async (t) => {
    const dir = await t.tmp()
    const storage = Storage[backend](dir, { spec })
    await storage.ready()
    await storage.close()
    await storage.close()
    t.is(storage.closed, true)
  })

  // ─── put / set on single ───────────────────────────────────────────────────

  test(`[${backend}] set on single: insert then overwrite`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.set('settings', { entropy: b4a.from('a') })
    let r = await storage.get('settings')
    t.alike(r.data.entropy, b4a.from('a'))
    await storage.set('settings', { entropy: b4a.from('b') })
    r = await storage.get('settings')
    t.alike(r.data.entropy, b4a.from('b'))
  })

  test(`[${backend}] get on missing single returns null`, async (t) => {
    const { storage } = await make(t, backend)
    const { data } = await storage.get('settings')
    t.is(data, null)
  })

  test(`[${backend}] put on single also works (acts like set)`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.put('settings', { entropy: b4a.from('x') })
    const { data } = await storage.get('settings')
    t.alike(data.entropy, b4a.from('x'))
  })

  // ─── put / set on collection ───────────────────────────────────────────────

  test(`[${backend}] put on collection: stamps id, createdAt, updatedAt`, async (t) => {
    const { storage } = await make(t, backend)
    const { data } = await storage.put('drafts', { text: 'hello' })
    t.is(typeof data.id, 'string')
    t.is(typeof data.createdAt, 'number')
    t.is(typeof data.updatedAt, 'number')
    t.is(data.text, 'hello')
  })

  test(`[${backend}] put on collection: respects given id`, async (t) => {
    const { storage } = await make(t, backend)
    const { data } = await storage.put('drafts', { id: 'fixed-id', text: 'hi' })
    t.is(data.id, 'fixed-id')
  })

  test(`[${backend}] set on collection: insert then upsert by id`, async (t) => {
    const { storage } = await make(t, backend)
    const first = await storage.set('drafts', { id: 'x1', text: 'one' })
    t.is(first.data.id, 'x1')
    t.is(first.data.text, 'one')
    const created = first.data.createdAt
    await new Promise((r) => setTimeout(r, 5)) // ensure updatedAt differs
    const second = await storage.set('drafts', { id: 'x1', text: 'two' })
    t.is(second.data.text, 'two')
    t.is(second.data.createdAt, created)
    t.ok(second.data.updatedAt >= created)
  })

  test(`[${backend}] set merges with the existing row (does not wipe omitted fields)`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.set('drafts', { id: 'd1', text: 'keep' })
    await storage.set('drafts', { id: 'd1' }) // set without text
    const { data } = await storage.get('drafts', 'd1')
    t.is(data.text, 'keep', 'omitted field preserved by merge — Database.set parity')
  })

  test(`[${backend}] set { upsert: false } leaves a missing row untouched`, async (t) => {
    const { storage } = await make(t, backend)
    const res = await storage.set('drafts', { id: 'ghost', text: 'x' }, { upsert: false })
    t.is(res, null, 'returns null instead of creating the row')
    t.is((await storage.get('drafts', 'ghost')).data, null, 'did not create the row')
  })

  // ─── get on collection ─────────────────────────────────────────────────────

  test(`[${backend}] get(name, id) returns row or null`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.put('drafts', { id: 'a', text: 'A' })
    await storage.put('drafts', { id: 'b', text: 'B' })
    const r = await storage.get('drafts', 'a')
    t.is(r.data.id, 'a')
    t.is(r.data.text, 'A')
    const miss = await storage.get('drafts', 'nope')
    t.is(miss.data, null)
  })

  test(`[${backend}] get(name, query) returns paginated result`, async (t) => {
    const { storage } = await make(t, backend)
    for (let i = 0; i < 5; i++) {
      await storage.put('drafts', { id: `id-${i}`, text: `t${i}` })
    }
    const r = await storage.get('drafts', {})
    t.is(r.size, 5)
    t.is(r.total, 5)
    t.is(r.data.length, 5)
  })

  test(`[${backend}] get(name, { limit }) honors limit`, async (t) => {
    const { storage } = await make(t, backend)
    for (let i = 0; i < 5; i++) {
      await storage.put('drafts', { id: `id-${i}`, text: `t${i}` })
    }
    const r = await storage.get('drafts', { limit: 2 })
    t.is(r.size, 2)
    t.is(r.total, 5)
  })

  // hyperdb ignores equality fields, so they must be applied in memory or a
  // filtered get/count silently returns every row
  test(`[${backend}] get/count honor equality query fields`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.put('drafts', { id: 'a', text: 'x' })
    await storage.put('drafts', { id: 'b', text: 'y' })
    await storage.put('drafts', { id: 'c', text: 'x' })

    const r = await storage.get('drafts', { text: 'x' })
    t.is(r.size, 2, 'only matching rows')
    t.is(r.total, 2, 'total counts matches, not the collection')
    t.ok(r.data.every((d) => d.text === 'x'))

    const limited = await storage.get('drafts', { text: 'x', limit: 1 })
    t.is(limited.size, 1, 'limit applies after the filter')
    t.is(limited.total, 2)

    t.is((await storage.count('drafts', { text: 'y' })).data, 1)
    t.is((await storage.count('drafts', { text: 'nope' })).data, 0)
  })

  // ─── del ───────────────────────────────────────────────────────────────────

  test(`[${backend}] del removes a row from collection`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.put('drafts', { id: 'd1', text: 'gone' })
    await storage.del('drafts', 'd1')
    const r = await storage.get('drafts', 'd1')
    t.is(r.data, null)
  })

  test(`[${backend}] del on single clears it`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.set('settings', { entropy: b4a.from('z') })
    await storage.del('settings')
    const { data } = await storage.get('settings')
    t.is(data, null)
  })

  // ─── count ─────────────────────────────────────────────────────────────────

  test(`[${backend}] count returns total rows`, async (t) => {
    const { storage } = await make(t, backend)
    t.is((await storage.count('drafts')).data, 0)
    await storage.put('drafts', { id: 'c1', text: 'a' })
    await storage.put('drafts', { id: 'c2', text: 'b' })
    t.is((await storage.count('drafts')).data, 2)
  })

  // ─── watch ─────────────────────────────────────────────────────────────────

  test(`[${backend}] watch emits initial snapshot then updates`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.set('settings', { entropy: b4a.from('first') })

    const stream = storage.watch('settings')
    const observed = observe(t, stream, [
      (snap) => t.alike(snap.data.entropy, b4a.from('first')),
      (snap) => t.alike(snap.data.entropy, b4a.from('second'))
    ])

    await storage.set('settings', { entropy: b4a.from('second') })
    await observed

    stream.destroy()
  })

  test(`[${backend}] watch returns a Readable`, async (t) => {
    const { storage } = await make(t, backend)
    const stream = storage.watch('drafts', {})
    t.ok(stream instanceof Readable)
    stream.destroy()
  })

  // ─── persistence ───────────────────────────────────────────────────────────

  test(`[${backend}] persistence: data survives close + reopen`, async (t) => {
    const dir = await t.tmp()
    const s1 = Storage[backend](dir, { spec })
    await s1.ready()
    await s1.put('drafts', { id: 'persists', text: 'hi' })
    await s1.set('settings', { entropy: b4a.from('keep') })
    await s1.close()

    const s2 = Storage[backend](dir, { spec })
    await s2.ready()
    t.teardown(() => s2.close())
    const draft = await s2.get('drafts', 'persists')
    t.is(draft.data.text, 'hi')
    const settings = await s2.get('settings')
    t.alike(settings.data.entropy, b4a.from('keep'))
  })

  // ─── error cases ───────────────────────────────────────────────────────────

  test(`[${backend}] methods after close throw`, async (t) => {
    const dir = await t.tmp()
    const storage = Storage[backend](dir, { spec })
    await storage.ready()
    await storage.close()
    await t.exception.all(() => storage.put('drafts', { text: 'no' }), /closed/i)
    await t.exception.all(() => storage.get('settings'), /closed/i)
  })

  test(`[${backend}] methods before ready throw NOT_READY`, async (t) => {
    const dir = await t.tmp()
    const storage = Storage[backend](dir, { spec }) // constructed, never ready()
    await t.exception.all(() => storage.get('settings'), /not ready/i)
    await t.exception.all(() => storage.put('drafts', { text: 'x' }), /not ready/i)
    let code
    try {
      await storage.get('settings')
    } catch (e) {
      code = e.code
    }
    t.is(code, 'NOT_READY', 'a pre-ready read throws CeroError code NOT_READY')
  })

  test(`[${backend}] unknown collection name throws`, async (t) => {
    const { storage } = await make(t, backend)
    await t.exception.all(() => storage.put('nope', { text: 'x' }), /unknown ref/i)
    await t.exception.all(() => storage.get('nope'), /unknown ref/i)
  })
}

// ─── constructor validation (backend-agnostic) ─────────────────────────────

test('rocks: rejects missing spec', (t) => {
  t.exception.all(() => Storage.rocks('/tmp/x', {}), /spec\.database/)
})

test('bee: rejects missing spec', (t) => {
  t.exception.all(() => Storage.bee('/tmp/x', {}), /spec\.database/)
})

test('rocks: rejects empty dir', (t) => {
  t.exception.all(() => Storage.rocks('', { spec }), /dir, root, or store is required/)
})

// ─── storageKey (encryption at rest) ─────────────────────────────────────────

async function diskContains(dir, needle) {
  const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true })
  for (const e of entries) {
    if (!e.isFile()) continue
    const buf = await fs.promises.readFile(path.join(e.parentPath, e.name))
    if (buf.includes(needle)) return true
  }
  return false
}

test('bee: storageKey encrypts rows at rest', async (t) => {
  const key = b4a.alloc(32, 7)
  const marker = 'plaintext-canary-for-at-rest-scan'

  const plainDir = await t.tmp()
  const plain = Storage.bee(plainDir, { spec })
  await plain.ready()
  await plain.put('drafts', { text: marker })
  await plain.close()
  t.ok(await diskContains(plainDir, marker), 'control: plaintext store leaks the marker')

  const dir = await t.tmp()
  const enc = Storage.bee(dir, { spec, storageKey: key })
  await enc.ready()
  const { data } = await enc.put('drafts', { text: marker })
  await enc.close()
  t.absent(await diskContains(dir, marker), 'encrypted store does not leak the marker')

  const again = Storage.bee(dir, { spec, storageKey: key })
  await again.ready()
  t.teardown(() => again.close())
  const back = await again.get('drafts', data.id)
  t.is(back.data?.text, marker, 'same key reopens and reads back')
})

test('bee: wrong storageKey fails loud, never returns garbage', async (t) => {
  const dir = await t.tmp()
  const enc = Storage.bee(dir, { spec, storageKey: b4a.alloc(32, 7) })
  await enc.ready()
  await enc.put('drafts', { text: 'secret' })
  await enc.close()

  const wrong = Storage.bee(dir, { spec, storageKey: b4a.alloc(32, 8) })
  await t.exception.all(async () => {
    await wrong.ready()
    await wrong.get('drafts')
  })
  await wrong.close().catch(() => {})
})

test('bee: storage dir perms tightened to 0700', async (t) => {
  if (process.platform === 'win32') return t.pass('perms not enforced on windows')
  const { dir } = await make(t, 'bee')
  const mode = (await fs.promises.stat(dir)).mode & 0o777
  t.is(mode, 0o700)
})

test('storageKey validation: rocks backend and bad lengths rejected', (t) => {
  const key = b4a.alloc(32, 1)
  t.exception.all(() => Storage.rocks('/tmp/x', { spec, storageKey: key }), /bee backend/)
  t.exception.all(() => Storage.bee('/tmp/x', { spec, storageKey: b4a.alloc(16) }), /32 bytes/)
})

for (const backend of backends) {
  test(`[${backend}] get/count: search is a query operator, not an equality field`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.put('drafts', { text: 'José writes hello' })
    await storage.put('drafts', { text: 'unrelated row' })

    const { data } = await storage.get('drafts', { search: 'jose' })
    t.is(data.length, 1, 'search matched by folded substring')
    t.is(data[0].text, 'José writes hello')

    const { data: n } = await storage.count('drafts', { search: 'jose' })
    t.is(n, 1, 'count honors search')

    const { data: none } = await storage.get('drafts', { search: 'zzz' })
    t.is(none.length, 0, 'no match comes back empty')
  })
}

for (const backend of backends) {
  test(`[${backend}] get/count: equality on a bytes field matches by content`, async (t) => {
    const { storage } = await make(t, backend)
    const publicKey = b4a.alloc(32, 1)
    await storage.put('handle-keypairs', { id: 'a', publicKey, secretKey: b4a.alloc(64, 1) })
    await storage.put('handle-keypairs', {
      id: 'b',
      publicKey: b4a.alloc(32, 2),
      secretKey: b4a.alloc(64, 2)
    })

    const { data } = await storage.get('handle-keypairs', { publicKey: b4a.alloc(32, 1) })
    t.is(data.length, 1, 'a fresh buffer with the same bytes matches')
    t.is(data[0].id, 'a')
    t.is((await storage.count('handle-keypairs', { publicKey: b4a.alloc(32, 2) })).data, 1)
  })

  test(`[${backend}] get: id ranges and reverse apply with an equality field`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.put('drafts', { id: 'a', text: 'x' })
    await storage.put('drafts', { id: 'b', text: 'y' })
    await storage.put('drafts', { id: 'c', text: 'x' })

    const { data: after } = await storage.get('drafts', { text: 'x', gt: 'a' })
    t.alike(
      after.map((d) => d.id),
      ['c'],
      'gt narrows the equality matches'
    )

    const { data: reversed } = await storage.get('drafts', { text: 'x', reverse: true })
    t.alike(
      reversed.map((d) => d.id),
      ['c', 'a'],
      'reverse orders the equality matches'
    )

    t.is((await storage.count('drafts', { text: 'x', lte: 'a' })).data, 1, 'count honors the range')
  })

  test(`[${backend}] get: an id range alone reaches hyperdb as a key`, async (t) => {
    const { storage } = await make(t, backend)
    await storage.put('drafts', { id: 'a', text: 'x' })
    await storage.put('drafts', { id: 'b', text: 'y' })
    await storage.put('drafts', { id: 'c', text: 'x' })

    const { data } = await storage.get('drafts', { gt: 'a' })
    t.alike(
      data.map((d) => d.id),
      ['b', 'c'],
      'gt without an equality field'
    )
    t.is((await storage.count('drafts', { lte: 'b' })).data, 2, 'count without an equality field')
  })
}
