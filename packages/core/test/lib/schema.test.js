import test from 'brittle'

import { t as types } from '../../src/lib/schema.js'

test('t.file: plain prim marker', (t) => {
  t.alike(types.file, { prim: 'file' })
})

test('t.required(t.file): keeps the file prim and marks required', (t) => {
  t.alike(types.required(types.file), { prim: 'file', required: true })
})

test('t: push on a collection, a single and an action keeps the text', (t) => {
  t.is(types.collection({ text: types.string }, { push: 'New message' }).push, 'New message')
  t.is(types.single({ name: types.string }, { push: 'Profile changed' }).push, 'Profile changed')
  t.is(types.action({ x: types.string }, { push: 'Ping' }).push, 'Ping')
  t.absent('push' in types.collection({ text: types.string }), 'absent unless declared')
})
