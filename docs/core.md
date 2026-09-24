# Core primitives

[Docs](README.md) · Previous: [Errors](errors.md) · Next: [Encryption](encryption.md)

```js
import { Identity, Network, Database } from '@cero-base/core'
```

`@cero-base/cero` is a thin composition of eight primitives from `@cero-base/core`, each a small wrapper over a [Pear](https://pears.com) module. Reach for them when you want one piece on its own: just invites and pairing, just a mailbox, just a replicated database, just a swarm with wakeup, just a typed channel to a worker.

## On this page

- [When to drop down](#when-to-drop-down)
- [Identity](#identity)
- [Network](#network)
- [Database](#database)
- [Mailbox](#mailbox)
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
const identity = await Identity.create() // or { words: 24 }
const phrase = identity.toPhrase() // show it once, the user writes it down

// later, on any device
const restored = await Identity.create({ seed: Identity.toSeed(phrase) })
restored.id === identity.id // true

const signature = identity.sign(message)
Identity.verify(identity.publicKey, message, signature) // true
identity.id // z32 public key
identity.topic // the topic this identity announces on
```

`create` makes a fresh identity, a 12-word seed or `{ words: 24 }`. Given a `seed`, 16 or 32 bytes, it restores that one. The phrase is the seed written out for people: `Identity.toSeed(phrase)` and `identity.toPhrase()` convert at the edge.

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

`join(topic, { mode })` takes `'active'` or `'passive'`. `net.peering()` gives the blind-peering client that deposits on mirrors, and `net.inject(stream)` feeds a connection you made yourself, a Bluetooth link for instance.

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

A second device of the same identity opens the same key and enrolls with `db.bootstrap({ recovering: true })`: it waits for the others' state, admits itself with an add-writer signed by the identity, and records its device row. A member admitted through pairing needs nothing: the join its device wrote into its own core seats it, and `db.whenWritable()` resolves once that lands. Only the genesis batch names a member directly, its creator; everyone after comes in through a join. Nobody seats a writer for another identity. `db.addWriter(key)` admits another device of your own identity, `db.removeWriter(key)` removes one, `db.rotate()` starts a new encryption epoch.

## Mailbox

A device's mailbox: it receives at the addresses it holds the secret of, and sends to any address. An address is 32 bytes you can share; anyone can send to it, only its secret opens what arrives. A message is delivered directly when its owner is online, and otherwise waits on a mirror until they come back.

```js
import { Identity, Mailbox } from '@cero-base/core'

const mailbox = new Mailbox(network) // the network needs a store: messages travel as cores in it
await mailbox.ready()

const secret = Identity.randomBytes(32) // yours to keep: whoever holds it receives
const address = Mailbox.getAddress(secret) // share this

const inbox = mailbox.receive(secret, (message) => {
  console.log(b4a.toString(message))
})

await mailbox.send(address, b4a.from('hi'))

await inbox.close() // stop receiving
```

Both ends keep their mail until it is done with: the outbox until someone reads it, the inbox until `onmessage` resolves. Give it persistent boxes, `new Mailbox(network, { inbox, outbox })`, each any `{ list, put, del }`, and that survives a restart: what was not read is sent again and what was not handled is handed over again, so a message may arrive twice but never gets lost. A throwing `onmessage` keeps the message and reports to `onerror`. `send(address, message, { mirrors })` picks the mirrors a message waits on, the network's by default. A message is anonymous: one that needs a sender carries its own signature.

## Pairing

Invites into a database. An invite is a record in the database, and joining is one op the joiner writes into its own writer core: the database pulls it in and apply admits it. `Pairing.join` is the joiner's side.

```js
import { Identity, Network, Database, Mailbox, Pairing } from '@cero-base/core'

// a member
const mailbox = new Mailbox(network)
const pairing = new Pairing({ mailbox, db })
const invite = await pairing.invite({ role: 'member', ttl: '1h' })

// the joiner
const identity = await Identity.create()
const network = new Network({ identity, store })
const mailbox = new Mailbox(network)
const { key, encryptionKey, epochs, writer } = await Pairing.join(mailbox, invite, {
  identity,
  spec
})
const db = new Database({
  store,
  identity,
  network,
  spec,
  key,
  encryptionKey,
  epochs,
  keyPair: writer
})
await db.whenWritable() // a reader never becomes writable
```

The invite string is `{ expires, key, address, seed, link, data }`: the database's key, the address its encryption key owns, a seed whose keypair proves the join, the node that added the invite's record, and `data`, an optional payload the app reads before joining. The join links that node, so no member applies a join before the invite it uses, even one minted on a device that was offline. It names no mirrors: the join and the reply wait on each side's own network mirrors, so the app gives every device the same ones. The database keeps the invite's public id, role, expiry and whether it is reusable, never its seed. `ttl` is ms or a duration like `'12h'` or `'2d'`. A reusable invite grants member at most, so a higher rank is handed out once.

`Pairing.join` writes the join as the first block of the joiner's writer core, in the network's store, so open the database from that same store. The join is sealed to the invite's address, so only members read who joins, and it carries two signatures: the invite's over the writer, and the joiner identity's over the invite, the writer and the reply address. The core is announced to the database's peers and left on the mirrors, and any member device with the database open pulls it in. Apply checks both signatures and the invite's record, then adds the member and the device, seats the writer when the role writes, and spends a single-use invite, all in one step. The admission stays in the database until the joiner has its keys: every device of a member that can invite offers them while it is online, directly and on the mirrors, and the first one read settles it for everyone, so nothing is kept to send again and a member back online picks up what is still owed. Apply has no clock: past an invite's expiry a member that can remove drops the invite, and drops a joiner that got in without its keys, since the joiner has given up by then. The reply comes back to the address the joiner's writer owns, so a join resumed with the same `writer` still hears it. `Pairing.join` takes a `timeout` (`0` waits until the invite expires, or for good when it never does) and a `signal` to stop it; closing the mailbox stops it too.

`invite({ confirm: true })` makes its joins wait: apply stores a request and `pairing` emits `candidate`. `request.accept({ role })` admits it, `role` defaulting to the invite's and never above it or the accepter's rank, and `request.deny(reason)` drops it and tells the joiner. `pairing.pending` holds the requests not settled yet; they live in the database, so they survive a restart. `pairing.revoke(invite)` needs the remove permission and drops the invite's waiting requests too, and `Invite.parse(invite).discoveryKey` tells you which database an invite opens.

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

No refs, so collection names are strings. No handle list, no joins kept across a restart, no extensions, no operators over the channel, no file urls. You write the composition yourself, which is the point.

## Next

- [Encryption](encryption.md) for epochs and rotation, which live in the database.
- [Handles](handles.md) for what cero builds on top of pairing.
- [API reference](api.md) for the surface cero exposes instead.
