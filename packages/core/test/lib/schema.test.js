import test from 'brittle'

import { t as types } from '../../src/lib/schema.js'

test('t.file: plain prim marker', (t) => {
  t.alike(types.file, { prim: 'file' })
})

test('t.required(t.file): keeps the file prim and marks required', (t) => {
  t.alike(types.required(types.file), { prim: 'file', required: true })
})

test('t: push on a collection, a single and an action is a flag, never a text', (t) => {
  t.is(types.collection({ text: types.string }, { push: true }).push, true)
  t.is(types.single({ name: types.string }, { push: true }).push, true)
  t.is(types.action({ x: types.string }, { push: 'Ping' }).push, true, 'a text is only the flag')
  t.absent('push' in types.collection({ text: types.string }), 'absent unless declared')
})
