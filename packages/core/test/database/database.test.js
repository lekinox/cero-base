import test from 'brittle'
import b4a from 'b4a'
import z32 from 'z32'
import { Readable } from 'streamx'

import { Database } from '../../src/database/index.js'
import { Identity } from '../../src/identity/index.js'
import { Network } from '../../src/network/index.js'
import hid from 'hypercore-id-encoding'
import Hypercore from 'hypercore'
import { genId } from '../../src/lib/ids.js'
import { admission } from '../../src/lib/utils.js'
import {
  makeTestnet,
  makeStore,
  randomTopic,
  observe,
  waitForConnection,
  waitFor,
  collect,
  replay
} from '../helpers/index.js'
import { spec } from '../fixtures/spec/index.js'

test.configure({ timeout: 60000 })

// ─── helpers ──────────────────────────────────────────────────────────────

async function makeDb(t, opts = {}) {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = opts.identity || (await Identity.generate())
  const db = new Database({ store, identity, spec, ...opts })
  await db.ready()
  t.teardown(() => db.close().catch(() => {}), { order: 5 })
  return { db, store, identity }
}

async function bootstrapped(t, opts = {}) {
  const { db, store, identity } = await makeDb(t, opts)
  await db.bootstrap({ name: 'first', isMobile: false })
  await enroll(db, identity)
  return { db, store, identity }
}

// every real open lands the member row with the writer; the fixture does the same
async function enroll(db, identity, role = 'owner') {
  const ts = Date.now()
  await db.call('add-member', {
    id: identity.id,
    key: db.writerKey,
    role,
    createdAt: ts,
    updatedAt: ts
  })
}

async function makeNetworked(t, testnet, opts = {}) {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = opts.identity || (await Identity.generate())
  const { presence, ...rest } = opts
  const network = new Network({ bootstrap: testnet.bootstrap, presence })
  await network.ready()
  const topic = opts.topic || identity.topic
  const discovery = network.join(topic)
  await discovery.flush()
  const db = new Database({ store, identity, network, spec, ...rest })
  await db.ready()
  t.teardown(
    async () => {
      try {
        await db.close()
      } catch {}
      try {
        await discovery.destroy()
      } catch {}
      try {
        await network.close()
      } catch {}
    },
    { order: 5 }
  )
  return { db, store, identity, network, discovery, topic }
}

// ─── construction validation ──────────────────────────────────────────────

test('constructor: rejects missing store', async (t) => {
  t.exception.all(() => new Database({ identity: {}, spec }), /store is required/)
})

test('constructor: rejects missing identity', async (t) => {
  const { store } = await makeStore(t)
  t.exception.all(() => new Database({ store, spec }), /identity is required/)
})

test('constructor: rejects missing spec', async (t) => {
  const { store } = await makeStore(t)
  const identity = await Identity.generate()
  t.exception.all(() => new Database({ store, identity }), /spec/)
})

test('constructor: rejects spec without dispatch', async (t) => {
  const { store } = await makeStore(t)
  const identity = await Identity.generate()
  t.exception.all(
    () => new Database({ store, identity, spec: { database: spec.database } }),
    /spec/
  )
})

test('constructor: refuses the identity keypair as the writer', async (t) => {
  const { store } = await makeStore(t)
  const identity = await Identity.generate()
  const keyPair = { publicKey: identity.publicKey, secretKey: identity.secretKey }
  t.exception.all(() => new Database({ store, identity, spec, keyPair }), /device keypair/)
})

test('constructor: mints a device keypair of its own by default', async (t) => {
  const { db, identity } = await makeDb(t)
  t.absent(b4a.equals(db.keyPair.publicKey, identity.publicKey), 'never the identity keypair')
})

// ─── lifecycle ────────────────────────────────────────────────────────────

test('ready/close: opens and closes cleanly', async (t) => {
  const { store } = await makeStore(t)
  const identity = await Identity.generate()
  const db = new Database({ store, identity, spec })
  await db.ready()
  t.is(db.opened, true)
  t.ok(db.bee)
  t.ok(db.key)
  t.ok(db.discoveryKey)
  await db.close()
  t.is(db.closed, true)
  t.is(db.bee, null)
})

// the wakeup protocol is shared by every open database; closing one must not
// tear it down for the others
test('close: one database does not destroy the network-shared wakeup', async (t) => {
  const testnet = await makeTestnet(t)
  const network = new Network({ bootstrap: testnet.bootstrap })
  await network.ready()
  t.teardown(() => network.close().catch(() => {}), { order: 9 })

  const identity = await Identity.generate()
  const mk = async () => {
    const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
    const db = new Database({ store, identity, network, spec })
    await db.ready()
    return db
  }
  const a = await mk()
  const b = await mk()
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  await b.bootstrap({ name: 'b' })

  await a.close()
  t.is(b.bee._wakeup._session.destroyed, false, "sibling's wakeup session survived the close")
  const { data: row } = await b.put('messages', { text: 'still alive' })
  t.is((await b.get('messages', row.id)).data.text, 'still alive', 'sibling database unaffected')
})

// corestore replication is store-wide: one replicate call per connection,
// however many databases share the store
test('replicate: N databases on one store replicate it once per connection', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const network = new Network({ bootstrap: testnet.bootstrap })
  await network.ready()
  t.teardown(() => network.close().catch(() => {}), { order: 9 })

  const identity = await Identity.generate()
  const mkDb = async (ns) => {
    const db = new Database({
      store,
      identity,
      network,
      spec,
      namespace: ns,
      keyPair: Identity.randomKeyPair()
    })
    await db.ready()
    t.teardown(() => db.close().catch(() => {}), { order: 5 })
    return db
  }
  await mkDb('a')
  await mkDb('b')

  const peer = new Network({ bootstrap: testnet.bootstrap })
  await peer.ready()
  t.teardown(() => peer.close().catch(() => {}), { order: 9 })
  await network.join(topic).flush()
  await peer.join(topic).flush()
  await waitForConnection(network)
  await new Promise((r) => setTimeout(r, 100))

  t.is(store.streamTracker.records.length, 1, 'one stream record despite two attached bees')
})

test('close is idempotent', async (t) => {
  const { store } = await makeStore(t)
  const identity = await Identity.generate()
  const db = new Database({ store, identity, spec })
  await db.ready()
  await db.close()
  await db.close()
  t.is(db.closed, true)
})

test('close detaches the bee from the network (no _replicateables leak)', async (t) => {
  const testnet = await makeTestnet(t)
  const { db, network } = await makeNetworked(t, testnet)
  t.is(network._replicateables.size, 1, 'bee attached on open')
  await db.close()
  t.is(network._replicateables.size, 0, 'bee detached on close — not left to replicate forever')
})

test('bootstrap recovering: times out instead of hanging when no peer replicates', async (t) => {
  const testnet = await makeTestnet(t)
  const { db } = await makeNetworked(t, testnet)
  const before = db.bee.local.listenerCount('append')
  await t.exception(db.bootstrap({ recovering: true, timeout: 200 }), /timed out/)
  t.is(db.bee.local.listenerCount('append'), before, 'append listener removed — no leak')
})

// The autobee contract: a writable core has exactly one author, ever — resuming
// a replicated core silently drops appends. Recovery therefore never appends on
// the backfilled genesis core: it swaps to a fresh device core first and
// self-admits via an optimistic master-signed add-writer. Pinned here in its
// hardest shape: the only surviving peer is a passive reader (a mirror), every
// writer is dead, and the recovered history must stay canonical.
test('bootstrap recovering: fresh core recovers from a passive reader after every writer died', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })
  await a.db.put('messages', { text: 'pre-disaster' })

  // passive reader (mirror stand-in): unrelated identity, never a writer
  const reader = await Identity.generate()
  const o = await makeNetworked(t, testnet, {
    identity: reader,
    topic,
    key: a.db.key,
    encryptionKey: identity.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(o.network)
  await waitUntil(async () => {
    const { data } = await o.db.get('messages')
    return data.length === 1 || null
  })

  // disaster: the only writer dies — its data survives only on the reader
  await a.db.close()
  await a.network.close()

  const b = await makeNetworked(t, testnet, { identity, topic, key: a.db.key })
  await b.db.bootstrap({ name: 'b', recovering: true })
  t.ok(b.db.bee.writable, 'recovered device is writable with zero live writers')
  t.absent(
    b4a.equals(b.db.writerKey, b.db.bee.key),
    'local writer is a fresh device core, not the genesis core'
  )

  const { data: rows } = await b.db.get('messages')
  t.is(rows.length, 1, 'recovered the pre-disaster data')
  await b.db.put('messages', { text: 'post-recovery' })

  const seen = await waitUntil(async () => {
    const { data } = await o.db.get('messages')
    return data.length === 2 ? data : null
  })
  t.is(seen.length, 2, "the reader accepts the recovered device's history as canonical")
})

test('escape hatches expose underlying bee', async (t) => {
  const { db } = await makeDb(t)
  t.ok(db.bee)
  t.ok(b4a.isBuffer(db.key))
  t.ok(b4a.isBuffer(db.discoveryKey))
  t.is(typeof db.writable, 'boolean')
  t.is(typeof db.length, 'number')
})

// ─── operator surface: collection ─────────────────────────────────────────

test('put on collection: stamps id, createdAt, updatedAt', async (t) => {
  const { db } = await bootstrapped(t)
  const { data } = await db.put('messages', { text: 'hi' })
  t.is(typeof data.id, 'string')
  t.is(typeof data.createdAt, 'number')
  t.is(typeof data.updatedAt, 'number')
  t.is(data.text, 'hi')
})

test('put → get round-trip by id', async (t) => {
  const { db } = await bootstrapped(t)
  const { data: row } = await db.put('messages', { text: 'hello' })
  const { data: got } = await db.get('messages', row.id)
  t.is(got.id, row.id)
  t.is(got.text, 'hello')
})

test('put respects given id', async (t) => {
  const { db } = await bootstrapped(t)
  const { data } = await db.put('messages', { id: 'fixed', text: 'x' })
  t.is(data.id, 'fixed')
})

test('get on missing id returns null', async (t) => {
  const { db } = await bootstrapped(t)
  const { data } = await db.get('messages', 'missing')
  t.is(data, null)
})

test('get on collection returns paginated results', async (t) => {
  const { db } = await bootstrapped(t)
  for (let i = 0; i < 5; i++) {
    await db.put('messages', { id: `id-${i}`, text: `t${i}` })
  }
  const r = await db.get('messages', {})
  t.is(r.size, 5)
  t.is(r.total, 5)
  t.is(r.data.length, 5)
})

test('get with limit query', async (t) => {
  const { db } = await bootstrapped(t)
  for (let i = 0; i < 5; i++) {
    await db.put('messages', { id: `id-${i}`, text: `t${i}` })
  }
  const r = await db.get('messages', { limit: 2 })
  t.is(r.size, 2)
  t.is(r.total, null, 'limited read skips the count (T2.1 lazy total)')
  t.is((await db.get('messages', { limit: 2, total: true })).total, 5, 'total: true pays for it')
})

