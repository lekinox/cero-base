import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'spec')

await build(out, schema)
console.log(`built spec → ${out}`)
