import { build } from '@cero-base/cero/build'
import schema from './schema.js'

await build('./test/fixtures/spec', schema)