test('get returns a collection in index (insertion) order', async (t) => {
  const { db } = await bootstrapped(t)
  const texts = ['a', 'b', 'c', 'd', 'e']
  for (const text of texts) await db.put('messages', { text })
  const { data } = await db.get('messages')
  t.alike(
    data.map((m) => m.text),
    texts,
    'rows come back in insertion order, not random id order'
  )
  const ascending = data.every((m, i) => i === 0 || m.index > data[i - 1].index)
  t.ok(ascending, 'sorted by ascending index')
})

test('set on collection: upsert by id', async (t) => {
  const { db } = await bootstrapped(t)
  const first = await db.set('messages', { id: 'm1', text: 'one' })
  t.is(first.data.id, 'm1')
  t.is(first.data.text, 'one')
  const created = first.data.createdAt
  await new Promise((r) => setTimeout(r, 5))
  const second = await db.set('messages', { id: 'm1', text: 'two' })
  t.is(second.data.text, 'two')
  t.is(second.data.createdAt, created)
  t.ok(second.data.updatedAt >= created)
})

test('set on collection: { upsert: false } is update-only', async (t) => {
  const { db } = await bootstrapped(t)
  const miss = await db.set('messages', { id: 'ghost', text: 'nope' }, { upsert: false })
  t.is(miss, null, 'returns null on a missing row')
  t.is((await db.get('messages', 'ghost')).data, null, 'did not create the row')

  const { data: row } = await db.put('messages', { text: 'one' })
  await db.set('messages', { id: row.id, text: 'two' }, { upsert: false })
  t.is((await db.get('messages', row.id)).data.text, 'two', 'updated the existing row')
})

test('set-<verb> dispatch does not resurrect a missing or deleted row', async (t) => {
  const { db } = await bootstrapped(t)
  // db.call bypasses set()'s local short-circuit and hits the dispatch update() guard
  await db.call('set-messages', { id: 'ghost', text: 'nope' })
  t.is((await db.get('messages', 'ghost')).data, null, 'dispatch guard suppressed a missing-id set')

  const { data: row } = await db.put('messages', { text: 'one' })
  await db.del('messages', row.id)
  await db.call('set-messages', { id: row.id, text: 'revived' })
  t.is(
    (await db.get('messages', row.id)).data,
    null,
    'a deleted row stays deleted under a replayed set'
  )
})

test('set-member is a no-op on a missing id (resurrection guard)', async (t) => {
  const { db } = await bootstrapped(t)
  await db.call('set-member', {
    id: 'no-such-member',
    key: db.writerKey,
    role: 'owner',
    name: 'ghost',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  t.is((await db.get('members', 'no-such-member')).data, null, 'set-member did not create a member')
})

test('del removes a row from collection', async (t) => {
  const { db } = await bootstrapped(t)
  const { data: row } = await db.put('messages', { text: 'gone' })
  await db.del('messages', row.id)
  const { data } = await db.get('messages', row.id)
  t.is(data, null)
})

test("set: concurrent sets on a single keep each other's fields", async (t) => {
  const { db } = await bootstrapped(t)
  const avatar = b4a.from('img')
  await Promise.all([db.set('profile', { name: 'a' }), db.set('profile', { avatar })])
  const { data } = await db.get('profile')
  t.is(data.name, 'a', 'first field kept')
  t.ok(b4a.equals(data.avatar, avatar), 'second field kept')
})

test('watch and changes streams detach their update listener on destroy', async (t) => {
  const { db } = await bootstrapped(t)
  const base = db.listenerCount('update')
  const streams = [db.watch('messages'), db.changes('messages'), db.watch('messages', { limit: 1 })]
  t.is(db.listenerCount('update'), base + 3, 'one listener per stream')
  for (const s of streams) s.destroy()
  await Promise.all(streams.map((s) => new Promise((r) => s.once('close', r))))
  t.is(db.listenerCount('update'), base, 'all detached')
})

test('total counts the rows', async (t) => {
  const { db } = await bootstrapped(t)
  t.is((await db.get('messages')).total, 0)
  await db.put('messages', { text: 'a' })
  await db.put('messages', { text: 'b' })
  t.is((await db.get('messages')).total, 2)
})

test('total follows the range', async (t) => {
  const { db } = await bootstrapped(t)
  for (let i = 0; i < 5; i++) await db.put('messages', { id: `id-${i}`, text: `t${i}` })
  t.is((await db.get('messages')).total, 5, 'no query → total')
  t.is((await db.get('messages', { gt: 'id-1' })).total, 3, 'gt filters the total')
  t.is((await db.get('messages', { lt: 'id-2' })).total, 2, 'lt filters the total')
  t.is((await db.get('messages', { limit: 2 })).total, null, 'a full page skips the count')
})

test('tx: concurrent transactions are isolated — a failing one does not drop the other', async (t) => {
  const { db } = await bootstrapped(t)
  const [a, b] = await Promise.allSettled([
    db.tx(async (tx) => {
      await tx.put('messages', { id: 'fail-row', text: 'x' })
      throw new Error('boom')
    }),
    db.tx(async (tx) => {
      await tx.put('messages', { id: 'ok-row', text: 'keep' })
    })
  ])
  t.is(a.status, 'rejected', 'failing tx rejected')
  t.is(b.status, 'fulfilled', 'other tx resolved')
  t.is((await db.get('messages', 'ok-row')).data?.text, 'keep', "the other tx's write survived")
  t.is((await db.get('messages', 'fail-row')).data, null, 'failed tx rolled back')
})

test('del on a single wipes the row (Storage parity, honors the doc)', async (t) => {
  const { db } = await bootstrapped(t)
  await db.set('profile', { name: 'jb' })
  t.is((await db.get('profile')).data.name, 'jb', 'profile set')
  await db.del('profile')
  t.is((await db.get('profile')).data, null, 'profile wiped after del — no NONEXISTENT_ROUTE')
})

// "latest N" must not scan the whole collection — it reads off the
// implicit order index, and total goes lazy on limited reads.
test('get: reverse/limit reads push down to the order index (bounded read)', async (t) => {
  const { db } = await bootstrapped(t)
  for (let i = 0; i < 5; i++) await db.put('messages', { text: `m${i}` })

  const calls = []
  const view = db.view
  const orig = view.find.bind(view)
  view.find = (path, ...args) => (calls.push(path), orig(path, ...args))
  const r = await db.get('messages', { reverse: true, limit: 2 })
  view.find = orig

  t.alike(
    r.data.map((m) => m.text),
    ['m4', 'm3'],
    'latest first, index order'
  )
  t.is(r.total, null, 'full page → total skipped')
  t.ok(
    calls.every((p) => p.endsWith('/messages-index')),
    'served from the order index only, no collection scan'
  )

  const partial = await db.get('messages', { reverse: true, limit: 10 })
  t.is(partial.total, 5, 'non-full page → set exhausted, total free')

  const forced = await db.get('messages', { reverse: true, limit: 2, total: true })
  t.is(forced.total, 5, 'total: true forces the full count')

  const plain = await db.get('messages')
  t.is(plain.total, 5, 'unlimited read keeps an exact total')
  t.alike(
    plain.data.map((m) => m.text),
    ['m0', 'm1', 'm2', 'm3', 'm4'],
    'default order unchanged'
  )
})

// ─── field validation ───────────────────────────────────────────────────────

test('put: rejects an undeclared field instead of silently dropping it', async (t) => {
  const { db } = await bootstrapped(t)
  await t.exception(
    db.put('messages', { text: 'hi', bogus: 'x' }),
    /unknown field 'bogus'/,
    'fails loud — the result would otherwise lie about a dropped field'
  )
})

test('set: rejects an undeclared field on a single', async (t) => {
  const { db } = await bootstrapped(t)
  await t.exception(db.set('profile', { name: 'jb', nope: 1 }), /unknown field 'nope'/)
})

test('put: accepts declared + system fields', async (t) => {
  const { db } = await bootstrapped(t)
  const { data } = await db.put('messages', { id: 'm1', text: 'hi', attachment: b4a.from('a') })
  t.is(data.text, 'hi', 'declared user fields + system id accepted')
  t.is(data.id, 'm1')
})

// ─── action routing ─────────────────────────────────────────────────────────

async function teamDb(t, routes) {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = await Identity.generate()
  const db = new Database({ store, identity, spec: spec.handles.team, routes })
  await db.ready()
  t.teardown(() => db.close().catch(() => {}), { order: 5 })
  await db.bootstrap({ name: 'first', isMobile: false })
  return db
}

test('call: a declared action with no route throws (not a silent no-op)', async (t) => {
  const db = await teamDb(t)
  await t.exception(
    db.call('promote', { memberId: 'm', role: 'admin' }),
    /action 'promote' has no route/,
    'fails loud instead of writing a dead op'
  )
})

test('call: a declared action with a registered route succeeds', async (t) => {
  const db = await teamDb(t, { promote: async () => {} })
  await db.call('promote', { memberId: 'm', role: 'admin' })
  t.pass('routed action call did not throw')
})

test('call: a route gets the hook ctx and writes through it', async (t) => {
  const db = await teamDb(t, {
    promote: async ({ row, memberId, role, get, put }) => {
      const { data: before } = await get('notes', { text: row.memberId })
      await put('notes', { text: `${row.memberId}:${row.role}:${before.length}:${role}` })
      await put('notes', { text: 'second' })
      t.ok(memberId, 'ctx carries the signer')
    }
  })
  await db.call('promote', { memberId: 'm', role: 'admin' })
  const { data } = await db.get('notes')
  t.alike(
    data.map((n) => n.text),
    ['m:admin:0:owner', 'second'],
    'the route read and wrote the room through ctx'
  )
  t.ok(
    data.every((n) => n.id.length > 0),
    'hook writes get ids'
  )
  t.not(data[0].id, data[1].id, 'two writes in one op get distinct ids')
  t.alike(
    data.map((n) => n.index),
    [1, 2],
    'hook writes take the collection index in write order'
  )
})

test('call: rows a route writes get the same ids on every peer', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const routes = {
    promote: async ({ row, put }) => put('notes', { text: `promoted ${row.memberId}` })
  }
  const a = await makeNetworked(t, testnet, { topic, spec: spec.handles.team, routes })
  await a.db.bootstrap({ name: 'a' })
  const b = await makeNetworked(t, testnet, {
    identity: await Identity.generate(),
    topic,
    spec: spec.handles.team,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey,
    routes
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)
  await a.db.call('promote', { memberId: 'm', role: 'admin' })
  const onA = (await a.db.get('notes')).data
  const onB = await waitFor(async () => {
    const { data } = await b.db.get('notes')
    return data.length === onA.length ? data : null
  })
  t.is(onA.length, 1)
  t.alike(onB, onA, 'identical row, id included, derived independently on B')
})

test('a writer is always a member: admitting one for an unknown member is refused', async (t) => {
  const { db, store } = await bootstrapped(t)
  const stranger = Identity.randomKeyPair()
  const core = Hypercore.key({
    version: store.manifestVersion,
    signers: [{ publicKey: stranger.publicKey }]
  })
  await t.exception(db.addWriter(stranger.publicKey, 'nobody'), /REFUSED/)
  t.absent((await db.get('devices', hid.encode(core))).data, 'no device row')
  // without a member the key is admitted as another device of this identity
  await db.addWriter(stranger.publicKey)
  const { data: device } = await db.get('devices', hid.encode(core))
  t.is(device.memberId, db.identity.id, 'bound to the admitting identity')
})

test('call: a route that throws refuses the action', async (t) => {
  const db = await teamDb(t, {
    promote: async ({ row }) => {
      if (row.role === 'god') throw new Error('no such rank')
    }
  })
  await t.exception(db.call('promote', { memberId: 'm', role: 'god' }), /REFUSED/)
  await db.call('promote', { memberId: 'm', role: 'admin' })
  t.pass('a passing route still applies')
})

test('call: an operator called inside a route throws INVALID', async (t) => {
  let err = null
  const db = await teamDb(t, {
    promote: async () => {
      try {
        await db.put('notes', { text: 'x' })
      } catch (e) {
        err = e
      }
    }
  })
  await db.call('promote', { memberId: 'm', role: 'admin' })
  t.is(err?.code, 'INVALID', 'cero operators are off limits inside a route')
})

test('apply event: fires per applied op with op/name/row/writerKey, and unsubscribes', async (t) => {
  const { db } = await bootstrapped(t)
  const seen = []
  const push = (e) => seen.push(e)
  db.on('apply', push)
  const off = () => db.off('apply', push)
  await db.put('messages', { text: 'a' })
  await db.put('messages', { text: 'b' })
  t.ok(seen.length >= 2, 'fired for each applied op')
  const e = seen.find((x) => x.name === 'messages' && x.row?.text === 'a')
  t.ok(e, 'carries the ref name + decoded row')
  t.is(e.op, 'add', 'op is the dispatch verb prefix')
  t.ok(e.writerKey, 'carries the writerKey (works for local + replicated)')
  t.is(typeof e.seq, 'number', 'carries a monotonic seq')
  off()
  const n = seen.length
  await db.put('messages', { text: 'c' })
  t.is(seen.length, n, 'no fire after unsubscribe')
})

test('apply event: zero cost when nobody listens', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { text: 'x' }) // apply runs the gated path with no subscriber
  t.is((await db.get('messages')).data.length, 1, 'op still applied normally')
})

