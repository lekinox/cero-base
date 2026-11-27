import process from 'process'
import b4a from 'b4a'
import Hyperswarm from 'hyperswarm'

// a peer in its own process that completes the handshake and never writes, so a test can freeze it with SIGSTOP
const [bootstrap, topic] = process.argv.slice(-2)
const swarm = new Hyperswarm({ bootstrap: JSON.parse(bootstrap) })
swarm.on('connection', (conn) => conn.on('error', () => {}))
await swarm.join(b4a.from(topic, 'hex'), { client: false, server: true }).flushed()
console.log('ready')
