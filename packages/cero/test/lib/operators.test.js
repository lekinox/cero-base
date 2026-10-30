import test from 'brittle'
import AbortController from 'bare-abort-controller'
import process from 'process'
import { rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { Readable } from 'streamx'
import b4a from 'b4a'

import { Ref } from '../../src/handle/index.js'
import { put, set, get, del, watch, call, open, send, inbox } from '../../src/lib/operators.js'
import { onAbort } from '@cero-base/core/utils'
import { cero } from '../../src/index.js'
import { build } from '../../src/build/index.js'
import { spec } from '../fixtures/spec/index.js'
import { FakeStore, makeTestnet, waitUntil, ceroOpen } from '../helpers/index.js'
import { Identity } from '@cero-base/core/identity'
import { Mailbox } from '@cero-base/core/mailbox'
import hid from 'hypercore-id-encoding'
import c from 'compact-encoding'
import { seal } from '../../src/lib/mail.js'

test.configure({ timeout: 30000 })

const buildRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  '.build-operators'
)
process.on('exit', () => rmSync(buildRoot, { recursive: true, force: true }))

test('onAbort: returns a disposer that detaches the listener early', (t) => {
  const ctrl = new AbortController()
  let fired = 0
  const stop = onAbort(ctrl.signal, () => fired++)
  t.is(typeof stop, 'function', 'returns a disposer')
  stop() // manual unsubscribe — detach before abort
  ctrl.abort()
  t.is(fired, 0, 'listener detached, did not fire (no leak on the long-lived signal)')
})

test('onAbort: still fires on abort when not detached', (t) => {
  const ctrl = new AbortController()
  let fired = 0
  onAbort(ctrl.signal, () => fired++)
  ctrl.abort()
  t.is(fired, 1)
})

test('Ref.attach: refuses to clobber a reserved member (fail loud)', (t) => {
  const target = { close() {} }
  let msg = ''
  try {
    Ref.attach(target, { close: { kind: 'collection' } })
  } catch (e) {
    msg = e.message
  }
  t.ok(/close/.test(msg), 'a ref named like a reserved member throws instead of clobbering')
  t.is(typeof target.close, 'function', 'the reserved member is left intact')
})

test('Ref.attach: attaches a non-colliding ref', (t) => {
  const target = {}
  Ref.attach(target, { messages: { kind: 'collection', schema: '@x/messages' } })
  t.is(target.messages.name, 'messages')
  t.is(target.messages.kind, 'collection')
})

function makeRef(name, kind = 'collection') {
  const store = new FakeStore({ [name]: { kind } })
  const handle = { store }
  return { ref: new Ref(handle, name, kind), store }
}

test('put: store.put(name, row)', async (t) => {
  const { ref, store } = makeRef('messages')
  const row = { text: 'hi' }
  const r = await put(ref, row)
  t.alike(store.calls[0], { op: 'put', name: 'messages', arg: row })
  t.alike(r, { op: 'put', name: 'messages', arg: row })
})

test('set: store.set(name, row)', async (t) => {
  const { ref, store } = makeRef('profile', 'single')
  await set(ref, { name: 'jb' })
  t.alike(store.calls[0], { op: 'set', name: 'profile', arg: { name: 'jb' } })
})

test('get: store.get(name, q)', async (t) => {
  const { ref, store } = makeRef('messages')
  await get(ref)
  t.alike(store.calls[0], { op: 'get', name: 'messages', arg: undefined })
  await get(ref, { limit: 10 })
  t.alike(store.calls[1], { op: 'get', name: 'messages', arg: { limit: 10 } })
})

test('del: store.del(name, id)', async (t) => {
  const { ref, store } = makeRef('messages')
  await del(ref, 'abc')
  t.alike(store.calls[0], { op: 'del', name: 'messages', arg: 'abc' })
})

test('watch: store.watch(name, q), without the changes flag', async (t) => {
  const { ref, store } = makeRef('messages')
  watch(ref, { limit: 5, changes: true })
  t.alike(store.calls[0], { op: 'watch', name: 'messages', arg: { limit: 5 } })
})

test('call: store.call(name, d)', async (t) => {
  const { ref, store } = makeRef('promote', 'action')
  await call(ref, { memberId: 'x' })
  t.alike(store.calls[0], { op: 'call', name: 'promote', arg: { memberId: 'x' } })
})

test('operators: each ref dispatches to its own name', async (t) => {
  const store = new FakeStore({ profile: { kind: 'single' }, messages: { kind: 'collection' } })
  const handle = { store }
  await set(new Ref(handle, 'profile', 'single'), { name: 'a' })
  await put(new Ref(handle, 'messages', 'collection'), { text: 'b' })
  t.is(store.calls[0].name, 'profile')
  t.is(store.calls[1].name, 'messages')
})

