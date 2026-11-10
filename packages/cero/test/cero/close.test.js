// Work that races a device's close fails as closing, never as a half-closed storage
import test from 'brittle'
import { Identity } from '@cero-base/core/identity'
import { cero, put, send } from '../../src/index.js'
import { spec } from '../fixtures/spec/index.js'
import { makeTestnet, waitUntil } from '../helpers/index.js'

test.configure({ timeout: 90000 })

async function device(t, opts = {}) {
  const testnet = await makeTestnet(t)
  const errors = []
  const me = await cero(await t.tmp(), spec, {
    bootstrap: testnet.bootstrap,
    onerror: (e) => errors.push(e),
    ...opts
  })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return { me, testnet, errors }
}

test('close: a close under writes reports nothing', async (t) => {
  const { me, errors } = await device(t)
  const room = await cero.open(me.team, { name: 'clinic' })
  const writing = (async () => {
    for (let i = 0; i < 50; i++) await put(room.messages, { text: `m${i}` }).catch(() => {})
  })()
  await new Promise((r) => setTimeout(r, 20))
  await me.close()
  await writing
  t.alike(
    errors.map((e) => e.message),
    [],
    'no closed-storage error reaches onerror'
  )
})

test('close: a send racing the close fails as closing, never as closed storage', async (t) => {
  const { me } = await device(t)
  const closing = me.close()
  const err = await send(me, cero.address(Identity.randomBytes(32)), 'x').catch((e) => e)
  await closing
  t.is(err?.code, 'CLOSED', 'CLOSED')
  t.absent(/Storage/.test(err?.message), `about the mailbox, not storage: ${err?.message}`)
})

test('close: a send after the close fails as closing', async (t) => {
  const { me } = await device(t)
  await me.close()
  const err = await send(me, cero.address(Identity.randomBytes(32)), 'x').catch((e) => e)
  t.is(err?.code, 'CLOSED')
  t.absent(/Storage/.test(err?.message), err?.message)
})

// blind peering reads storage for each database it mirrors: none of that work may still run when storage closes
test('close: mirroring stops before any database closes', async (t) => {
  const { me } = await device(t)
  const room = await cero.open(me.team, { name: 'clinic' })
  const order = []
  const record = (target, method, label) => {
    const run = target[method].bind(target)
    target[method] = async (...args) => {
      order.push(label)
      return run(...args)
    }
  }
  record(me.network, 'closePeering', 'peering')
  record(me.store, 'close', 'root')
  record(room.store, 'close', 'room')
  await me.close()
  t.is(order[0], 'peering', `mirroring stops first: ${order.join(', ')}`)
  t.ok(order.includes('root') && order.includes('room'), 'then the databases close')
  t.exception(() => me.network.peering(), /CLOSED/, 'and takes no more work')
})

test('close: a root suspended with a write in flight closes', async (t) => {
  const { me, errors } = await device(t)
  const room = await cero.open(me.team, { name: 'clinic' })
  const writing = put(room.messages, { text: 'racing' }).then(
    () => 'written',
    (e) => e.code
  )
  await cero.suspend(me)
  const resumes = []
  const resume = me.network.resume.bind(me.network)
  me.network.resume = () => resumes.push('network') && resume()
  let closed = false
  me.close().then(() => (closed = true))
  await waitUntil(() => closed, 20000)
  t.ok(['written', 'CLOSED'].includes(await writing), 'the write settles')
  t.alike(resumes, [], 'the network stays down')
  t.alike(
    errors.map((e) => e.message),
    [],
    'nothing reaches onerror'
  )
})

test('close: a root closed while its suspend is still running closes', async (t) => {
  const { me, errors } = await device(t)
  const room = await cero.open(me.team, { name: 'clinic' })
  const writing = put(room.messages, { text: 'racing' }).then(
    () => 'written',
    (e) => e.code
  )
  // the suspend is past its first step, the storage not yet down, when the close starts
  const suspend = me.network.suspend.bind(me.network)
  const reached = new Promise((resolve) => {
    me.network.suspend = () => {
      resolve()
      return suspend()
    }
  })
  cero.suspend(me).catch(() => {})
  await reached
  let closed = false
  me.close().then(() => (closed = true))
  await waitUntil(() => closed, 20000)
  t.ok(['written', 'CLOSED'].includes(await writing), 'the write settles')
  t.alike(
    errors.map((e) => e.message),
    [],
    'nothing reaches onerror'
  )
})

