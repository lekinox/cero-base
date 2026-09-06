import test from 'brittle'

import { t, schema } from '../../src/index.js'

// ─── primitive markers ────────────────────────────────────────────────────

test('t: primitive markers', (t_) => {
  t_.alike(t.string, { prim: 'string' })
  t_.alike(t.uint, { prim: 'uint' })
  t_.alike(t.int, { prim: 'int' })
  t_.alike(t.bool, { prim: 'bool' })
  t_.alike(t.bytes, { prim: 'bytes' })
  t_.alike(t.json, { prim: 'json' })
  t_.alike(t.fixed32, { prim: 'fixed32' })
  t_.alike(t.fixed64, { prim: 'fixed64' })
})

// ─── kind constructors ────────────────────────────────────────────────────

test('t.single(fields) → { kind, fields }', (t_) => {
  t_.alike(t.single({ name: t.string }), {
    kind: 'single',
    fields: { name: { prim: 'string' } }
  })
})

test('t.collection(fields) → { kind, fields }', (t_) => {
  t_.alike(t.collection({ text: t.string }), {
    kind: 'collection',
    fields: { text: { prim: 'string' } }
  })
})

test('t.action(fields) → { kind, fields }', (t_) => {
  t_.alike(t.action({ memberId: t.string, role: t.string }), {
    kind: 'action',
    fields: { memberId: { prim: 'string' }, role: { prim: 'string' } }
  })
})

test('t.required(marker) marks a field required', (t_) => {
  t_.alike(t.required(t.string), { prim: 'string', required: true })
  t_.alike(t.required(t.bytes), { prim: 'bytes', required: true })
  // does not mutate the shared marker
  t_.alike(t.string, { prim: 'string' })
})

test('t.extend(fields) → { kind, fields }', (t_) => {
  t_.alike(t.extend({ avatar: t.bytes }), {
    kind: 'extend',
    fields: { avatar: { prim: 'bytes' } }
  })
})

// ─── schema() ─────────────────────────────────────────────────────────────

test('schema(defs) preserves the declarations', (t_) => {
  const defs = {
    profile: t.single({ name: t.string }),
    messages: t.collection({ text: t.string })
  }
  t_.alike(schema(defs), { defs })
})

test('schema(defs) rejects non-objects', (t_) => {
  t_.exception.all(() => schema(), /object/)
  t_.exception.all(() => schema(null), /object/)
  t_.exception.all(() => schema('nope'), /object/)
})

test('schema() accepts nested handle types', (t_) => {
  const defs = {
    messages: t.collection({ text: t.string }),
    team: {
      messages: t.collection({ text: t.string }),
      promote: t.action({ memberId: t.string })
    }
  }
  t_.alike(schema(defs), { defs })
})

test('schema() accepts a local block', (t_) => {
  const defs = {
    profile: t.single({ name: t.string }),
    local: { drafts: t.collection({ text: t.string }) }
  }
  t_.alike(schema(defs), { defs })
})