test('watch: changes are opt-in', async (t) => {
  const { ref, store } = makeRef('messages')
  const src = new Readable()
  store.watch = () => src
  const items = []
  watch(ref).on('data', (item) => items.push(item))
  src.push({ data: [{ id: 'a' }] })
  await waitUntil(() => items.length || null)
  t.alike(items[0], { data: [{ id: 'a' }] }, 'the snapshot alone')
})

test('watch: replaying the changes of every item rebuilds its data', async (t) => {
  const { ref, store } = makeRef('messages')
  const src = new Readable()
  store.watch = () => src
  const items = []
  watch(ref, { changes: true }).on('data', (item) => items.push(item))
  const a1 = { id: 'a', text: '1' }
  const b1 = { id: 'b', text: '1' }
  for (const data of [[a1], [a1, b1], [{ id: 'a', text: '2' }, b1], [b1]]) src.push({ data })
  await waitUntil(() => items.at(-1)?.data.length === 1 || null)

  t.ok(items[0].reset, 'the first item resets')
  t.absent(items.slice(1).some((item) => item.reset))
  const rows = new Map()
  for (const { changes } of items) {
    for (const { prev, next } of changes) {
      if (next) rows.set(next.id, next)
      else rows.delete(prev.id)
    }
  }
  t.alike([...rows.values()], [b1])
})

test('get and watch: an id reads one row, a room too', async (t) => {
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close())
  const room = await open(me.team, { name: 'a' })
  const { data: row } = await put(me.messages, { text: 'hi' })
  const first = async (stream) => {
    for await (const snap of stream) return snap
  }
  t.is((await get(me.team, room.id)).data?.name, 'a', 'a room by id')
  t.is((await get(me.team, 'nope')).data, null)
  t.alike(await first(watch(me.team, room.id)), await get(me.team, room.id))
  t.alike(await first(watch(me.messages, row.id)), await get(me.messages, row.id))
})

test('get: rooms list in the order they were added', async (t) => {
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close())
  const names = ['a', 'b', 'c', 'd', 'e', 'f']
  for (const name of names) await open(me.team, { name })
  t.alike(
    (await get(me.team)).data.map((row) => row.name),
    names
  )
})

async function twoTypes(t) {
  const dir = join(buildRoot, 'two-types')
  const notes = { notes: cero.t.collection({ text: cero.t.string }) }
  await build(dir, cero.schema({ expo: notes, group: notes }), { extensions: [] })
  const { spec: two } = await import(pathToFileURL(join(dir, 'index.js')).href)
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), two, { bootstrap: testnet.bootstrap, extensions: [] })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return me
}

test('handle refs: limit and total count only their own type', async (t) => {
  const me = await twoTypes(t)
  for (const n of [1, 2, 3]) {
    await open(me.group, { name: `group ${n}` })
    await open(me.expo, { name: `expo ${n}` })
  }

  const { data, total } = await get(me.expo, { limit: 2, total: true })
  t.alike(
    data.map((r) => r.name),
    ['expo 1', 'expo 2'],
    'a full page of expos'
  )
  t.is(total, 3, 'every expo counted, no group')

  const first = await new Promise((resolve) => {
    watch(me.expo, { limit: 2, total: true }).once('data', resolve)
  })
  t.is(first.data.length, 2, 'a watch pages the same')
  t.is(first.total, 3)
})

test('open by id: a handle of another type is INVALID, open or not', async (t) => {
  const me = await twoTypes(t)
  const expo = await open(me.expo, { name: 'fair' })
  await t.exception(open(me.group, { id: expo.id }), /INVALID/, 'while it is open')
  await expo.close()
  await t.exception(open(me.group, { id: expo.id }), /INVALID/, 'once it closed')
  t.is((await open(me.expo, { id: expo.id })).id, expo.id, 'its own type opens it')
})

test('singles: put is INVALID, and set returns the record with no fields of its own', async (t) => {
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  const cases = [
    [me.profile, { name: 'Ada' }],
    [me.local.settings, { entropy: b4a.from('seed') }]
  ]
  for (const [ref, row] of cases) {
    await t.exception(put(ref, row), /INVALID.*set/, `put on ${ref.name} says to use set`)
    const { data: written } = await set(ref, row)
    const { data: read } = await get(ref)
    for (const k of Object.keys(row)) t.alike(written[k], read[k], `${ref.name}.${k} as stored`)
    t.absent('createdAt' in written || 'updatedAt' in written, 'a single has no timestamps')
  }
})

test('open: an argument it does not know is INVALID, never a new handle', async (t) => {
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  for (const arg of [
    { id: undefined },
    { nmae: 'typo' },
    { name: 'a', id: 'b' },
    { invite: 5 },
    null,
    42
  ]) {
    await t.exception(open(me.team, arg), /INVALID/, JSON.stringify(arg))
  }
  t.is((await get(me.team)).data.length, 0, 'nothing was created')
  t.ok((await open(me.team, { name: 'real' })).id, '{ name } creates')
  t.ok((await open(me.team)).id, 'no argument creates too')
  t.is((await get(me.team)).data.length, 2)
})