// Remote case: apply processes the MERGED log, so 'apply' fires for a peer's ops
// too, carrying that peer's writerKey. Same shape as the passing A → B replication
// tests above (shared identity, recovering peer, waitUntil on B).
test('apply event: fires for REMOTE ops with the remote writerKey (two-peer)', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()
  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })
  const b = await makeNetworked(t, testnet, { identity, topic, key: a.db.key })
  await b.db.bootstrap({ recovering: true })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  const seen = []
  b.db.on('apply', (e) => seen.push(e))
  await a.db.put('messages', { text: 'from-a' })

  const e = await waitUntil(
    () => seen.find((x) => x.name === 'messages' && x.row?.text === 'from-a') || null
  )
  t.ok(e, "B observed A's op via apply on the merged log")
  t.ok(b4a.equals(e.writerKey, a.db.writerKey), "event carries A's writerKey, not B's")
})

test('set on an existing row keeps its index (no reorder)', async (t) => {
  const { db } = await bootstrapped(t)
  for (const id of ['m0', 'm1', 'm2']) await db.put('messages', { id, text: id })
  const before = (await db.get('messages')).data
  const idxM1 = before.find((r) => r.id === 'm1').index
  await db.set('messages', { id: 'm1', text: 'edited' }) // updates the middle row
  const after = (await db.get('messages')).data
  t.alike(
    after.map((r) => r.id),
    ['m0', 'm1', 'm2'],
    'editing a row does not reorder the collection'
  )
  t.is(after.find((r) => r.id === 'm1').text, 'edited', 'value updated')
  t.is(after.find((r) => r.id === 'm1').index, idxM1, 'edited row keeps its original index')
})

test('re-putting a deleted id lands at the end with a fresh index', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'a', text: 'a1' })
  await db.put('messages', { id: 'b', text: 'b1' })
  await db.del('messages', 'a')
  await db.put('messages', { id: 'a', text: 'a2' })
  const { data } = await db.get('messages')
  t.alike(
    data.map((r) => r.id),
    ['b', 'a'],
    're-put of a deleted id sorts to the end'
  )
  const a = data.find((r) => r.id === 'a')
  const b = data.find((r) => r.id === 'b')
  t.ok(a.index > b.index, 'reinserted row gets a fresh advancing index')
  t.is(a.text, 'a2', 'carries the new payload')
})

test('get range queries: gt / gte / lt / lte', async (t) => {
  const { db } = await bootstrapped(t)
  for (let i = 0; i < 5; i++) await db.put('messages', { id: `id-${i}`, text: `t${i}` })
  const ids = (r) => r.data.map((x) => x.id)
  t.alike(
    ids(await db.get('messages', { gt: 'id-1' })),
    ['id-2', 'id-3', 'id-4'],
    'gt is exclusive'
  )
  t.alike(
    ids(await db.get('messages', { gte: 'id-1' })),
    ['id-1', 'id-2', 'id-3', 'id-4'],
    'gte is inclusive'
  )
  t.alike(
    ids(await db.get('messages', { lt: 'id-3' })),
    ['id-0', 'id-1', 'id-2'],
    'lt is exclusive'
  )
  t.alike(
    ids(await db.get('messages', { lte: 'id-3' })),
    ['id-0', 'id-1', 'id-2', 'id-3'],
    'lte is inclusive'
  )
  t.alike(
    ids(await db.get('messages', { gt: 'id-0', lt: 'id-3' })),
    ['id-1', 'id-2'],
    'bounds compose'
  )
})

test('get search: case-insensitive substring across string fields', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'm1', text: 'Hello world' })
  await db.put('messages', { id: 'm2', text: 'help me' })
  await db.put('messages', { id: 'm3', text: 'goodbye' })
  const r = await db.get('messages', { search: 'hel' })
  t.alike(r.data.map((m) => m.id).sort(), ['m1', 'm2'], 'substring match, case-insensitive')
  t.is(r.total, 2, 'total counts the matches')
})

test('get search: matches any string field (e.g. id/code)', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'abc-1', text: 'x' })
  await db.put('messages', { id: 'abc-2', text: 'y' })
  await db.put('messages', { id: 'zzz-1', text: 'z' })
  const r = await db.get('messages', { search: 'abc' })
  t.alike(r.data.map((m) => m.id).sort(), ['abc-1', 'abc-2'])
})

test('get search: composes with limit (pagination)', async (t) => {
  const { db } = await bootstrapped(t)
  for (let i = 0; i < 6; i++) await db.put('messages', { id: `m${i}`, text: `room ${i}` })
  await db.put('messages', { id: 'x', text: 'other' })
  const r = await db.get('messages', { search: 'room', limit: 3 })
  t.is(r.data.length, 3, 'page capped to limit')
  t.is(r.total, 6, 'total counts the matches, not the page')
})

test('get search: no match returns an empty page', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'm1', text: 'hello' })
  const r = await db.get('messages', { search: 'zzz' })
  t.is(r.data.length, 0)
})

test('get search: substring matches inside a field', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'm1', text: 'John Smith' })
  await db.put('messages', { id: 'm2', text: 'Bob Jones' })
  const r = await db.get('messages', { search: 'smith' })
  t.alike(
    r.data.map((m) => m.id),
    ['m1'],
    "'smith' is a substring of 'John Smith'"
  )
})

test('get search: every term must match (AND)', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'm1', text: 'John Smith' })
  await db.put('messages', { id: 'm2', text: 'John Doe' })
  const r = await db.get('messages', { search: 'jo sm' })
  t.alike(
    r.data.map((m) => m.id),
    ['m1'],
    "'jo sm' → both 'jo' and 'sm' must appear"
  )
})

test('get search: folds case and diacritics', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'm1', text: 'José García' })
  const r = await db.get('messages', { search: 'jose' })
  t.is(r.data.length, 1, "'jose' matches 'José'")
})

test('get search: fields restricts which fields are searched', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'alpha-1', text: 'hello' })
  await db.put('messages', { id: 'm2', text: 'alpha' })
  const r = await db.get('messages', { search: 'alpha', fields: ['text'] })
  t.alike(
    r.data.map((m) => m.id),
    ['m2'],
    'only the text field is searched, not the id'
  )
})

test('total honors search', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'm1', text: 'apple' })
  await db.put('messages', { id: 'm2', text: 'apricot' })
  await db.put('messages', { id: 'm3', text: 'banana' })
  t.is((await db.get('messages', { search: 'ap' })).total, 2, 'total matches the search filter')
})

test('get: an indexed-field query routes to the secondary index', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'm1', text: 'alpha' })
  await db.put('messages', { id: 'm2', text: 'beta' })
  await db.put('messages', { id: 'm3', text: 'alpha' })
  const r = await db.get('messages', { text: 'alpha' })
  t.alike(
    r.data.map((x) => x.id).sort(),
    ['m1', 'm3'],
    'exact field matches via the @cero/messages-by-text index'
  )
})

test('get: a non-indexed field equality filters in memory, not silently ignored', async (t) => {
  const { db } = await bootstrapped(t)
  const a = b4a.from('aaaa')
  const b = b4a.from('bbbb')
  await db.put('messages', { text: 'm', attachment: a })
  await db.put('messages', { text: 'n', attachment: b })
  const r = await db.get('messages', { attachment: a })
  t.is(r.data.length, 1, 'only the matching row, not the whole collection')
  t.ok(b4a.equals(r.data[0].attachment, a), 'the matching row is returned')
})

test('get: an indexed-field query still applies a co-passed search filter', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { text: 'alpha' })
  await db.put('messages', { text: 'alpha' })
  const r = await db.get('messages', { text: 'alpha', search: 'zzz' })
  t.is(r.data.length, 0, 'search co-applies on the index path — not dropped')
})

test('an indexed-field query totals what it returns', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { id: 'm1', text: 'alpha' })
  await db.put('messages', { id: 'm2', text: 'beta' })
  await db.put('messages', { id: 'm3', text: 'alpha' })
  const r = await db.get('messages', { text: 'alpha' })
  t.is(r.data.length, 2, 'get matches via the index')
  t.is(r.total, 2, 'total agrees')
})

test('get: an indexed-field query pushes reverse/limit down to the index', async (t) => {
  const { db } = await bootstrapped(t)
  for (let i = 0; i < 4; i++) {
    await db.put('messages', { id: `m${i}`, text: i % 2 ? 'odd' : 'even' })
  }

  const calls = []
  const view = db.view
  const orig = view.find.bind(view)
  view.find = (path, range) => (calls.push({ path, range }), orig(path, range))
  const r = await db.get('messages', { text: 'even', reverse: true, limit: 1 })
  view.find = orig

  t.alike(
    r.data.map((m) => m.id),
    ['m2'],
    'last even row'
  )
  t.is(r.total, null, 'full page, total skipped')
  t.is(calls.length, 1, 'one read')
  t.ok(calls[0].path.endsWith('/messages-by-text'), 'served by the secondary index')
  t.is(calls[0].range.limit, 1, 'limit reached hyperdb')
})

