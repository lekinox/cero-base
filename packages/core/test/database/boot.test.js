// Upstream-behavior canaries for autobee's fastForward.boot — the API cero
// intends to adopt for recovery. Each probe pins a wiring dimension of the
// dead-writer + passive-holder scenario against plain autobee: full and
// key-only seed heads, cero's corestore-stream + shared-wakeup transport,
// the non-owning wakeup facade, epoch encryption, and the swap-reopen shape.
import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'
import Autobee from 'autobee'
import ProtomuxWakeup from 'protomux-wakeup'
import crypto from 'hypercore-crypto'
import { EpochAutobee, Keyring } from '../../src/database/encryption.js'

const encode = (v) => b4a.from(JSON.stringify(v))

async function apply(nodes, view) {
  for (const node of nodes) {
    const w = view.write()
    w.tryPut(b4a.from('latest'), node.value)
    await w.flush()
  }
}

async function create(t, key, opts = {}) {
  const store = new Corestore(await t.tmp(), { manifestVersion: 2 })
  const auto = new Autobee(store, key || null, { apply, ...opts })
  t.teardown(() => auto.close().catch(() => {}), { order: 5 })
  await auto.ready()
  return auto
}

function connect(a, b) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  s1.on('error', () => {})
  s2.on('error', () => {})
  return () => {
    s1.destroy()
    s2.destroy()
  }
}

const until = (fn, ms = 15000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = async () => {
      if (await fn()) return resolve(true)
      if (Date.now() - t0 > ms) return reject(new Error('until timeout'))
      setTimeout(tick, 100)
    }
    tick()
  })

async function scenario(t, label, makeBooter) {
  // origin writes history, passive holder replicates it all, origin dies
  const a = await create(t)
  for (let i = 0; i < 40; i++) await a.append(encode({ value: 'v' + i }))
  const head = { key: a.local.key, length: a.local.length }
  const dbKey = a.key

  const b = await create(t, dbKey)
  const stop = connect(a, b)
  await until(async () => (await b.bee.get(b4a.from('latest'))) !== null)
  stop()
  await a.close()

  const c = await makeBooter(dbKey, head)
  connect(c, b)

  const moved = await Promise.race([
    new Promise((r) => c.once('move-to', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 20000))
  ])
  console.log(`[${label}] ${moved ? 'BOOTED' : 'WEDGED'}`)
  return moved
}

const boot = (head) => ({
  isTrusted: () => true,
  fastForward: {
    boot: { head, bootCondition: async (view) => (await view.get(b4a.from('latest'))) !== null }
  }
})

test('P1: full head {key,length}, dead writer, passive holder', async (t) => {
  const ok = await scenario(t, 'P1 full-head', (dbKey, head) => create(t, dbKey, boot(head)))
  t.ok(ok, 'boots from a passive holder with a real head')
})

test('P2: key-only head (cero shape)', async (t) => {
  const ok = await scenario(t, 'P2 key-only', (dbKey) => create(t, dbKey, boot({ key: dbKey })))
  t.ok(ok, 'boots with a key-only seed head')
})

test('P4: cero transport — corestore streams + shared wakeup both sides', async (t) => {
  const wakeups = []
  const facadeFor = (t) => {
    const shared = new ProtomuxWakeup()
    wakeups.push(shared)
    t.teardown(() => shared.destroy())
    return {
      shared,
      facade: {
        addStream: (s) => shared.addStream(s),
        session: (...a) => shared.session(...a),
        destroy: () => {}
      }
    }
  }
  // origin with its own wakeup wiring (cero-style)
  const wa = facadeFor(t)
  const storeA = new Corestore(await t.tmp(), { manifestVersion: 2 })
  const a = new Autobee(storeA, null, { apply, wakeup: wa.facade })
  t.teardown(() => a.close().catch(() => {}), { order: 5 })
  await a.ready()
  for (let i = 0; i < 40; i++) await a.append(encode({ value: 'v' + i }))
  const head = { key: a.local.key, length: a.local.length }
  const dbKey = a.key

  const wb = facadeFor(t)
  const storeB = new Corestore(await t.tmp(), { manifestVersion: 2 })
  const b = new Autobee(storeB, dbKey, { apply, wakeup: wb.facade })
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  await b.ready()

  const wire = (s1, s2, sh1, sh2) => {
    s1.pipe(s2).pipe(s1)
    s1.on('error', () => {})
    s2.on('error', () => {})
    sh1.addStream(s1.noiseStream || s1)
    sh2.addStream(s2.noiseStream || s2)
    return () => {
      s1.destroy()
      s2.destroy()
    }
  }

  let s1 = storeA.replicate(true)
  let s2 = storeB.replicate(false)
  const stop = wire(s1, s2, wa.shared, wb.shared)
  await until(async () => (await b.bee.get(b4a.from('latest'))) !== null)
  stop()
  await a.close()

  const wc = facadeFor(t)
  const storeC = new Corestore(await t.tmp(), { manifestVersion: 2 })
  const c = new Autobee(storeC, dbKey, { apply, ...boot(head), wakeup: wc.facade })
  t.teardown(() => c.close().catch(() => {}), { order: 5 })
  await c.ready()

  s1 = storeC.replicate(true)
  s2 = storeB.replicate(false)
  wire(s1, s2, wc.shared, wb.shared)

  const moved = await Promise.race([
    new Promise((r) => c.once('move-to', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 20000))
  ])
  console.log(`[P4 cero-transport] ${moved ? 'BOOTED' : 'WEDGED'}`)
  t.ok(moved, 'boots over corestore streams with shared wakeups')
})

