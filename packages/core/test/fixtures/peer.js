import process from 'process'
import b4a from 'b4a'

import { Network } from '../../src/network/index.js'

// a peer in its own process, announcing a topic, so a test can freeze it with SIGSTOP
const [bootstrap, topic] = process.argv.slice(-2)
const net = new Network({ bootstrap: JSON.parse(bootstrap), onerror: () => {} })
await net.ready()
net.on('connection', (conn) => conn.on('error', () => {}))
await net.join(b4a.from(topic, 'hex'), { mode: 'passive' }).flush()
console.log('ready')
