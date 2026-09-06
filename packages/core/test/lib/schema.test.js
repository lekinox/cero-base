import test from 'brittle'

import { t as types } from '../../src/lib/schema.js'

test('t.file: plain prim marker', (t) => {
  t.alike(types.file, { prim: 'file' })
})

test('t.required(t.file): keeps the file prim and marks required', (t) => {
  t.alike(types.required(types.file), { prim: 'file', required: true })
})