test('close: a root suspended with nothing in flight closes', async (t) => {
  const { me } = await device(t)
  const room = await cero.open(me.team, { name: 'clinic' })
  await put(room.messages, { text: 'before' })
  await cero.invite(room)
  await cero.suspend(me)
  let closed = false
  me.close().then(() => (closed = true))
  await waitUntil(() => closed, 20000)
  t.ok(me.closed, 'closed')
})

test('close: a room still closing on its own is waited for, so the local store outlives it', async (t) => {
  const { me } = await device(t, { linger: 1 })
  const room = await cero.open(me.team, { name: 'clinic' })
  await me._indexing
  const errors = []
  room._onerror = (err) => errors.push(err)
  const order = []
  const close = me.local.close.bind(me.local)
  me.local.close = () => {
    order.push('local')
    return close()
  }
  room.once('close', () => order.push('room'))
  // its last writers row takes a while to write, as in a big room
  const seal = me._seal.bind(me)
  me._seal = async (child) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return seal(child)
  }
  await cero.close(room)
  await waitUntil(() => !!room.closing)
  await me.close()
  await room.closing.catch(() => {})
  t.alike(order, ['room', 'local'], 'the room closed first')
  t.alike(
    errors.map((e) => e.message),
    [],
    'its row was written with the local store open'
  )
})

// holds one step of the root's close: resolves once the close reached it, and returns its release
function hold(target, method) {
  const original = target[method].bind(target)
  let reached
  let release
  const at = new Promise((resolve) => (reached = resolve))
  const held = new Promise((resolve) => (release = resolve))
  target[method] = async (...args) => {
    reached()
    await held
    return original(...args)
  }
  return { at, release }
}

test('close: a room opened as the root closes fails as closed, and none is opened', async (t) => {
  const { me, errors } = await device(t, { linger: 0 })
  const room = await cero.open(me.team, { name: 'clinic' })
  const { id } = room
  await cero.close(room)
  await me._indexing
  // the root's first step is held, so the open comes once the root listed what it closes
  const step = hold(me.mailbox, 'close')
  let rooms = 0
  const add = me._pending.add.bind(me._pending)
  me._pending.add = (child) => {
    rooms++
    return add(child)
  }
  const closed = me.close()
  await step.at
  const failed = await cero.open(me.team, { id }).catch((err) => err)
  t.is(failed.code, 'CLOSED')
  t.is(rooms, 0, 'no room opens on a root that is closing')
  step.release()
  await closed
  t.alike(
    errors.map((e) => e.message),
    []
  )
})

test('close: a room opened as the stores close under it fails as closed, not as its storage', async (t) => {
  const { me } = await device(t, { linger: 0 })
  const room = await cero.open(me.team, { name: 'clinic' })
  const { id } = room
  await cero.close(room)
  await me._indexing
  const step = hold(me.mailbox, 'close')
  // its read lands on a store mid-close, which fails as that store does
  me._loadKeyPair = async () => {
    throw new Error('Hyperdb is closed')
  }
  const closed = me.close()
  await step.at
  const failed = await cero.open(me.team, { id }).catch((err) => err)
  t.is(failed.code, 'CLOSED', failed.message)
  step.release()
  await closed
})

test('close: an app closed as a room it serves reopens at launch reports nothing', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const errors = []
  const opts = { bootstrap: testnet.bootstrap, onerror: (err) => errors.push(err.message) }
  const first = await cero(dir, spec, opts)
  // a room with a live invite is opened again at every launch, to answer its joins
  const room = await cero.open(first.team, { name: 'clinic' })
  await cero.invite(room)
  await first.close()

  const me = await cero(dir, spec, opts)
  t.is(me._loading.size, 1, 'the room is still reopening')
  await me.close()
  await waitUntil(() => me._loading.size === 0)
  // its failure reaches the handler a turn after the load ends
  await new Promise((resolve) => setTimeout(resolve))
  t.alike(errors, [])
})

test('close: it still opens again on the same storage', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  await put(me.messages, { text: 'kept' })
  await me.close()
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}))
  await waitUntil(async () => (await cero.get(again.messages)).data.length === 1)
  t.pass('reopened with its data')
})
