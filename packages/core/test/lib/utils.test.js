import test from 'brittle'

import { can, filter, WRITE, INVITE, ASSIGN, REMOVE } from '../../src/lib/utils.js'

test('can: the permissions each role has, as the docs list them', (t) => {
  const table = {
    owner: [true, true, true, true],
    admin: [true, true, true, true],
    member: [true, true, false, false],
    reader: [false, false, false, false]
  }
  for (const [role, row] of Object.entries(table)) {
    t.alike(
      [WRITE, INVITE, ASSIGN, REMOVE].map((perm) => can(role, perm)),
      row,
      role
    )
  }
})

test('can: a permission it does not know is INVALID, not a guess', (t) => {
  for (const perm of ['delete', 'read', 'admin', '']) {
    t.exception(() => can('admin', perm), /INVALID/, JSON.stringify(perm))
  }
  t.is(can('nobody', WRITE), false, 'an unknown role grants nothing')
})

test('filter: fields is a list of names, anything else is INVALID', (t) => {
  const rows = [
    { id: 'a', text: 'hello', note: 'x' },
    { id: 'b', text: 'x', note: 'hello' }
  ]
  t.alike(
    filter(rows, { search: 'hel', fields: ['text'] }).map((r) => r.id),
    ['a'],
    'a list searches those fields'
  )
  t.alike(filter(rows, { search: 'hel', fields: [] }).length, 2, 'an empty list searches them all')
  for (const fields of ['text', { text: true }, 1]) {
    t.exception(() => filter(rows, { search: 'hel', fields }), /INVALID/, JSON.stringify(fields))
  }
})