test('get reverse returns reversed index order', async (t) => {
  const { db } = await bootstrapped(t)
  for (const text of ['a', 'b', 'c', 'd', 'e']) await db.put('messages', { text })
  const r = await db.get('messages', { reverse: true })
  t.alike(
    r.data.map((m) => m.text),
    ['e', 'd', 'c', 'b', 'a'],
    'reversed index order'
  )
  t.is(r.total, 5)
})

test('get reverse+limit returns the last N reversed (reverse before limit)', async (t) => {
  const { db } = await bootstrapped(t)
  for (const text of ['a', 'b', 'c', 'd', 'e']) await db.put('messages', { text })
  const r = await db.get('messages', { reverse: true, limit: 2 })
  t.alike(
    r.data.map((m) => m.text),
    ['e', 'd'],
    'last two reversed — not the first two reversed'
  )
  t.is(r.total, null, 'limited read skips the count (T2.1 lazy total)')
  t.is(r.size, 2)
})

test('get with limit:0 is an empty page', async (t) => {
  const { db } = await bootstrapped(t)
  for (let i = 0; i < 3; i++) await db.put('messages', { id: `id-${i}`, text: `t${i}` })
  const r = await db.get('messages', { limit: 0 })
  t.alike(r.data, [], 'limit:0 yields an empty page')
  t.is(r.size, 0)
  t.is((await db.get('messages', { limit: 0, total: true })).total, 3, 'total on request')
})

// ─── operator surface: single ─────────────────────────────────────────────

test('set on single: insert then overwrite', async (t) => {
  const { db } = await bootstrapped(t)
  await db.set('profile', { name: 'alice' })
  let r = await db.get('profile')
  t.is(r.data.name, 'alice')
  await db.set('profile', { name: 'bob' })
  r = await db.get('profile')
  t.is(r.data.name, 'bob')
})

test('get on missing single returns null', async (t) => {
  const { db } = await bootstrapped(t)
  const { data } = await db.get('profile')
  t.is(data, null)
})

// ─── watch ────────────────────────────────────────────────────────────────

test('watch emits initial snapshot then updates', async (t) => {
  const { db } = await bootstrapped(t)
  await db.set('profile', { name: 'initial' })

  const stream = db.watch('profile')
  const observed = observe(t, stream, [
    (snap) => t.is(snap.data.name, 'initial'),
    (snap) => t.is(snap.data.name, 'updated')
  ])

  await db.set('profile', { name: 'updated' })
  await observed

  stream.destroy()
})

test('watch returns a Readable', async (t) => {
  const { db } = await bootstrapped(t)
  const stream = db.watch('messages')
  t.ok(stream instanceof Readable)
  stream.destroy()
})

// an update tick is scoped to the collection it touched, so a busy
// collection does not re-run every other watcher's query
test('watch: a write to another collection does not re-run the watcher query', async (t) => {
  const { db } = await bootstrapped(t)
  await db.set('profile', { name: 'before' })

  const gets = []
  const orig = db.get.bind(db)
  db.get = (name, q) => {
    gets.push(name)
    return orig(name, q)
  }
  t.teardown(() => {
    db.get = orig
  })

  // one persistent listener — a re-attached once('data') misses snapshots the
  // stream pushed while nobody listened (streamx buffers but stays paused)
  const snaps = []
  const stream = db.watch('profile')
  t.teardown(() => stream.destroy())
  stream.on('data', (s) => snaps.push(s))
  await waitUntil(() => snaps.length > 0 || null)

  gets.length = 0
  for (let i = 0; i < 3; i++) await db.put('messages', { text: `m${i}` })
  await new Promise((r) => setTimeout(r, 150))
  t.is(gets.filter((n) => n === 'profile').length, 0, 'profile watcher stayed asleep')

  await db.set('profile', { name: 'after' })
  const snap = await waitUntil(() => snaps.find((s) => s.data.name === 'after') || null)
  t.is(snap.data.name, 'after', 'its own ref still wakes it')
})

// ─── bootstrap ────────────────────────────────────────────────────────────

test('bootstrap: first-device becomes writable', async (t) => {
  const { db } = await makeDb(t)
  t.is(db.writable, true, 'identity-keypair writable by default')
  const { writer, id } = await db.bootstrap({ name: 'phone', isMobile: true })
  t.ok(b4a.isBuffer(writer.publicKey))
  t.ok(b4a.isBuffer(writer.secretKey))
  t.ok(b4a.isBuffer(id))
  t.is(db.writable, true)
})

test('bootstrap: appends an add-writer (devices collection has 1)', async (t) => {
  const { db } = await bootstrapped(t)
  const { data: devices } = await db.get('devices', {})
  t.ok(devices.length >= 1)
})

// ─── device naming lives on the device row, not the writer/claim op ─────────

test('bootstrap: names the owner device via set-device', async (t) => {
  const { db } = await makeDb(t)
  await db.bootstrap({ name: 'phone', isMobile: true })
  const { data: devices } = await db.get('devices', {})
  t.is(devices.length, 1, 'one device')
  t.is(devices[0].name, 'phone', 'name comes from bootstrap opts')
  t.is(devices[0].isMobile, true, 'isMobile carried onto the device row')
  t.ok(devices[0].memberId, 'device backlinks to a member')
  t.ok(devices[0].createdAt, 'createdAt preserved from add-writer')
})

test('add-writer: creates a bare device — never bakes in a name', async (t) => {
  const { db, identity } = await bootstrapped(t)
  const fresh = b4a.alloc(32)
  for (let i = 0; i < 32; i++) fresh[i] = i + 7
  await db.addWriter(fresh)
  const { data: devices } = await db.get('devices', {})
  const added = devices.find((d) => d.name == null)
  t.ok(added, 'the add-writer device has no name')
  t.absent(added.isMobile, 'and no isMobile')
  t.is(added.memberId, identity.id, 'but it still backlinks to the member identity')
  t.ok(added.createdAt, 'and has a createdAt')
})

test('set-device: a set keeps structural fields (memberId + createdAt)', async (t) => {
  const { db } = await makeDb(t)
  await db.bootstrap({ name: 'phone', isMobile: true })
  const { data: before } = await db.get('devices', {})
  const { id, memberId, createdAt } = before[0]
  t.ok(memberId, 'bootstrap device has a member backlink')

  // a set carries the mutable state (name + isMobile); structural fields persist
  await db.call('set-device', { id, name: 'renamed', isMobile: true })

  const { data: after } = await db.get('devices', id)
  t.is(after.name, 'renamed', 'name updated')
  t.is(after.isMobile, true, 'isMobile set')
  t.is(after.memberId, memberId, 'memberId (backlink) preserved')
  t.is(after.createdAt, createdAt, 'createdAt preserved')
})

test('set-device creates a missing row (intentionally no resurrection guard)', async (t) => {
  const { db } = await bootstrapped(t)
  const fresh = b4a.alloc(32)
  for (let i = 0; i < 32; i++) fresh[i] = i + 41 // an id no existing device uses
  const id = z32.encode(fresh)
  t.absent((await db.get('devices', id)).data, 'device absent before the set')
  await db.call('set-device', { id, name: 'newphone', isMobile: true })
  const { data: after } = await db.get('devices', id)
  t.ok(after, 'set-device created the missing row — unlike set-member, no if(!existing) return')
  t.is(after.name, 'newphone')
  t.is(after.isMobile, true)
  t.is(
    after.memberId,
    (await db.get('devices', hid.encode(db.writerKey))).data.memberId,
    'a created row binds to the signer, never to a wire-supplied memberId'
  )
})

test('bootstrap: post-bootstrap puts replicate identity', async (t) => {
  const { db } = await bootstrapped(t)
  const { data } = await db.put('messages', { text: 'after bootstrap' })
  t.is(data.text, 'after bootstrap')
})

// ─── claim (same identity, new device) ────────────────────────────────────

test('claim: same identity on second db admits writer via add-member then claim', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })

  // First device announces its membership so the second can claim against it.
  // member.key must be the writer hypercore key (= device.id), NOT identity.publicKey.
  await a.db.call('add-member', {
    id: identity.id,
    key: a.db.writerKey,
    role: 'owner',
    name: 'me',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const b = await makeNetworked(t, testnet, {
    identity,
    topic,
    key: a.db.key
  })

  // Wait until b sees the bootstrap state from a.
  await waitForConnection(a.network)
  await waitForConnection(b.network)
  await waitUntil(async () => (await b.db.get('members', identity.id)).data)

  // claim admits the writer; the device is named by a later set-device, which
  // the bootstrap tests cover
  await b.db.claim({ name: 'laptop', isMobile: true })
  t.ok(b.db.writable, 'b is admitted as a writer after claim')
})

// ─── key-type invariants ──────────────────────────────────────────────────

