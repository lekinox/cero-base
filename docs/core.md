# Core primitives

[Docs](README.md) · Previous: [Errors](errors.md) · Next: [Encryption](encryption.md)

```js
import { Identity, Network, Database } from '@cero-base/core'
```

`@cero-base/cero` is a thin composition of seven primitives from `@cero-base/core`, each a small wrapper over a [Pear](https://pears.com) module. Reach for them when you want one piece on its own: just signed pairing, just a replicated database, just a swarm with wakeup, just a typed channel to a worker.

## On this page

- [When to drop down](#when-to-drop-down)
- [Identity](#identity)
- [Network](#network)
- [Database](#database)
- [Pairing](#pairing)
- [Storage](#storage)
- [Blobs](#blobs)
- [RPC](#rpc)
- [How cero puts them together](#how-cero-puts-them-together)
- [What you give up](#what-you-give-up)

## When to drop down

Stay on `cero` for an app. Drop to core for a tool that speaks the same protocol without the schema and handle layer, for a test of one primitive, or for a mirror or relay that needs the network and nothing else. Each primitive is a `ReadyResource`: construct it, `await x.ready()`, `await x.close()`.

```js
import { Identity } from '@cero-base/core/identity'
import { Network } from '@cero-base/core/network'
import { Database } from '@cero-base/core/database'
import { Pairing } from '@cero-base/core/pairing'
import { Storage } from '@cero-base/core/storage'
import { Blobs } from '@cero-base/core/blobs'
import { RPCServer, RPCClient } from '@cero-base/core/rpc'
```

## Identity

A keypair derived from a phrase. It signs, verifies, seals to another identity, and names a swarm topic.

```js
const me = await Identity.generate() // fresh, 12 words
const same = await Identity.fromPhrase(me.toPhrase())

const sig = me.sign(message)
Identity.verify(me.publicKey, message, sig) // true
me.id // z32 public key
me.topic // 32 bytes, the topic this identity announces on
```

`Identity.randomKeyPair()` mints a device keypair. A device core is never signed by the identity keypair, every device authors its own.

## Network

Hyperswarm plus wakeup, with managed discovery sessions.

```js
const net = new Network({ bootstrap, channel: 'my-app' })
await net.ready()

const discovery = net.join(topic) // announce and look up
await discovery.flush() // bounded wait for the first announce
net.attach(core) // replicate a hypercore over every connection
net.detach(core)
await net.suspend() // drop sockets, keep state
await net.resume()
```

`join(topic, { mode })` takes `'active'` or `'passive'`. `net.blind()` gives the shared blind-pairing instance, and `net.inject(stream)` feeds a connection you made yourself, a Bluetooth link for instance.

## Database

A multi-writer database on autobee with a hyperdb view: dispatch routing, permission checks at apply time, hooks, writer admission and key rotation. It takes a Corestore, an identity, a network and a built spec.

```js
import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'

const root = new HypercoreStorage('./data')
const store = new Corestore(root, { manifestVersion: 2 })
await store.ready()

const db = new Database({ store, identity, network, spec })
await db.ready()
await db.bootstrap({ name: 'laptop' }) // this device becomes the first writer

await db.put('messages', { text: 'hi' })
const { data } = await db.get('messages', { limit: 10, reverse: true })
db.before('put', (ctx) => {
  if (!ctx.row.text) return false
})
```

`spec` is one built scope: `spec.main` or `spec.handles.room` from a cero build, with `database`, `dispatch` and `meta` on it. `db.key` identifies the database, `db.writerKey` this device's core.

A second device of the same identity opens the same key and enrolls with `db.bootstrap({ recovering: true })`: it waits for the others' state, admits itself with an add-writer signed by the identity, and records its device row. A member who was handed the key and encryption key through pairing calls `db.claim()` and `db.whenWritable()` instead. `db.addWriter(key)` and `db.removeWriter(key)` manage other writers, `db.rotate()` starts a new encryption epoch.

## Pairing

Blind pairing with signed invites. The host mints, the joiner presents, the host confirms with the keys.

```js
const pair = new Pairing({ network, identity, topic: db.key })
await pair.ready()

const invite = await pair.createInvite({ role: 'member', expiresIn: 3600_000 })

pair.on('candidate', async (request) => {
  await request.confirm({ key: db.key, encryptionKey: db.encryptionKey })
})

// on the joiner
const { key, encryptionKey } = await pair.join(invite, { userData, timeout: 30000 })
```

`userData` is required: the joiner's public key travels in it, and the host binds the admission to it. `request.deny(reason)` refuses. `Pairing.inviteTopic(invite)` tells you which database an invite targets without pairing, and `pair.revoke(invite)` stops serving one.

## Storage

Local tables on hyperbee or RocksDB with the same operator surface, for device-only data. cero's `local` scope is one of these.

```js
const local = Storage.bee('./data/local', { spec: { database, meta } })
await local.ready()
await local.put('settings', { id: 'theme', value: 'dark' })
const { data } = await local.get('settings', 'theme')
```

`Storage.rocks(dir, opts)` uses RocksDB instead. Both take the same queries as `Database.get`.

## Blobs

Content-addressed bytes in a hyperblobs core, one per handle, encrypted with the handle's epoch key.

```js
const blobs = new Blobs({ store, identity, network })
await blobs.ready()
const id = await blobs.put(bytes)
const back = await blobs.get(id)
blobs.createReadStream(id).pipe(res)
```

`cero.put(handle.files, ...)` is this plus a `files` row and a local url.

## RPC

A typed channel over any duplex stream: hrpc on a length-framed pipe, the request and response types coming from the spec. One side serves, the other calls, and the pair is what separates a worker from a UI.

```js
import { RPCServer, RPCClient } from '@cero-base/core/rpc'

class Server extends RPCServer {
  async _open() {
    await super._open()
    this.rpc.onPing(async (m) => `pong:${m}`)
  }
}
const server = new Server(ipc, spec)
const client = new RPCClient(ipc2, spec)
await server.ready()
await client.ready()
await client.rpc.ping('hi') // 'pong:hi'
```

`serve(ipc, spec)` and `connect(ipc, spec)` are this with cero's own handlers on one end and its operators on the other.

## How cero puts them together

`cero(dir, spec)` opens a Corestore under `dir`, resolves or generates the `Identity`, starts one `Network`, and opens the root `Database` on `spec.main`. A `Storage` under `dir` holds the device's writer keypair and the `local` scope. Every child handle is another `Database` on `spec.handles.<type>` with its own `Blobs` and a `Pairing` on its key, sharing the root's network and identity. The operators are one-line wrappers around `Database` methods, plus the resolution of refs and files. In a split app, `serve` puts all of that behind an `RPCServer` and `connect` speaks to it through an `RPCClient`.

## What you give up

No refs, so collection names are strings. No handle list, no invites persisted as rows, no auto-accept, no extensions, no operators over the channel, no file urls. You write the composition yourself, which is the point.

## Next

- [Encryption](encryption.md) for epochs and rotation, which live in the database.
- [Handles](handles.md) for what cero builds on top of pairing.
- [API reference](api.md) for the surface cero exposes instead.
