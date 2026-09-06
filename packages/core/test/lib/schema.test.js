import test from 'brittle'

import { t as types } from '../../src/lib/schema.js'
import { getHyperdbType } from '@cero-base/cero/build'

test('t.file: plain prim marker', (t) => {
  t.alike(types.file, { prim: 'file' })
})

test('t.required(t.file): keeps the file prim and marks required', (t) => {
  t.alike(types.required(types.file), { prim: 'file', required: true })
})

test('getHyperdbType: file maps to a string column', (t) => {
  t.is(getHyperdbType('file'), 'string')
})
