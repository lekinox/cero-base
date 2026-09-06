import test from 'brittle'
import b4a from 'b4a'

import { formatHandles, formatState, formatEvent, formatStats } from '../src/format.js'

test('formatHandles: lists the tree with ids and types', (t) => {
  const out = formatHandles([
    { id: 'aaa', type: 'root' },
    { id: 'bbb', type: 'room' }
  ])
  t.ok(out.includes('aaa'), 'shows root id')
  t.ok(out.includes('room'), 'shows child type')
  t.ok(out.includes('2'), 'shows count')
})

test('formatState: summarizes a list reply', (t) => {
  const out = formatState('messages', {
    data: [{ text: 'a' }, { text: 'b' }],
    total: 2,
    size: 2
  })
  t.ok(out.includes('messages'), 'names the ref')
  t.ok(out.includes('2'), 'shows the total')
  t.ok(out.includes('"text"'), 'renders a row as JSON')
})

test('formatState: summarizes a single reply', (t) => {
  const out = formatState('profile', { data: { name: 'jb' } })
  t.ok(out.includes('profile'), 'names the ref')
  t.ok(out.includes('jb'), 'renders the row')
})

test('formatEvent: one line with seq, op, name, shortened writerKey', (t) => {
  const out = formatEvent({
    op: 'put',
    name: 'messages',
    row: { text: 'hi' },
    writerKey: b4a.alloc(32, 1),
    seq: 7
  })
  t.ok(out.includes('#7'), 'shows seq')
  t.ok(out.includes('put'), 'shows op')
  t.ok(out.includes('messages'), 'shows ref name')
  t.ok(out.includes('01010101'), 'shows 8-hex-char writerKey')
  t.is(out.indexOf('\n'), -1, 'single line')
})

test('formatStats: one-line counters with cores', (t) => {
  const out = formatStats({
    network: { connections: 2, peers: 3 },
    bee: { local: 5 },
    cores: [{}, {}]
  })
  t.ok(out.includes('2c'), 'shows connections')
  t.ok(out.includes('3p'), 'shows peers')
  t.ok(out.includes('cores'), 'labels cores')
  t.ok(out.includes('2'), 'shows core count')
})