test('P3: full head + cero-style wakeup facade', async (t) => {
  const shared = new ProtomuxWakeup()
  t.teardown(() => shared.destroy())
  const facade = {
    addStream: (s) => shared.addStream(s),
    session: (...a) => shared.session(...a),
    destroy: () => {}
  }
  const ok = await scenario(t, 'P3 facade', (dbKey, head) =>
    create(t, dbKey, { ...boot(head), wakeup: facade })
  )
  t.ok(ok, 'boots with the non-owning wakeup facade')
})

test('P5: EpochAutobee + encryptionKey (epoch 0, no rotation)', async (t) => {
  const encryptionKey = crypto.randomBytes(32)
  const mk = async (key, extra = {}) => {
    const store = new Corestore(await t.tmp(), { manifestVersion: 2 })
    const auto = new EpochAutobee(store, key || null, {
      apply,
      encryptionKey,
      keyring: new Keyring(),
      optimistic: true,
      ...extra
    })
    t.teardown(() => auto.close().catch(() => {}), { order: 5 })
    await auto.ready()
    return auto
  }
  const a = await mk(null)
  for (let i = 0; i < 40; i++) await a.append(encode({ value: 'v' + i }))
  const head = { key: a.local.key, length: a.local.length }
  const b = await mk(a.key)
  const stop = connect(a, b)
  await until(async () => (await b.bee.get(b4a.from('latest'))) !== null)
  stop()
  const dbKey = a.key
  await a.close()

  const c = await mk(dbKey, boot(head))
  connect(c, b)
  const moved = await Promise.race([
    new Promise((r) => c.once('move-to', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 20000))
  ])
  console.log(`[P5 epoch-encrypted] ${moved ? 'BOOTED' : 'WEDGED'}`)
  t.ok(moved, 'boots with cero epoch encryption at epoch 0')
})

test('P6: boot opts on a swap-reopen (prior bee on same store, cero recovery shape)', async (t) => {
  const encryptionKey = crypto.randomBytes(32)
  const mkStore = async () => new Corestore(await t.tmp(), { manifestVersion: 2 })
  const mk = async (store, key, extra = {}) => {
    const auto = new EpochAutobee(store.namespace('cero'), key || null, {
      apply,
      encryptionKey,
      keyring: new Keyring(),
      optimistic: true,
      ...extra
    })
    await auto.ready()
    return auto
  }
  const storeA = await mkStore()
  const identityKP = crypto.keyPair()
  const a = await mk(storeA, null, { keyPair: identityKP })
  t.teardown(() => a.close().catch(() => {}), { order: 5 })
  for (let i = 0; i < 40; i++) await a.append(encode({ value: 'v' + i }))
  const head = { key: a.local.key, length: a.local.length }
  const dbKey = a.key

  const storeB = await mkStore()
  const b = await mk(storeB, dbKey)
  t.teardown(() => b.close().catch(() => {}), { order: 5 })
  const stop = connect(a, b)
  await until(async () => (await b.bee.get(b4a.from('latest'))) !== null)
  stop()
  await a.close()

  // recovering device: first open with the SAME identity keypair (genesis
  // shape), close, reopen with a fresh device keypair + boot opts — the swap
  const storeC = await mkStore()
  const first = await mk(storeC, dbKey, { keyPair: identityKP })
  await first.close()
  const deviceKP = crypto.keyPair()
  const c = await mk(storeC, dbKey, { keyPair: deviceKP, ...boot(head) })
  t.teardown(() => c.close().catch(() => {}), { order: 5 })
  connect(c, b)
  const moved = await Promise.race([
    new Promise((r) => c.once('move-to', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 20000))
  ])
  console.log(`[P6 swap-reopen] ${moved ? 'BOOTED' : 'WEDGED'}`)
  t.ok(moved, 'boot opts work on a reopened store with a new keyPair')
})
