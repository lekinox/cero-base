import test from 'brittle'
import AbortController from 'bare-abort-controller'

import { Ref } from '../../src/handle/index.js'
import { put, set, get, del, watch, call } from '../../src/lib/operators.js'
import { onAbort } from '@cero-base/core/utils'
import { cero } from '../../src/index.js'
import { spec } from '../fixtures/spec/index.js'
import { FakeStore, makeTestnet } from '../helpers/index.js'

test.configure({ timeout: 30000 })

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

test('watch: store.watch(name, q)', async (t) => {
  const { ref, store } = makeRef('messages')
  watch(ref, { limit: 5 })
  t.alike(store.calls[0], { op: 'watch', name: 'messages', arg: { limit: 5 } })
})

test('call: store.call(name, d)', async (t) => {
  const { ref, store } = makeRef('promote', 'action')
  await call(ref, { memberId: 'x' })
  t.alike(store.calls[0], { op: 'call', name: 'promote', arg: { memberId: 'x' } })
})

test('operators: each ref dispatches to its own name', async (t) => {
  const a = makeRef('profile', 'single')
  const b = makeRef('messages', 'collection')
  // share the same fake store so both calls land on it
  b.ref.handle = a.ref.handle

  await set(a.ref, { name: 'a' })
  await put(b.ref, { text: 'b' })
  t.is(a.store.calls[0].name, 'profile')
  t.is(a.store.calls[1].name, 'messages')
})

test('changes: store.changes(name, q), handle refs rejected', async (t) => {
  const { ref, store } = makeRef('messages')
  const { changes } = await import('../../src/lib/operators.js')
  changes(ref, { search: 'x' })
  t.alike(store.calls[0], { op: 'changes', name: 'messages', arg: { search: 'x' } })

  const h = makeRef('room', 'handle')
  t.exception(() => changes(h.ref), /INVALID/, 'handle refs rejected')
})