test('add-member backlinks device.id to writer key, not identity pubkey', async (t) => {
  const { db, identity } = await bootstrapped(t)
  await db.call('add-member', {
    id: identity.id,
    key: db.writerKey, // writer hypercore key
    role: 'owner',
    name: 'me',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  // The backlink device row must use z32(writer hypercore key) as its id, AND
  // its memberId must match the identity id.
  const { data: device } = await db.get('devices', z32.encode(db.writerKey))
  t.ok(device, 'device row created for the writer')
  t.is(device.memberId, identity.id, 'device.memberId == identity.id')
  // no stray device row keyed by identity.publicKey
  const { data: ghost } = await db.get('devices', identity.id)
  t.absent(ghost, 'no ghost device row keyed by identity.id')
})

test('put on a collection stamps memberId from the writer→member backlink', async (t) => {
  const { db, identity } = await bootstrapped(t)
  await db.call('add-member', {
    id: identity.id,
    key: db.writerKey,
    role: 'owner',
    name: 'me',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const { data: row } = await db.put('messages', { text: 'hello' })
  // memberId is stamped by the apply handler, so read it back from the view.
  const { data: stored } = await db.get('messages', row.id)
  t.is(stored.memberId, identity.id)
})

// ─── addWriter / removeWriter ─────────────────────────────────────────────

test('addWriter: signed add-writer reaches devices collection', async (t) => {
  const { db } = await bootstrapped(t)
  const fresh = b4a.alloc(32)
  for (let i = 0; i < 32; i++) fresh[i] = i + 1
  await db.addWriter(fresh)
  const { data } = await db.get('devices', {})
  t.ok(data.length >= 2)
})

test('addWriter: rejects non-buffer pk', async (t) => {
  const { db } = await bootstrapped(t)
  await t.exception.all(() => db.addWriter('not-a-buffer'), /publicKey/)
})

test('removeWriter: rejects non-buffer pk', async (t) => {
  const { db } = await bootstrapped(t)
  await t.exception.all(() => db.removeWriter('not-a-buffer'), /publicKey/)
})

// ─── transactions ─────────────────────────────────────────────────────────

test('tx: multiple writes commit atomically', async (t) => {
  const { db } = await bootstrapped(t)
  let updates = 0
  db.on('update', () => updates++)
  await db.tx(async (tx) => {
    await tx.put('messages', { text: 'one' })
    await tx.put('messages', { text: 'two' })
    await tx.set('profile', { name: 'me' })
  })

  const { data: rows } = await db.get('messages', {})
  t.is(rows.length, 2)
  const { data: profile } = await db.get('profile')
  t.is(profile.name, 'me')

  // One drained queue → one update event, not three.
  await waitFor(() => updates >= 1)
  t.is(updates, 1, 'queue drained as a single batch (one update event)')
})

test('tx: throw inside fn discards queued writes', async (t) => {
  const { db } = await bootstrapped(t)
  const before = (await db.get('messages')).total
  await t.exception.all(
    () =>
      db.tx(async (tx) => {
        await tx.put('messages', { text: 'never' })
        throw new Error('oops')
      }),
    /oops/
  )
  const after = (await db.get('messages')).total
  t.is(after, before, 'no writes landed')
})

test('tx: a rolled-back transaction does not swallow unrelated concurrent writes', async (t) => {
  const { db } = await bootstrapped(t)
  let entered, release
  const started = new Promise((r) => (entered = r))
  const gate = new Promise((r) => (release = r))

  const failing = db.tx(async (tx) => {
    entered()
    await tx.put('messages', { text: 'doomed' })
    await gate
    throw new Error('rollback')
  })

  // an unrelated write on the database itself, landing mid-transaction
  await started
  const stray = db.put('messages', { text: 'stray' })
  release()

  await t.exception(failing, /rollback/, 'the transaction rolled back')
  await stray
  const { data } = await db.get('messages', {})
  t.ok(
    data.find((m) => m.text === 'stray'),
    'the unrelated write landed despite the rollback'
  )
  t.absent(
    data.find((m) => m.text === 'doomed'),
    'the transaction write was discarded'
  )
})

test('tx: nested tx joins outer', async (t) => {
  const { db } = await bootstrapped(t)
  let updates = 0
  db.on('update', () => updates++)
  await db.tx(async (tx) => {
    await tx.put('messages', { text: 'a' })
    await tx.tx(async (nested) => {
      await nested.put('messages', { text: 'b' })
    })
  })
  await waitFor(() => updates >= 1)
  t.is(updates, 1, 'nested tx joins outer — one update event')
  const { data } = await db.get('messages', {})
  t.is(data.length, 2)
})

// ─── hooks ────────────────────────────────────────────────────────────────

test('before("put"): returning false refuses the write', async (t) => {
  const { db } = await bootstrapped(t)
  db.before('put', async (ctx) => {
    if (ctx.row.text === 'block') return false
  })

  await t.exception(() => db.put('messages', { text: 'block' }), /refused by hook/)
  const r = await db.put('messages', { text: 'ok' })
  t.is(r.data.text, 'ok')

  const { data } = await db.get('messages', {})
  t.is(data.length, 1)
})

test('before("put"): a hook that throws refuses too', async (t) => {
  const { db } = await bootstrapped(t)
  db.before('put', async () => {
    throw new Error('nope')
  })

  const err = await db.put('messages', { text: 'x' }).catch((e) => e)
  t.is(err.code, 'REFUSED', 'a rule that errors refuses instead of diverging peers')
  t.ok(/nope/.test(err.message), 'and carries the rule error')
  const { data } = await db.get('messages', {})
  t.is(data.length, 0)
})

test('before("put"): mutation in hook rewrites the stored row', async (t) => {
  const { db } = await bootstrapped(t)
  db.before('put', async (ctx) => {
    ctx.row.text = ctx.row.text.toUpperCase()
  })

  const { data: submitted } = await db.put('messages', { text: 'hello' })
  t.is(submitted.text, 'hello', 'the call returns the row it submitted')
  const { data } = await db.get('messages', submitted.id)
  t.is(data.text, 'HELLO', 'the hook decides what lands')
})

test('multiple before hooks chain in registration order', async (t) => {
  const { db } = await bootstrapped(t)
  const calls = []
  db.before('put', async () => {
    calls.push('a')
  })
  db.before('put', async () => {
    calls.push('b')
  })
  await db.put('messages', { text: 'x' })
  // the writer runs its hooks twice: once in the dry run, once at apply
  t.alike(calls, ['a', 'b', 'a', 'b'])
})

test('first before hook to return false short-circuits', async (t) => {
  const { db } = await bootstrapped(t)
  const calls = []
  db.before('put', async () => {
    calls.push('a')
    return false
  })
  db.before('put', async () => {
    calls.push('b')
  })
  await t.exception(() => db.put('messages', { text: 'x' }), /refused by hook/)
  t.alike(calls, ['a'])
})

test('after("put") fires with the applied row', async (t) => {
  const { db } = await bootstrapped(t)
  let seen = null
  db.after('put', async (ctx) => {
    seen = ctx
  })
  await db.put('messages', { text: 'observed' })
  t.ok(seen)
  t.is(seen.op, 'put')
  t.is(seen.name, 'messages')
  t.is(seen.row.text, 'observed')
  t.is(seen.existing, null, 'no row under that id before the op')
})

test('after("put") writes a derived row through ctx.put', async (t) => {
  const { db } = await bootstrapped(t)
  db.after('put', async (ctx) => {
    await ctx.put('records', { id: `a-${ctx.row.id}`, text: ctx.row.text })
  })
  const { data: row } = await db.put('messages', { text: 'audited' })
  const { data } = await db.get('records', `a-${row.id}`)
  t.is(data?.text, 'audited', 'the derived row landed in the same transaction')
})

test('after("del") removes a derived row through ctx.del', async (t) => {
  const { db } = await bootstrapped(t)
  db.after('put', (ctx) => ctx.put('records', { id: `a-${ctx.row.id}`, text: ctx.row.text }))
  db.after('del', (ctx) => ctx.del('records', `a-${ctx.id}`))
  const { data: row } = await db.put('messages', { text: 'x' })
  t.ok((await db.get('records', `a-${row.id}`)).data, 'derived row written')
  await db.del('messages', row.id)
  t.absent((await db.get('records', `a-${row.id}`)).data, 'and removed in the op that deleted it')
})

test('a hook write wakes watchers of the collection it wrote', async (t) => {
  const { db } = await bootstrapped(t)
  db.after('put', (ctx) => ctx.put('records', { id: `a-${ctx.row.id}`, text: ctx.row.text }))
  const seen = []
  const stream = db.watch('records')
  stream.on('data', ({ data }) => seen.push(data.length))
  t.teardown(() => stream.destroy())
  await waitUntil(() => seen.length > 0 || null)

  await db.put('messages', { text: 'x' })
  await waitUntil(() => (seen.includes(1) ? true : null))
  t.pass('the derived row reached a subscriber')
})

test('after("put") does not fire when before refuses', async (t) => {
  const { db } = await bootstrapped(t)
  let after = 0
  db.before('put', async () => false)
  db.after('put', async () => {
    after++
  })
  await t.exception(() => db.put('messages', { text: 'x' }), /refused by hook/)
  t.is(after, 0)
})

test('an operator called inside a hook throws INVALID', async (t) => {
  const { db } = await bootstrapped(t)
  let err = null
  db.before('put', async () => {
    try {
      await db.put('messages', { text: 'nested' })
    } catch (e) {
      err = e
    }
  })
  await db.put('messages', { text: 'outer' })
  t.is(err?.code, 'INVALID')
  t.ok(/inside a hook/.test(err.message), 'points at the ctx operators')
})

// ─── events ───────────────────────────────────────────────────────────────

test('"update" event fires on commit', async (t) => {
  const { db } = await bootstrapped(t)
  let count = 0
  db.on('update', () => count++)
  await db.put('messages', { text: 'x' })
  await waitFor(() => count > 0)
  t.ok(count > 0)
})

// ─── replication ─────────────────────────────────────────────────────────
//
// Multi-writer replication is the core feature of an autobee-backed db.
// These tests bring up 2+ networked databases on a shared testnet and
// assert convergence under a variety of scenarios: simple propagation,
// concurrent writes, writer admission/removal, recovery, and hook behavior
// across the network boundary.

async function waitUntil(fn, { timeout = 15000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, interval))
  }
  // throw, not return null — a timed-out wait must fail loud, not let the test
  // continue as if the condition held (masking the real cause behind a later error)
  throw new Error('waitUntil: condition not met before timeout')
}

test('replication: two databases converge on testnet', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })
  await a.db.put('messages', { text: 'from a' })

  const b = await makeNetworked(t, testnet, { identity, topic, key: a.db.key })
  await b.db.bootstrap({ recovering: true })

  await waitForConnection(a.network)
  await waitForConnection(b.network)

  const hit = await waitUntil(async () => {
    const { data } = await b.db.get('messages', {})
    return data.length > 0 ? data : null
  })
  t.ok(hit, 'b saw a row from a')
  t.is(hit[0].text, 'from a')
})

test('replication: put propagates A → B', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })
  const { data: row } = await a.db.put('messages', { text: 'hello' })

  const b = await makeNetworked(t, testnet, { identity, topic, key: a.db.key })
  await b.db.bootstrap({ recovering: true })

  await waitForConnection(a.network)
  await waitForConnection(b.network)

  const seen = await waitUntil(async () => {
    const { data } = await b.db.get('messages', row.id)
    return data || null
  })
  t.ok(seen, 'b saw row by id')
  t.is(seen.text, 'hello')
})

test('replication: set on single propagates A → B', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })
  await a.db.set('profile', { name: 'alice' })

  const b = await makeNetworked(t, testnet, { identity, topic, key: a.db.key })
  await b.db.bootstrap({ recovering: true })

  await waitForConnection(a.network)
  await waitForConnection(b.network)

  const profile = await waitUntil(async () => {
    const { data } = await b.db.get('profile')
    return data && data.name === 'alice' ? data : null
  })
  t.ok(profile, 'b saw profile')
  t.is(profile.name, 'alice')
})

test('replication: del propagates A → B (row disappears)', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })
  const { data: row } = await a.db.put('messages', { text: 'soon-gone' })

  const b = await makeNetworked(t, testnet, { identity, topic, key: a.db.key })
  await b.db.bootstrap({ recovering: true })

  await waitForConnection(a.network)
  await waitForConnection(b.network)

  // First confirm B saw the row.
  const before = await waitUntil(async () => {
    const { data } = await b.db.get('messages', row.id)
    return data || null
  })
  t.ok(before, 'b saw row before del')

  await a.db.del('messages', row.id)

  const gone = await waitUntil(async () => {
    const { data } = await b.db.get('messages', row.id)
    return data === null ? true : null
  })
  t.ok(gone, 'b saw row disappear after del')
})

