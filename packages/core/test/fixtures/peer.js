import process from 'process'
import b4a from 'b4a'
import Corestore from 'corestore'

import { Network } from '../../src/network/index.js'

// a peer in its own process, announcing a topic, so a test can freeze it with SIGSTOP
const [dir, bootstrap, topic] = process.argv.slice(-3)
const net = new Network({
  bootstrap: JSON.parse(bootstrap),
  store: new Corestore(dir),
  onerror: () => {}
})
await net.ready()
net.on('connection', (conn) => conn.on('error', () => {}))
await net.join(b4a.from(topic, 'hex'), { mode: 'passive' }).flush()
console.log('ready')
