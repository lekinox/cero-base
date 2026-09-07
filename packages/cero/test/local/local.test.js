import test from 'brittle'
import b4a from 'b4a'

import { Local } from '../../src/local/index.js'
import { cero, open as openHandle } from '../../src/index.js'
import { put, set, get, del, watch } from '../../src/lib/operators.js'
import { spec } from '../fixtures/spec/index.js'
import { makeTestnet, observe } from '../helpers/index.js'

async function open(t) {
  const dir = await t.tmp()
  const local = new Local(dir, spec)
  await local.ready()
  t.teardown(() => local.close().catch(() => {}))
  return { local, dir }
}

// ─── construction ─────────────────────────────────────────────────────────

test('Local: rejects bad dir', (t) => {
  t.exception.all(() => new Local(), /dir/)
  t.exception.all(() => new Local('', spec), /dir/)
  t.exception.all(() => new Local(123, spec), /dir/)
})

test('Local: rejects spec without local', async (t) => {
  const dir = await t.tmp()
  t.exception.all(() => new Local(dir, {}), /spec\.local/)
  t.exception.all(() => new Local(dir, { local: {} }), /spec\.local\.database/)
})

// ─── lifecycle ────────────────────────────────────────────────────────────

test('Local: opens and closes', async (t) => {
  const { local } = await open(t)
  t.is(local.opened, true)
  await local.close()
  t.is(local.closed, true)
})

// ─── refs ─────────────────────────────────────────────────────────────────

test('Local: attaches user + local-builtin refs', async (t) => {
  const { local } = await open(t)
  t.ok(local.drafts)
  t.ok(local.settings)
  t.ok(local.master, 'master ref attached')
  t.ok(local.keypair, 'keypair ref attached')
  t.ok(local['handle-keypairs'], 'handle-keypairs ref attached')
})

// ─── operators ────────────────────────────────────────────────────────────

test('Local: put/get on a collection', async (t) => {
  const { local } = await open(t)
  const { data: row } = await put(local.drafts, { text: 'a' })
  t.ok(row.id)
  t.is(row.text, 'a')
  const { data: list } = await get(local.drafts)
  t.is(list.length, 1)
  t.is(list[0].text, 'a')
})

test('Local: set/get on a single', async (t) => {
  const { local } = await open(t)
  const entropy = b4a.from('abc')
  await set(local.settings, { entropy })
  const { data } = await get(local.settings)
  t.alike(data.entropy, entropy)
})

test('Local: del removes a row', async (t) => {
  const { local } = await open(t)
  const { data: row } = await put(local.drafts, { text: 'a' })
  await del(local.drafts, row.id)
  const { data: list } = await get(local.drafts)
  t.is(list.length, 0)
})

// ─── persistence ──────────────────────────────────────────────────────────

test('Local: persists across reopen', async (t) => {
  const dir = await t.tmp()

  let local = new Local(dir, spec)
  await local.ready()
  await put(local.drafts, { text: 'a' })
  await local.close()

  local = new Local(dir, spec)
  await local.ready()
  const { data: list } = await get(local.drafts)
  t.is(list.length, 1)
  t.is(list[0].text, 'a')
  await local.close()
})

// ─── pagination ───────────────────────────────────────────────────────────

test('Local: get with limit paginates', async (t) => {
  const { local } = await open(t)
  for (const c of ['a', 'b', 'c', 'd', 'e']) await put(local.drafts, { text: c })

  const { data: page, total, size } = await get(local.drafts, { limit: 3 })
  t.is(total, 5, 'total counts all rows')
  t.is(size, 3, 'size = returned rows')
  t.is(page.length, 3)
})

test('Local: get with reverse flips order', async (t) => {
  const { local } = await open(t)
  for (const c of ['a', 'b', 'c']) await put(local.drafts, { text: c })

  const { data: fwd } = await get(local.drafts)
  const { data: rev } = await get(local.drafts, { reverse: true })
  t.alike(
    rev.map((r) => r.text),
    fwd.map((r) => r.text).reverse()
  )
})