test('replication: concurrent puts from two writers — both rows visible to both', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })

  // Give B its own writer keypair (different identity, just used as a writer).
  // Encryption key must be shared so B can decrypt the autobee state.
  const bIdentity = await Identity.generate()
  const b = await makeNetworked(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  // A admits B as a writer.
  await a.db.addWriter(b.db.keyPair.publicKey)

  // Wait for B to become writable.
  await waitUntil(() => b.db.writable)
  t.ok(b.db.writable, 'b became writable after addWriter')

  // Each side writes concurrently.
  const [ra, rb] = await Promise.all([
    a.db.put('messages', { text: 'from-a' }),
    b.db.put('messages', { text: 'from-b' })
  ])
  t.ok(ra.data.id && rb.data.id)

  // Both rows should land on both peers.
  const onA = await waitUntil(async () => {
    const { data } = await a.db.get('messages', {})
    return data.length >= 2 ? data : null
  })
  const onB = await waitUntil(async () => {
    const { data } = await b.db.get('messages', {})
    return data.length >= 2 ? data : null
  })
  t.ok(onA && onB, 'both sides converged on two rows')

  const aTexts = onA.map((r) => r.text).sort()
  const bTexts = onB.map((r) => r.text).sort()
  t.alike(aTexts, ['from-a', 'from-b'])
  t.alike(bTexts, ['from-a', 'from-b'])
})

test('replication: addWriter promotes B → B can put → A sees', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })

  const bIdentity = await Identity.generate()
  const b = await makeNetworked(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  t.is(b.db.writable, false, 'b is not writable before addWriter')

  await a.db.addWriter(b.db.keyPair.publicKey)
  await waitUntil(() => b.db.writable)
  t.ok(b.db.writable, 'b became writable after admission')

  const { data: row } = await b.db.put('messages', { text: 'from-b' })

  const onA = await waitUntil(async () => {
    const { data } = await a.db.get('messages', row.id)
    return data || null
  })
  t.ok(onA, 'a saw b row')
  t.is(onA.text, 'from-b')
})

test('replication: removeWriter — B can no longer write', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })
  // A is the owner — required to remove a writer (eviction is owner-only)
  await a.db.call('add-member', {
    id: identity.id,
    key: a.db.writerKey,
    role: 'owner',
    name: 'a',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const bIdentity = await Identity.generate()
  const b = await makeNetworked(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  await a.db.addWriter(b.db.keyPair.publicKey)
  await waitUntil(() => b.db.writable)
  t.ok(b.db.writable, 'b writable after add')

  // B writes once successfully so we have a baseline.
  const { data: r1 } = await b.db.put('messages', { text: 'still-allowed' })
  await waitUntil(async () => {
    const { data } = await a.db.get('messages', r1.id)
    return data || null
  })

  await a.db.removeWriter(b.db.keyPair.publicKey)

  // B should observe its writer admission revoked.
  const lostWritable = await waitUntil(() => b.db.writable === false)
  t.ok(lostWritable, 'b became non-writable after removeWriter')
})

test('replication: bootstrap recovery — same identity, second device, no fork', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })
  await a.db.put('messages', { text: 'before-recovery' })

  // Second device, same identity, joins later with the existing key.
  const b = await makeNetworked(t, testnet, { identity, topic, key: a.db.key })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  // Recovery: wait for A's state, then append a fresh add-writer claim.
  await b.db.bootstrap({ name: 'b', recovering: true })
  t.ok(b.db.writable, 'b writable after recovery bootstrap')

  // B writes; A should see it (no fork).
  const { data: row } = await b.db.put('messages', { text: 'after-recovery' })

  const seenOnA = await waitUntil(async () => {
    const { data } = await a.db.get('messages', row.id)
    return data || null
  })
  t.ok(seenOnA, 'a saw b row after recovery')
  t.is(seenOnA.text, 'after-recovery')

  // Both sides converge on both messages.
  const onA = await waitUntil(async () => {
    const { data } = await a.db.get('messages', {})
    return data.length >= 2 ? data : null
  })
  const onB = await waitUntil(async () => {
    const { data } = await b.db.get('messages', {})
    return data.length >= 2 ? data : null
  })
  t.ok(onA && onB, 'both peers converge')
  t.alike(onA.map((r) => r.text).sort(), ['after-recovery', 'before-recovery'])
  t.alike(onB.map((r) => r.text).sort(), ['after-recovery', 'before-recovery'])
})

test('replication: claim() — same identity, second device, admitted by A’s member entry', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })

  // Publish member entry so claim() can verify identity membership.
  await a.db.call('add-member', {
    id: identity.id,
    key: a.db.writerKey,
    role: 'owner',
    name: 'me',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const b = await makeNetworked(t, testnet, { identity, topic, key: a.db.key })
  await b.db.bootstrap({ recovering: true })

  await waitForConnection(a.network)
  await waitForConnection(b.network)

  // Wait until B sees the member entry.
  const member = await waitUntil(async () => {
    const { data } = await b.db.get('members', identity.id)
    return data || null
  })
  t.ok(member, 'b saw member entry from a')

  await b.db.claim()

  // A admits the new writer; b becomes writable.
  await waitUntil(() => b.db.writable)
  t.ok(b.db.writable, 'b writable after claim()')

  // And b's writes flow to a.
  const { data: row } = await b.db.put('messages', { text: 'claimed' })
  const seen = await waitUntil(async () => {
    const { data } = await a.db.get('messages', row.id)
    return data || null
  })
  t.ok(seen, 'a saw b row after claim')
})

test('replication: after("put") on A fires for B-originated writes', async (t) => {
  // hooks run at apply, so every peer runs them on every op, whoever wrote it
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })

  const bIdentity = await Identity.generate()
  const b = await makeNetworked(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  await a.db.addWriter(b.db.keyPair.publicKey)
  await enroll(a.db, bIdentity, 'member', b.db.writerKey)
  await waitUntil(() => b.db.writable)

  const seen = []
  a.db.after('put', (ctx) => {
    seen.push(ctx.row.text)
  })

  const { data: row } = await b.db.put('messages', { text: 'from-b' })
  await waitUntil(async () => {
    const { data } = await a.db.get('messages', row.id)
    return data || null
  })

  t.alike(seen, ['from-b'], "a ran its hook when b's op applied")
})

test('replication: a before hook refuses replicated writes on the peer that has it', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })

  const bIdentity = await Identity.generate()
  const b = await makeNetworked(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  await a.db.addWriter(b.db.keyPair.publicKey)
  await enroll(a.db, bIdentity, 'member', b.db.writerKey)
  await waitUntil(() => b.db.writable)

  // only b has the rule
  b.db.before('put', (ctx) => ctx.row.text !== 'blocked')

  const rows = []
  const stream = b.db.changes('messages')
  stream.on('data', (batch) => {
    for (const { next } of batch.changes) if (next) rows.push(next.text)
  })
  t.teardown(() => stream.destroy())

  const applied = []
  b.db.on('apply', ({ name, row }) => {
    if (name === 'messages') applied.push(row.text)
  })

  const { data: kept } = await a.db.put('messages', { text: 'kept' })
  await waitUntil(async () => (await b.db.get('messages', kept.id)).data || null)

  const { data: blocked } = await a.db.put('messages', { text: 'blocked' })
  t.ok((await a.db.get('messages', blocked.id)).data, 'a applied its own write, it has no rule')

  await waitUntil(() => applied.includes('blocked') || null)
  t.absent((await b.db.get('messages', blocked.id)).data, 'b refused what its rule rejects')
  t.absent(rows.includes('blocked'), 'and never handed it to a subscriber')

  // with the rule on both peers the writer learns at its own dry run
  a.db.before('put', (ctx) => ctx.row.text !== 'blocked')
  const err = await a.db.put('messages', { text: 'blocked' }).catch((e) => e)
  t.is(err.code, 'REFUSED', 'refused before it reached the log')
})

test('replication: eventually-consistent — B sees all 5 rows put by A before joining', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })
  for (let i = 0; i < 5; i++) {
    await a.db.put('messages', { id: `m-${i}`, text: `t${i}` })
  }

  const b = await makeNetworked(t, testnet, { identity, topic, key: a.db.key })
  await b.db.bootstrap({ recovering: true })

  await waitForConnection(a.network)
  await waitForConnection(b.network)

  const rows = await waitUntil(async () => {
    const { data } = await b.db.get('messages', {})
    return data.length >= 5 ? data : null
  })
  t.ok(rows, 'b saw all 5 rows')
  t.alike(rows.map((r) => r.id).sort(), ['m-0', 'm-1', 'm-2', 'm-3', 'm-4'])
})

test('replication: three-peer — A puts, both B and C receive', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })

  const bIdentity = await Identity.generate()
  const cIdentity = await Identity.generate()

  const b = await makeNetworked(t, testnet, {
    identity: bIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  const c = await makeNetworked(t, testnet, {
    identity: cIdentity,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })

  await waitForConnection(a.network)
  await waitForConnection(b.network)
  await waitForConnection(c.network)

  await a.db.addWriter(b.db.keyPair.publicKey)
  await a.db.addWriter(c.db.keyPair.publicKey)
  await waitUntil(() => b.db.writable)
  await waitUntil(() => c.db.writable)

  const { data: row } = await a.db.put('messages', { text: 'broadcast' })

  const onB = await waitUntil(async () => {
    const { data } = await b.db.get('messages', row.id)
    return data || null
  })
  const onC = await waitUntil(async () => {
    const { data } = await c.db.get('messages', row.id)
    return data || null
  })
  t.ok(onB, 'b saw broadcast')
  t.ok(onC, 'c saw broadcast')
  t.is(onB.text, 'broadcast')
  t.is(onC.text, 'broadcast')
})

// ─── whenWritable / whenReadable ──────────────────────────────────────────

