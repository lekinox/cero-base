import { build } from '@cero-base/cero/build'
import schema, { next } from './schema.js'

await build('./test/fixtures/spec', schema)
// one app at its next release: built from the same history, it sits beside the first
await build('./test/fixtures/spec/next', schema)
await build('./test/fixtures/spec/next', next)