// ─── envelope shapes ──────────────────────────────────────────────────────

test('Local: get(empty collection) → { data: [], total: 0, size: 0 }', async (t) => {
  const { local } = await open(t)
  const result = await get(local.drafts)
  t.alike(Object.keys(result).sort(), ['data', 'size', 'total'])
  t.alike(result.data, [])
  t.is(result.total, 0)
  t.is(result.size, 0)
})

test('Local: get(empty singleton) → { data: null }', async (t) => {
  const { local } = await open(t)
  const { data } = await get(local.settings)
  t.is(data, null)
})

test('Local: get(unknown id) → { data: null }', async (t) => {
  const { local } = await open(t)
  await put(local.drafts, { text: 'a' })
  const { data } = await get(local.drafts, 'no-such-id')
  t.is(data, null)
})

// ─── watch ────────────────────────────────────────────────────────────────

test('Local: watch emits initial snapshot then on updates', async (t) => {
  const { local } = await open(t)
  const stream = watch(local.drafts)

  const observed = observe(t, stream, [
    (snap) => t.alike(snap.data, []),
    (snap) => {
      t.is(snap.data.length, 1)
      t.is(snap.data[0].text, 'a')
    }
  ])

  await put(local.drafts, { text: 'a' })
  await observed

  stream.destroy()
})

test('Local: destroyed watch stream stops emitting', async (t) => {
  const { local } = await open(t)
  const stream = watch(local.drafts)
  await observe(t, stream, [(snap) => t.alike(snap.data, [])]) // consume initial; breaking the loop destroys the stream
  t.ok(stream.destroyed, 'the consumer stopping destroyed the stream')
  await put(local.drafts, { text: 'a' }) // must not throw / emit after destroy
  t.pass('no emission after destroy')
})

test('Local: two dirs are independent', async (t) => {
  const dirA = await t.tmp()
  const dirB = await t.tmp()
  const a = new Local(dirA, spec)
  const b = new Local(dirB, spec)
  await Promise.all([a.ready(), b.ready()])
  t.teardown(() => a.close().catch(() => {}))
  t.teardown(() => b.close().catch(() => {}))

  await put(a.drafts, { text: 'only-in-a' })
  const { data } = await get(b.drafts)
  t.is(data.length, 0)
})

// ─── cross-scope isolation ────────────────────────────────────────────────

test('cross-scope: local writes do not appear in root and vice versa', async (t) => {
  const dir = await t.tmp()
  const testnet = await makeTestnet(t)
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })

  await put(me.local.drafts, { text: 'local-only' })
  await put(me.messages, { text: 'root-only' })

  const localRows = (await get(me.local.drafts)).data
  const rootRows = (await get(me.messages)).data
  t.is(localRows.length, 1)
  t.is(rootRows.length, 1)
  t.is(localRows[0].text, 'local-only')
  t.is(rootRows[0].text, 'root-only')
})

test('cross-scope: two opened handles are isolated', async (t) => {
  const dir = await t.tmp()
  const testnet = await makeTestnet(t)
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })

  const teamA = await openHandle(me.team, { name: 'A' })
  const teamB = await openHandle(me.team, { name: 'B' })

  await put(teamA.messages, { text: 'from-A' })
  await put(teamB.messages, { text: 'from-B' })

  const aRows = (await get(teamA.messages)).data
  const bRows = (await get(teamB.messages)).data
  t.is(aRows.length, 1)
  t.is(bRows.length, 1)
  t.is(aRows[0].text, 'from-A')
  t.is(bRows[0].text, 'from-B')
})

test('cross-scope: opened handle does not see root rows', async (t) => {
  const dir = await t.tmp()
  const testnet = await makeTestnet(t)
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })

  await put(me.messages, { text: 'root-msg' })
  const team = await openHandle(me.team, { name: 'sub' })
  const { data } = await get(team.messages)
  t.is(data.length, 0, 'team has its own messages collection — root rows not visible')
})