// Two networked databases on the same testnet+key, with DIFFERENT identities.
// A bootstraps and is writable; B opens the same database but is not admitted
// yet, so b.writable === false — the precondition for whenWritable timeout
// and add-writer tests.
async function pairOnTestnet(t, testnet) {
  const idA = await Identity.generate()
  const idB = await Identity.generate()
  const topic = randomTopic()
  const a = await makeNetworked(t, testnet, { identity: idA, topic })
  await a.db.bootstrap({ name: 'a' })
  const b = await makeNetworked(t, testnet, {
    identity: idB,
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)
  return { a, b, idA, idB }
}

test('whenWritable: returns immediately when already writable', async (t) => {
  const { db } = await bootstrapped(t)
  t.ok(db.writable, 'bootstrap left db writable')
  const result = await db.whenWritable({ timeout: 1000 })
  t.is(result, undefined, 'resolves with no value')
})

test('whenWritable: rejects on timeout when never writable', async (t) => {
  const testnet = await makeTestnet(t)
  const { b } = await pairOnTestnet(t, testnet)
  t.absent(b.db.writable, 'b not writable on join')
  const started = Date.now()
  await t.exception.all(() => b.db.whenWritable({ timeout: 300 }), /timed out|whenWritable/i)
  const elapsed = Date.now() - started
  t.ok(elapsed >= 280 && elapsed < 2000, `respected timeout (${elapsed}ms)`)
})

test('whenWritable: rejects on close', async (t) => {
  const testnet = await makeTestnet(t)
  const { b } = await pairOnTestnet(t, testnet)
  t.absent(b.db.writable)
  const promise = b.db.whenWritable({ timeout: 30000 })
  setTimeout(() => b.db.close().catch(() => {}), 50)
  await t.exception.all(() => promise, /closed/i)
})

test('whenWritable: resolves when bee becomes writable via add-writer', async (t) => {
  const testnet = await makeTestnet(t)
  const { a, b, idB } = await pairOnTestnet(t, testnet)
  t.absent(b.db.writable, 'b not yet writable')
  await a.db.addWriter(b.db.keyPair.publicKey)
  await b.db.whenWritable({ timeout: 15000 })
  t.ok(b.db.writable, 'b became writable')
})

// ─── onerror hook ─────────────────────────────────────────────────────────

test('a throwing after hook refuses the op', async (t) => {
  const { db } = await bootstrapped(t)
  db.after('put', async () => {
    throw new Error('after-hook boom')
  })
  const err = await db.put('messages', { text: 'hello' }).catch((e) => e)
  t.is(err.code, 'REFUSED')
  t.ok(/after-hook boom/.test(err.message))
  const { data } = await db.get('messages', {})
  t.is(data.length, 0, 'the row never landed')
})

// which databases swarm is ranked by their last update, not by being open
test('presence: an update ranks a database, opening it does not', async (t) => {
  const testnet = await makeTestnet(t)
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = await Identity.generate()
  const open = async (opts) => {
    const db = new Database({ store, identity, spec, ...opts })
    await db.ready()
    t.teardown(() => db.close().catch(() => {}), { order: 5 })
    return db
  }
  const keys = []
  for (const name of ['a', 'b']) {
    const db = await open({ namespace: name })
    await db.bootstrap({ name })
    await enroll(db, identity)
    keys.push({ key: db.key, keyPair: db.keyPair, namespace: name })
    await db.close()
  }

  const network = new Network({
    bootstrap: testnet.bootstrap,
    presence: { active: 1, announced: 0, idle: 50 }
  })
  await network.ready()
  t.teardown(() => network.close().catch(() => {}), { order: 9 })
  const mode = (db) => network.presence.mode(db.bee.discoveryKey)

  const root = await open({ network, pinned: true })
  const a = await open({ network, ...keys[0] })
  const b = await open({ network, ...keys[1] })
  t.is(mode(root), 'active', 'the root is pinned')
  t.is(mode(a), 'active', 'the first opened holds the one slot')
  t.is(mode(b), null, 'the boot replay did not rank b')

  await b.put('messages', { text: 'hi' })
  t.is(mode(b), 'active', 'a local update ranks b')
  await waitFor(() => mode(a) === null)
  t.pass('a left after idle')

  b.setActive(false)
  await waitFor(() => mode(b) === null)
  b.setActive(true)
  t.is(mode(b), 'active', 'setActive is a touch')
  t.is(mode(root), 'active', 'the root never moved')
})

test('presence: a replicated update ranks the database it lands in', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  // x hosts two databases; y opens both but only shared searches
  const x = await makeNetworked(t, testnet, { identity, topic, namespace: 'shared' })
  await x.db.bootstrap({ name: 'x' })
  await enroll(x.db, identity)
  const quiet = new Database({
    store: x.store,
    identity,
    network: x.network,
    spec,
    namespace: 'quiet'
  })
  await quiet.ready()
  t.teardown(() => quiet.close().catch(() => {}), { order: 5 })
  await quiet.bootstrap({ name: 'x' })
  await enroll(quiet, identity)

  const y = await makeNetworked(t, testnet, {
    identity,
    topic,
    key: x.db.key,
    namespace: 'shared',
    presence: { active: 1, announced: 0, idle: 50 }
  })
  await y.db.bootstrap({ recovering: true })
  const yQuiet = new Database({
    store: y.store,
    identity,
    network: y.network,
    spec,
    key: quiet.key,
    namespace: 'quiet'
  })
  await yQuiet.ready()
  t.teardown(() => yQuiet.close().catch(() => {}), { order: 5 })
  const mode = (db, net) => net.presence.mode(db.bee.discoveryKey)
  t.is(mode(y.db, y.network), 'active')
  t.is(mode(yQuiet, y.network), null, 'quiet never joined its topic on y')

  await waitForConnection(x.network)
  await waitForConnection(y.network)
  await quiet.put('messages', { text: 'over the shared connection' })
  await waitUntil(async () => (await yQuiet.get('messages')).data.length > 0)
  t.is(mode(yQuiet, y.network), 'active', 'the replicated update ranked quiet')
  await waitFor(() => mode(y.db, y.network) === null)
  t.pass('shared slid out')
})

// ─── write-path integrity ─────────────────────────────────────────────────

test('apply: builtin timestamps are deterministic across peers', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })
  const { data: onA } = await a.db.get('devices')
  t.ok(onA.length > 0, 'bootstrap created a devices row')

  // joins after a clock-skew window — its apply of A's history runs later
  await new Promise((r) => setTimeout(r, 150))
  const b = await makeNetworked(t, testnet, {
    identity: await Identity.generate(),
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  const onB = await waitFor(async () => {
    const { data } = await b.db.get('devices')
    return data.length === onA.length ? data : null
  })

  for (const row of onA) {
    const mirror = onB.find((r) => r.id === row.id)
    t.ok(mirror, `device ${row.id.slice(0, 8)} replicated`)
    t.is(mirror.createdAt, row.createdAt, 'createdAt identical on both peers')
    t.is(mirror.updatedAt, row.updatedAt, 'updatedAt identical on both peers')
  }
})

test('write: a throwing route rejects the call and appends nothing (dry-run)', async (t) => {
  const db = await teamDb(t, {
    promote: async ({ row }) => {
      if (row.role === 'boom') throw new Error('role rejected by app')
    }
  })
  const before = db.bee.local.length

  await t.exception(
    db.call('promote', { memberId: 'm', role: 'boom' }),
    /role rejected by app/,
    'the app error surfaces on call'
  )
  t.is(db.bee.local.length, before, 'nothing was appended to the log')

  await db.call('promote', { memberId: 'm', role: 'admin' })
  t.ok(db.bee.local.length > before, 'a valid op still appends')
})

test('write: dry-run state is discarded — only the real apply mutates the view', async (t) => {
  const db = await teamDb(t)
  const { data: row } = await db.put('messages', { text: 'once' })
  const { data: list } = await db.get('messages')
  t.is(list.length, 1, 'exactly one row despite the handler running in dry-run too')
  t.is(list[0].id, row.id)
})

test('apply: claim-path device timestamps are deterministic across peers', async (t) => {
  const testnet = await makeTestnet(t)
  const identity = await Identity.generate()
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { identity, topic })
  await a.db.bootstrap({ name: 'a' })
  await a.db.call('add-member', {
    id: identity.id,
    key: a.db.writerKey,
    role: 'owner',
    name: 'me',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const b = await makeNetworked(t, testnet, {
    identity,
    topic,
    key: a.db.key,
    keyPair: Identity.randomKeyPair()
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)
  t.absent(b.db.writable, 'a fresh device core starts unadmitted')
  await b.db.claim({ name: 'laptop', isMobile: true })
  t.ok(b.db.writable, 'b admitted')

  const id = z32.encode(b.db.writerKey)
  const onB = await waitFor(async () => (await b.db.get('devices', id)).data)
  const onA = await waitFor(async () => (await a.db.get('devices', id)).data)
  t.ok(onB.createdAt > 0, 'claim stamped a real timestamp')
  t.is(onA.createdAt, onB.createdAt, 'claim createdAt identical on both peers')
  t.is(onA.updatedAt, onB.updatedAt, 'claim updatedAt identical on both peers')
})

test('apply: an add-writer without ts falls back to 0 — identical everywhere', async (t) => {
  const { db, identity } = await bootstrapped(t)
  const writer = Identity.randomKeyPair().publicKey

  await db.call('add-writer', {
    master: identity.publicKey,
    writer,
    sig: identity.sign(admission(db.key, writer, db.writerKey))
  })

  const { data: row } = await db.get('devices', z32.encode(writer))
  t.ok(row, 'writer admitted')
  t.is(row.createdAt, 0, 'missing ts decodes to the deterministic fallback')
  t.is(row.updatedAt, 0, 'no wall clock involved')
})

test('write: a throwing op anywhere in a tx batch rejects the whole batch', async (t) => {
  const db = await teamDb(t, {
    promote: async ({ row }) => {
      if (row.role === 'boom') throw new Error('batch poison')
    }
  })
  const before = db.bee.local.length

  await t.exception(
    db.tx(async (tx) => {
      await tx.call('promote', { memberId: 'm', role: 'fine' })
      await tx.call('promote', { memberId: 'm', role: 'boom' })
    }),
    /batch poison/,
    'the batch rejects with the app error'
  )
  t.is(db.bee.local.length, before, 'no partial batch was appended')

  await db.call('promote', { memberId: 'm', role: 'fine' })
  t.ok(db.bee.local.length > before, 'the database still accepts valid writes')
})

test('apply: set-device timestamps replicate identically', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()

  const a = await makeNetworked(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })
  const { data: devices } = await a.db.get('devices')
  const id = devices[0].id

  const b = await makeNetworked(t, testnet, {
    identity: await Identity.generate(),
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)
  await waitFor(async () => (await b.db.get('devices', id)).data)

  await a.db.call('set-device', {
    id,
    name: 'renamed',
    isMobile: false,
    updatedAt: Date.now()
  })

  const onB = await waitFor(async () => {
    const { data } = await b.db.get('devices', id)
    return data?.name === 'renamed' ? data : null
  })
  const { data: onA } = await a.db.get('devices', id)
  t.is(onA.name, 'renamed')
  t.is(onA.updatedAt, onB.updatedAt, 'rename updatedAt identical on both peers')
  t.is(onA.createdAt, onB.createdAt, 'createdAt preserved identically')
})

// ─── op-version wire-gate ─────────────────────────────────────────────────

test('envelope: wrap/unwrap round-trips, un-enveloped bytes pass through', async (t) => {
  const { wrap, unwrap } = await import('../../src/database/envelope.js')
  const body = b4a.from([0x01, 0x02, 0x03])

  const wrapped = wrap(7, body)
  t.is(wrapped[0], 0xff, 'sentinel leads')
  const out = unwrap(wrapped)
  t.is(out.version, 7)
  t.alike(out.body, body, 'body intact')

  const legacy = unwrap(body)
  t.is(legacy.version, 0, 'no sentinel → version 0')
  t.alike(legacy.body, body, 'legacy bytes untouched')

  const big = unwrap(wrap(300, body))
  t.is(big.version, 300, 'multi-byte versions round-trip')
})

test('gate: ops from a future contract version are skipped, surfaced, and survive restart', async (t) => {
  const errors = []
  const { db } = await bootstrapped(t, { onerror: (err) => errors.push(err) })
  const { wrap } = await import('../../src/database/envelope.js')

  let behindEvents = 0
  db.on('behind', () => behindEvents++)

  const future = db.version + 1
  const encoded = spec.dispatch.encode('@cero/add-messages', {
    id: genId(),
    text: 'from the future'
  })
  await db.bee.append(wrap(future, encoded))
  await db.bee.update()

  const { data: rows } = await db.get('messages')
  t.is(rows.length, 0, 'future op not applied')
  t.is(errors.length, 0, 'skipping the future is not an error')
  t.is(db.behind, future, 'db.behind reports the future version')
  t.is(behindEvents, 1, 'behind emitted once')

  await db.bee.append(wrap(future, encoded))
  await db.bee.update()
  t.is(behindEvents, 1, 'not re-emitted per op')

  const { data: row } = await db.put('messages', { text: 'present' })
  t.ok((await db.get('messages', row.id)).data, 'current-version ops still apply')
})

test('gate: legacy un-enveloped ops apply as version 0', async (t) => {
  const { db } = await bootstrapped(t)
  const id = genId()
  const encoded = spec.dispatch.encode('@cero/add-messages', { id, text: 'legacy' })
  await db.bee.append(encoded)
  await db.bee.update()
  t.ok((await db.get('messages', id)).data, 'raw pre-envelope bytes still apply')
})

test('gate: enveloped ops replicate and apply across peers', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const a = await makeNetworked(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })
  const { data: row } = await a.db.put('messages', { text: 'wire' })

  const b = await makeNetworked(t, testnet, {
    identity: await Identity.generate(),
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)
  const onB = await waitFor(async () => (await b.db.get('messages', row.id)).data)
  t.is(onB.text, 'wire', 'enveloped op applied on the peer')
})

