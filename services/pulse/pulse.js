// A HyperDHT node that passes on when a room was written: a device tells it of a new write, signed
// with a key every member derives from the room, and it passes the time on to the devices that
// follow that key. It keeps one time per key, and sees no room, data or member.
import DHT from 'hyperdht'
import PulseServer from 'hypertracker/server'
import z32 from 'z32'

// The key is a seed kept in `storage`, so it survives restarts.
export async function start({ storage, port, bootstrap }) {
  const dht = new DHT({ port, bootstrap, ephemeral: false, firewalled: false })
  const server = new PulseServer(storage, { dht })
  await server.ready()
  return {
    dht,
    server,
    publicKey: server.publicKey,
    // the times it keeps are written out on close
    async close() {
      await server.close()
      await dht.destroy()
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { STORAGE = '/data', PORT = '49739', BOOTSTRAP } = process.env
  const bootstrap = BOOTSTRAP ? BOOTSTRAP.split(',') : undefined
  start({ storage: STORAGE, port: Number(PORT), bootstrap }).then(
    (service) => {
      console.log(`Listening at ${z32.encode(service.publicKey)}`)
      const stop = () => service.close().then(() => process.exit(0))
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    },
    (e) => {
      console.error(`pulse: ${e.message}`)
      process.exit(1)
    }
  )
}
