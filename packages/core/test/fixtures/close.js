import process from 'process'
import Corestore from 'corestore'

import { Network } from '../../src/network/index.js'

// a network that opens and closes in its own process, so a test can time how long the process outlives the close
const [dir, bootstrap, mode] = process.argv.slice(-3)
const store = new Corestore(dir)
const network = new Network({ store, bootstrap: JSON.parse(bootstrap) })
await network.ready()
if (mode === 'flush') await network.flush()
await network.close()
await store.close()
console.log('closed')