test('gate: behind survives reopen', async (t) => {
  const { db, store, identity } = await bootstrapped(t)
  const { wrap } = await import('../../src/database/envelope.js')

  const future = db.version + 5
  const encoded = spec.dispatch.encode('@cero/add-messages', { id: genId(), text: 'x' })
  await db.bee.append(wrap(future, encoded))
  await db.bee.update()
  t.is(db.behind, future)

  const { key, keyPair } = db
  await db.close()

  const again = new Database({ store, identity, spec, key, keyPair })
  await again.ready()
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  t.is(again.behind, future, 'behind reloaded from the local core')
})

test('gate: upgrading past skipped ops rebuilds the view and applies them', async (t) => {
  const { db, store, identity } = await bootstrapped(t)
  const { wrap } = await import('../../src/database/envelope.js')

  const futureId = genId()
  const future = db.version + 1
  await db.bee.append(
    wrap(future, spec.dispatch.encode('@cero/add-messages', { id: futureId, text: 'future' }))
  )
  const { data: present } = await db.put('messages', { text: 'present' })
  await db.bee.update()
  t.is(db.behind, future, 'future op skipped')
  t.absent((await db.get('messages', futureId)).data, 'not applied pre-upgrade')

  const { key, keyPair } = db
  await db.close()

  const upgraded = { ...spec, meta: { ...spec.meta, version: future } }
  const again = new Database({ store, identity, spec: upgraded, key, keyPair })
  await again.ready()
  t.teardown(() => again.close().catch(() => {}), { order: 4 })

  t.is(again.behind, null, 'marker cleared')
  t.ok((await again.get('messages', futureId)).data, 'skipped op applied after upgrade')
  t.ok(
    (await again.get('messages', present.id)).data,
    'previously-applied rows survived the rebuild'
  )
})

// ─── diff watchers: Database.changes ──────────────────────────────────────

test('changes: initial batch is the current rows as inserts with reset', async (t) => {
  const { db } = await bootstrapped(t)
  await db.put('messages', { text: 'a' })
  await db.put('messages', { text: 'b' })

  const stream = db.changes('messages')
  t.teardown(() => stream.destroy())
  const [first] = await collect(stream, 1)

  t.is(first.reset, true, 'initial batch resets')
  t.is(first.changes.length, 2, 'both rows arrive')
  t.ok(
    first.changes.every((c) => c.prev === null && c.next),
    'all inserts'
  )
})

test('changes: empty collection → empty initial batch, then deltas', async (t) => {
  const { db } = await bootstrapped(t)
  const stream = db.changes('messages')
  t.teardown(() => stream.destroy())
  const batches = []
  stream.on('data', (b) => batches.push(b))

  await waitFor(async () => batches.length >= 1 || null)
  t.is(batches[0].reset, true)
  t.is(batches[0].changes.length, 0, 'empty initial')

  const { data: row } = await db.put('messages', { text: 'new' })
  await waitFor(async () => batches.length >= 2 || null)
  const second = batches[1]
  t.is(second.reset, false)
  t.is(second.changes.length, 1)
  t.is(second.changes[0].prev, null, 'insert has no prev')
  t.is(second.changes[0].next.id, row.id)

  await db.set('messages', { id: row.id, text: 'edited' })
  await waitFor(async () => batches.length >= 3 || null)
  t.is(batches[2].changes[0].prev.text, 'new', 'update carries prev')
  t.is(batches[2].changes[0].next.text, 'edited', 'and next')

  await db.del('messages', row.id)
  await waitFor(async () => batches.length >= 4 || null)
  t.is(batches[3].changes[0].prev.text, 'edited', 'delete carries prev')
  t.is(batches[3].changes[0].next, null, 'and no next')
})

test('changes: bursts fold losslessly — replay always equals get', async (t) => {
  const { db } = await bootstrapped(t)
  const stream = db.changes('messages')
  t.teardown(() => stream.destroy())
  const batches = []
  stream.on('data', (b) => batches.push(b))

  const rows = []
  for (let i = 0; i < 12; i++) {
    const { data } = await db.put('messages', { text: `m${i}` })
    rows.push(data)
  }
  await db.set('messages', { id: rows[0].id, text: 'm0-edited' })
  await db.del('messages', rows[1].id)

  await waitFor(async () => {
    const map = replay(batches)
    return map.size === 11 && map.get(rows[0].id)?.text === 'm0-edited' && !map.has(rows[1].id)
  })
  const { data: truth } = await db.get('messages')
  const map = replay(batches)
  t.is(map.size, truth.length, 'replayed size matches get')
  t.ok(
    truth.every((r) => map.get(r.id)?.text === r.text),
    'replayed rows match get exactly'
  )
})

test('changes: query filters scope the deltas', async (t) => {
  const { db } = await bootstrapped(t)
  const stream = db.changes('messages', { search: 'keep' })
  t.teardown(() => stream.destroy())
  const batches = []
  stream.on('data', (b) => batches.push(b))

  const { data: kept } = await db.put('messages', { text: 'keep me' })
  await db.put('messages', { text: 'drop me' })
  await waitFor(async () => replay(batches).size === 1 || null)
  t.is(replay(batches).get(kept.id)?.text, 'keep me', 'only matching rows surface')

  await db.set('messages', { id: kept.id, text: 'now dropped' })
  await waitFor(async () => replay(batches).size === 0 || null)
  const last = batches[batches.length - 1]
  t.is(last.changes[0].next, null, 'a row leaving the filter arrives as prev-only')
})

test('changes: writes to another collection do not wake the stream', async (t) => {
  const { db } = await bootstrapped(t)
  const stream = db.changes('messages')
  t.teardown(() => stream.destroy())
  const batches = []
  stream.on('data', (b) => batches.push(b))
  await collect(stream, 1)

  await db.set('profile', { name: 'other' })
  await new Promise((r) => setTimeout(r, 300))
  t.is(batches.length, 1, 'no batch for unrelated collections')
})

test('changes: replicated writes surface on the peer', async (t) => {
  const testnet = await makeTestnet(t)
  const topic = randomTopic()
  const a = await makeNetworked(t, testnet, { topic })
  await a.db.bootstrap({ name: 'a' })

  const b = await makeNetworked(t, testnet, {
    identity: await Identity.generate(),
    topic,
    key: a.db.key,
    encryptionKey: a.db.encryptionKey
  })
  await waitForConnection(a.network)
  await waitForConnection(b.network)

  const stream = b.db.changes('messages')
  t.teardown(() => stream.destroy())
  const batches = []
  stream.on('data', (x) => batches.push(x))

  const { data: row } = await a.db.put('messages', { text: 'over the wire' })
  await waitFor(async () => replay(batches).has(row.id) || null)
  t.is(replay(batches).get(row.id).text, 'over the wire')
})

test('changes: singles emit prev/next of the one row', async (t) => {
  const { db } = await bootstrapped(t)
  const stream = db.changes('profile')
  t.teardown(() => stream.destroy())
  const batches = []
  stream.on('data', (b) => batches.push(b))
  await waitFor(async () => batches.length >= 1 || null)

  await db.set('profile', { name: 'first' })
  await waitFor(async () => batches.length >= 2 || null)
  t.is(batches[1].changes[0].prev, null)
  t.is(batches[1].changes[0].next.name, 'first')

  await db.set('profile', { name: 'second' })
  await waitFor(async () => batches.length >= 3 || null)
  t.is(batches[2].changes[0].prev.name, 'first')
  t.is(batches[2].changes[0].next.name, 'second')
})

test('changes: an upgrade rebuild mid-stream re-emits a reset batch', async (t) => {
  const { db, store, identity } = await bootstrapped(t)
  const { wrap } = await import('../../src/database/envelope.js')

  const futureId = genId()
  const future = db.version + 1
  await db.bee.append(
    wrap(future, spec.dispatch.encode('@cero/add-messages', { id: futureId, text: 'future' }))
  )
  const { data: kept } = await db.put('messages', { text: 'kept' })
  await db.bee.update()
  const { key, keyPair } = db
  await db.close()

  const upgraded = { ...spec, meta: { ...spec.meta, version: future } }
  const again = new Database({ store, identity, spec: upgraded, key, keyPair })
  await again.ready()
  t.teardown(() => again.close().catch(() => {}), { order: 4 })

  const stream = again.changes('messages')
  t.teardown(() => stream.destroy())
  const batches = []
  stream.on('data', (b) => batches.push(b))
  await waitFor(async () => batches.length >= 1 || null)

  const map = replay(batches)
  t.is(batches[0].reset, true)
  t.ok(map.has(kept.id), 'pre-upgrade row present')
  t.ok(map.has(futureId), 'once-skipped op included after rebuild')
})

test('write: sets racing close reject cleanly instead of crashing', async (t) => {
  const { db } = await bootstrapped(t)
  const races = []
  for (let i = 0; i < 25; i++) races.push(db.set('messages', { id: `m${i}`, text: 'racer' }))
  const closed = db.close()
  const errors = await Promise.all(
    races.map((p) =>
      p.then(
        () => null,
        (err) => err
      )
    )
  )
  await closed
  for (const err of errors) {
    if (err && !(err.code === 'CLOSED' || err.code === 'NOT_WRITABLE')) {
      t.fail(`write leaked a raw error: ${err.name}: ${err.message}`)
      return
    }
  }
  t.pass('every racing write settled with a clean cero error or success')
})
