import { build } from '@cero-base/cero/build'
import { bundled, pulse } from '@cero-base/cero/extensions'
import schema, { next } from './schema.js'

await build('./test/fixtures/spec', schema)
// one app at its next release: built from the same history, it sits beside the first
await build('./test/fixtures/spec/next', schema)
await build('./test/fixtures/spec/next', next)
// the app with pulse folded in: cero() takes the list
await build('./test/fixtures/spec/pulse', schema, { extensions: [...bundled, pulse()] })
