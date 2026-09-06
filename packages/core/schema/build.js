import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import Hyperschema from 'hyperschema'

import { NS, types } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'src', 'lib', 'spec')

const schema = Hyperschema.from(out)
const ns = schema.namespace(NS)
for (const desc of types) ns.register(desc)
Hyperschema.toDisk(schema, out, { esm: true })

console.log('built →', out)