// two devices of two people on one testnet, and an address only the second can open
async function mailPair(t) {
  const { me: a, testnet } = await ceroOpen(t)
  const { me: b } = await ceroOpen(t, { testnet })
  const secret = Identity.randomBytes(32)
  return { a, b, secret, address: cero.address(secret) }
}

test('cero.address: one secret, one address, as a string', (t) => {
  const secret = Identity.randomBytes(32)
  t.is(typeof cero.address(secret), 'string')
  t.is(cero.address(secret), cero.address(secret))
  t.is(cero.address(secret), hid.encode(Mailbox.getAddress(secret)))
  t.not(cero.address(Identity.randomBytes(32)), cero.address(secret))
})

test('send → inbox: any value arrives with its verified sender', async (t) => {
  const { a, b, secret, address } = await mailPair(t)
  const got = []
  const stop = inbox(b, secret, (data, sender) => got.push({ data, sender }))
  t.teardown(stop)

  await send(a, address, { kind: 'pass', unit: 5, at: [1, 2] })

  await waitUntil(() => got.length > 0)
  t.alike(got[0].data, { kind: 'pass', unit: 5, at: [1, 2] })
  t.is(got[0].sender.from, a.identity.id, 'from is the sender identity')
  t.is(got[0].sender.device, a.identity.device.id, 'device is the sending device')
})

test('inbox: a message signed for another address is dropped', async (t) => {
  const { a, b, secret, address } = await mailPair(t)
  const got = []
  t.teardown(inbox(b, secret, (data) => got.push(data)))

  // a valid envelope, but sealed for somewhere else and redirected here
  const elsewhere = Mailbox.getAddress(Identity.randomBytes(32))
  await a.mailbox.send(hid.decode(address), seal(a.identity, elsewhere, 'redirected'))
  await send(a, address, 'meant')

  await waitUntil(() => got.length > 0)
  t.alike(got, ['meant'])
})

test('inbox: bytes that are no envelope are dropped', async (t) => {
  const { a, b, secret, address } = await mailPair(t)
  const got = []
  t.teardown(inbox(b, secret, (data) => got.push(data)))

  await a.mailbox.send(hid.decode(address), b4a.from('not an envelope'))
  await send(a, address, 'signed')

  await waitUntil(() => got.length > 0)
  t.alike(got, ['signed'])
  await waitUntil(async () => (await b.mailbox.inbox.list()).length === 0)
  t.pass('nothing kept to hand over again')
})

test('inbox: a tampered message is dropped', async (t) => {
  const { a, b, secret, address } = await mailPair(t)
  const got = []
  t.teardown(inbox(b, secret, (data) => got.push(data)))

  // the same proof over different data
  const to = hid.decode(address)
  const { proof } = c.decode(c.any, seal(a.identity, to, 'original'))
  const forged = c.encode(c.any, { data: c.encode(c.any, 'forged'), proof })
  await a.mailbox.send(to, forged)
  await send(a, address, 'intact')

  await waitUntil(() => got.length > 0)
  t.alike(got, ['intact'])
})

test('inbox: what was sent while nobody listened arrives once it starts', async (t) => {
  const { a, b, secret, address } = await mailPair(t)
  const stop = inbox(b, secret, () => {})
  await stop()

  await send(a, address, 'waited')
  const got = await new Promise((resolve) => {
    t.teardown(inbox(b, secret, resolve))
  })
  t.is(got, 'waited')
})

test('send and inbox pass keep on to the mailbox', async (t) => {
  const { a, b, secret, address } = await mailPair(t)
  const seen = []
  const receive = b.mailbox.receive.bind(b.mailbox)
  b.mailbox.receive = (s, fn, opts) => seen.push(['receive', opts]) && receive(s, fn, opts)
  const post = a.mailbox.send.bind(a.mailbox)
  a.mailbox.send = (to, m, opts) => seen.push(['send', opts]) && post(to, m, opts)

  const got = []
  t.teardown(inbox(b, secret, (data) => got.push(data), { keep: false }))
  await send(a, address, 'x', { keep: false })
  await waitUntil(() => got.length > 0)
  t.alike(seen, [
    ['receive', { keep: false }],
    ['send', { keep: false }]
  ])
})

test('send and inbox keep by default', async (t) => {
  const { a, b, secret, address } = await mailPair(t)
  const seen = []
  const receive = b.mailbox.receive.bind(b.mailbox)
  b.mailbox.receive = (s, fn, opts) => seen.push(opts.keep) && receive(s, fn, opts)
  const post = a.mailbox.send.bind(a.mailbox)
  a.mailbox.send = (to, m, opts) => seen.push(opts.keep) && post(to, m, opts)

  const got = []
  t.teardown(inbox(b, secret, (data) => got.push(data)))
  await send(a, address, 'x')
  await waitUntil(() => got.length > 0)
  t.alike(seen, [true, true])
})

test('send: an address that is not one is INVALID', async (t) => {
  const { a } = await mailPair(t)
  await t.exception(send(a, 'nope', 'x'), /INVALID/)
})
