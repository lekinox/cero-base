# Core primitives

[Docs](README.md) · Previous: [Errors](errors.md)

Core (`@cero-base/core`) is the eight primitives Cero is built from, each a small wrapper over a [Pear](https://pears.com) module: reach for one to build a tool without the SDK.

```js
import { Identity, Network, Database, Mailbox, Pairing, Storage, Blobs } from '@cero-base/core'
import { RPCServer, RPCClient } from '@cero-base/core/rpc'
```

Stay on Cero for an app. Drop to Core for a tool that speaks the same protocol without schemas and rooms, a test of one primitive, or a mirror or relay that needs the network alone. Each primitive but `Identity` is a `ReadyResource`: construct it, `await x.ready()`, `await x.close()`. Each has its subpath too: `@cero-base/core/identity`, `/network`, `/database`, `/mailbox`, `/pairing`, `/invite`, `/storage`, `/blobs`, `/rpc`.

## Identity

A keypair from a seed. It signs, verifies, seals to another identity, and names a swarm topic.

```js
import b4a from 'b4a'
import { Identity } from '@cero-base/core'

const identity = await Identity.create() // 12 words; { words: 24 } for 24
const phrase = identity.toPhrase() // show it once, the user writes it down
const same = await Identity.create({ seed: Identity.toSeed(phrase) }) // on any device

const message = b4a.from('hi')
const signature = identity.sign(message)
Identity.verify(same.publicKey, message, signature) // true
```

| Member                                                           | Does                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Identity.create({ seed, words })`                               | The identity a 16- or 32-byte `seed` writes, or a fresh one: `words` 12 (default) or 24.   |
| `Identity.toSeed(phrase)`, `Identity.toPhrase(seed)`             | Phrase to seed and back. `INVALID` for a phrase that is not BIP-39.                        |
| `identity.toPhrase()`                                            | Its phrase.                                                                                |
| `id`, `publicKey`, `secretKey`, `seed`, `encryptionKey`, `topic` | Its z32 id, keys and seed; a symmetric key from the seed; the swarm topic it announces on. |
| `identity.sign(message)`, `identity.verify(message, signature)`  | Sign; check a signature against this identity.                                             |
| `Identity.verify(publicKey, message, signature)`                 | Check a signature against any public key.                                                  |
| `Identity.seal(publicKey, message)`, `identity.unseal(box)`      | A box only that identity opens; its bytes, or `null` when it does not open.                |
| `Identity.randomKeyPair()`                                       | A fresh `{ publicKey, secretKey, id }`, for a device's writer.                             |
| `Identity.randomBytes(n)`                                        | `n` random bytes, 32 by default.                                                           |

An identity is frozen, and `JSON.stringify` shows only its `id`. A device's writer is never the identity keypair: every device authors its own.

## Network

Hyperswarm plus wakeup, with managed discovery sessions.

```js
import { Network } from '@cero-base/core'

// store: a Corestore; topic: 32 bytes; core: any hypercore
const net = new Network({ store, channel: 'my-app' })
await net.ready()
const discovery = net.join(topic) // announce and look up
await net.flush({ timeout: 2000 }) // wait for the DHT, 2 s at most
net.attach(core) // replicate it on every connection
```

| Option         | Meaning                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| `store`        | A Corestore. Every connection replicates it; mirrors and the Mailbox need it.              |
| `identity`     | The swarm keypair. A random one without.                                                   |
| `channel`      | Only peers on the same channel meet.                                                       |
| `mirrors`      | Mirror keys, strings or bytes: attached cores are kept on them.                            |
| `bootstrap`    | `[{ host, port }]` DHT nodes.                                                              |
| `backoffs`     | Reconnect backoff steps in ms.                                                             |
| `firewall`     | `(remotePublicKey, payload) => boolean`: `true` refuses the connection.                    |
| `relayThrough` | Relay keys to tunnel through.                                                              |
| `presence`     | `{ active, announced, idle }`, the swarm budget for attached databases: 8, 8 and 30000 ms. |
| `onerror`      | Background errors. The console without one.                                                |

| Member                                                             | Does                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `net.join(topic, { mode })`                                        | A `Discovery`. `'active'` (default) announces and looks up, `'passive'` only announces. It has `mode`, `activate()`, `deactivate()`, `destroy()`, and `flush()`, which waits for the current announce with no bound. |
| `net.flush({ timeout })`                                           | Wait for pending announces and lookups, `timeout` ms at most (500).                                                                                                                                                  |
| `net.attach(core)`, `net.detach(core)`                             | Replicate a core, bee or database on every current and future connection, and on the mirrors; stop for new ones.                                                                                                     |
| `net.replicate(target)`                                            | Replicate once on the current connections.                                                                                                                                                                           |
| `net.suspend()`, `net.resume()`                                    | Drop the sockets and keep the state; come back.                                                                                                                                                                      |
| `net.inject(stream, { isInitiator })`                              | Feed in a connection you made yourself, a Bluetooth link or an in-process pipe. `isInitiator` picks the handshake side of a raw duplex. Returns the encrypted stream.                                                |
| `net.setInfo(info)`, `net.getInfo(key)`                            | Tell connected peers `{ name, … }` about this one; read what a peer told, or `null`.                                                                                                                                 |
| `net.peering()`                                                    | The mirror client, built on first use. Needs `store`.                                                                                                                                                                |
| `swarm`, `peers`, `connections`, `suspended`, `wakeup`, `presence` | The live swarm and its state.                                                                                                                                                                                        |
| `'connection'`, `'peer-info'` events                               | `(stream, info)` per connection; `(key, info)` when a peer tells its info.                                                                                                                                           |

`channelTopic(topic, channel)` is the topic a channel really joins.

## Database

A multi-writer database: permissions checked at apply time, hooks, writer admission and key rotation. It takes a Corestore, an identity, a network and a built spec.

```js
import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import { Identity, Network, Database } from '@cero-base/core'
import { spec } from './spec/index.js' // from build(), with a room type holding messages

const store = new Corestore(new HypercoreStorage('./data'), { manifestVersion: 2 })
const identity = await Identity.create()
const network = new Network({ store })
const db = new Database({ store, identity, network, spec: spec.handles.room })
await db.ready()
await db.bootstrap({ name: 'laptop' }) // this device writes first, as owner

db.before('put', (ctx) => {
  if (ctx.name === 'messages' && !ctx.row.text) return false
})
await db.put('messages', { text: 'hi' })
const { data } = await db.get('messages', { limit: 10, reverse: true })
```

`spec` is one built scope, with `database`, `dispatch` and `meta`: the root database opens on the built `spec` itself, a room on `spec.handles.<type>`.

| Option          | Meaning                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `store`         | A Corestore. `REQUIRED`.                                                                |
| `identity`      | Who writes: it signs the admissions. `REQUIRED`.                                        |
| `spec`          | The scope above. `INVALID` without `database` and `dispatch`.                           |
| `network`       | Replicates it. Without one it stays on the device.                                      |
| `key`           | Open an existing database. A new one without.                                           |
| `encryptionKey` | Its encryption key, the identity's by default.                                          |
| `epochs`        | The keys it rotated to, as a join delivers them.                                        |
| `keyPair`       | This device's writer keypair, a fresh one by default. Never the identity's (`INVALID`). |
| `namespace`     | The Corestore namespace, `'cero'`.                                                      |
| `pinned`        | Always search and announce, outside the network's presence budget.                      |
| `onerror`       | Ops skipped or refused at apply, and the log's own errors.                              |

| Method                                               | Does                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `put(name, row)`                                     | `{ data }`: insert into a collection, or overwrite by id.                                                               |
| `set(name, row, { upsert })`                         | `{ data }`, or `null` when `{ upsert: false }` finds no row. Merges, keeping `createdAt`.                               |
| `get(name, idOrQuery)`                               | `{ data }`, or `{ data, total, size }` for a query, as Cero's `get`.                                                    |
| `del(name, id)`                                      | Delete by id, or clear a single.                                                                                        |
| `watch(name, query)`                                 | A stream of `get` results, one per change.                                                                              |
| `changes(name, query)`                               | A stream of `{ changes, reset }`, the `{ prev, next }` rows since the last item.                                        |
| `call(name, data)`                                   | Run an action. `INVALID` when no `after` hook is registered for it.                                                     |
| `tx(fn)`                                             | Writes `fn` makes through its argument land as one append. `fn` must take it.                                           |
| `before(op, fn)`, `after(op, fn)`                    | Hooks on `'put'`, `'set'`, `'del'` or an action's name, for every ref: check `ctx.name`. Each returns its remover.      |
| `rotate()`                                           | `{ epoch }`: a new key sealed to every member. `INVALID` inside `tx`.                                                   |
| `bootstrap({ name, isMobile, recovering, timeout })` | Set this device up: the first writer and owner, or with `recovering: true` another device of an identity already in it. |
| `claim()`                                            | Seat this device's writer where your identity is already a member that writes.                                          |
| `whenWritable({ timeout })`                          | Resolves once this device can write. `TIMEOUT` after 30000 ms; `0` waits for good.                                      |
| `addWriter(publicKey)`, `removeWriter(publicKey)`    | Admit another device of your identity, or remove a device, by its writer keypair's public key.                          |
| `setActive(on)`                                      | `true` ranks it as just used on the swarm, `false` leaves the swarm until the next update.                              |

It also has `key`, `discoveryKey`, `writerKey`, `writable`, `encryptionKey`, `address` (where joins are sealed to), `keyPair`, `length`, `view` and `behind`, and emits:

| Event                    | Carries                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `update`                 | A `Set` of the ref names a batch touched, `'*'` for any.                      |
| `apply`                  | `{ op, name, row, writerKey, seq }` for each applied op, local or replicated. |
| `writable`, `unwritable` | This device gained or lost write.                                             |
| `behind`                 | The version of a newer app whose op was skipped.                              |

Who writes:

- **Another device of yours** opens the same key and runs `db.bootstrap({ recovering: true })`. It catches up, admits itself with an add-writer signed by the identity, and records its device row.
- **A member you invited** needs nothing: its join seats it, and `db.whenWritable()` resolves once that lands.
- **A member's new device** opening a database it has the key of runs `db.claim()`.
- Only the genesis batch names a member directly. Everyone after comes in through a join, and nobody seats a writer for another identity.

Keys: `db.rotate()` opens a new key, and rotations on one device run one after another. A device that may remove also re-keys by itself when the members change, a room's first removal included. See [How it works](how-it-works.md).

## Mailbox

A device's mailbox: it receives at the addresses it holds the secret of, and sends to any address. An address is 32 bytes you can share; anyone can send to it, only its secret opens what arrives. A message is delivered directly when its owner is online, and otherwise waits on a mirror until they come back.

```js
import b4a from 'b4a'
import { Identity, Mailbox } from '@cero-base/core'

// network: a Network with a store, as above
const mailbox = new Mailbox(network, { onerror: console.error })
await mailbox.ready()

const secret = Identity.randomBytes(32) // yours to keep: whoever holds it receives
const address = Mailbox.getAddress(secret) // share this

const inbox = mailbox.receive(secret, (message) => {
  console.log(b4a.toString(message))
})

await mailbox.send(address, b4a.from('hi'))

await inbox.close() // stop receiving
```

- **Nothing is lost.** The outbox keeps a message until someone reads it, the inbox until `onmessage` resolves. Persistent boxes, `new Mailbox(network, { inbox, outbox })`, each any `{ list, put, del }`, keep that across a restart. A message may arrive twice, never not at all.
- **A throwing `onmessage`** keeps the message and reports to `onerror`, the constructor option.
- **Mirrors.** `send(address, message, { mirrors })` picks where a message waits, the network's mirrors by default.
- **Anonymous.** A message carries no sender. One that needs a sender signs itself.

## Pairing

In Core, a room is a `Database`: its log holds the room's rows, members and invites. Pairing is how someone new gets into it: a member mints an invite, the joiner uses it and gets back the keys that open the room. In Cero, a room does all of this for you: `cero.invite(room)` on one side, `cero.open(me.room, invite)` on the other.

A device sets up once, then pairs per room:

```js
import { Identity, Network, Mailbox } from '@cero-base/core'

// once per device: who you are, how you connect, where replies arrive. store: a Corestore
const identity = await Identity.create()
const network = new Network({ identity, store })
const mailbox = new Mailbox(network)
```

```js
import { Pairing } from '@cero-base/core'

// a member, with the room open: room is a ready Database
const pairing = new Pairing({ mailbox, db: room })
const invite = await pairing.invite({ role: 'member', ttl: '1h' }) // share this string
```

```js
import { Database, Pairing } from '@cero-base/core'

// the joiner, with only the invite; spec from build()
const keys = await Pairing.join(mailbox, invite, { identity, spec: spec.handles.room })

// the keys open the room
const room = new Database({
  store,
  identity,
  network,
  spec: spec.handles.room,
  key: keys.key, // which room
  encryptionKey: keys.encryptionKey, // how to read it
  epochs: keys.epochs, // and every key it rotated to
  keyPair: keys.writer // the writer core the join was written in
})
await room.ready()
await room.whenWritable() // skip for a reader: it never becomes writable
```

The invite string carries:

- `key`, the database's key, and `address`, the address its encryption key owns.
- `seed`, whose keypair proves the join.
- `link`, the node that added the invite's record. The join links it, so no member applies a join before its invite, even one minted on a device that was offline.
- `expires`, and `data`, an optional payload the app reads before joining.

It names no mirrors: each side waits on its own network's, so give every device the same ones. The database keeps the invite's public id, role, expiry, and whether it is reusable or needs confirming, never its seed. `ttl` is ms or a duration like `'12h'`. A reusable invite grants member at most, so a higher rank is handed out once.

How a join goes:

1. **Write.** `Pairing.join` writes the join as the first block of the joiner's own writer core, in the network's store: open the database from that same store. It is sealed to the invite's address, so only members read who joins. It carries two signatures: the invite's over the writer, and the joiner's over the invite, the writer and the reply address.
2. **Reach.** The core is announced to the database's peers and left on the mirrors. Any member device with the database open pulls it in.
3. **Admit.** Apply checks both signatures and the invite's record, and turns away a member removed after the invite was minted. Then, in one step, it adds the member and the device, seats the writer when the role writes, and spends a single-use invite.
4. **Keys.** Every device of a member that can invite offers the keys to the joiner's reply address while it is online, directly and on the mirrors. The first one read settles it for everyone, and a member back online picks up what is still owed.
5. **Expiry.** Apply has no clock: past an invite's expiry, a member that can remove drops the invite and any joiner still without keys.

A join resumed with the same `writer` still hears its reply. `Pairing.join` takes a `timeout` (30000 ms; `0` waits until the invite expires, or for good when it never does) and a `signal`; closing the mailbox stops it too.

### Accepting or rejecting a join

A plain invite admits the joiner by itself: the invite is the approval. An invite minted with `confirm: true` holds each join as a request until a member answers it:

```js
// pairing from above; approve is your own check
const invite = await pairing.invite({ confirm: true })

pairing.on('request', async (request) => {
  // request.identity: who is asking. request.role: what for, the invite's role
  if (await approve(request)) await request.accept()
  else await request.deny('not now')
})
```

- `request.accept()` admits the joiner at the invite's role. `request.accept({ role })` can grant a lower one, never above the invite's or your own rank. It throws `EXPIRED` once the invite has expired.
- `request.deny(reason)` turns the joiner away; their `Pairing.join` rejects with `DENIED` and your reason.
- `pairing.pending` holds the requests not answered yet, and `pairing.request(id)` finds one by the id of its row. They live in the room, rows of `requests` with the `role` they ask for, so they survive a restart and the first member to answer settles it for all.
- `pairing.revoke(invite)` needs the remove permission and drops the invite's waiting requests too.
- `Invite.parse(invite).discoveryKey` tells you which database an invite opens.

## Storage

Local tables on a Hyperbee or RocksDB, with the same operators as a `Database`, for device-only data.

```js
import { Storage } from '@cero-base/core'
import { spec } from './spec/index.js' // from build(), with a local block holding drafts

const local = Storage.bee('./local', {
  spec: { database: spec.local.database, meta: spec.meta.local }
})
await local.ready()
await local.put('drafts', { text: 'hi' })
const { data } = await local.get('drafts', { limit: 10 })
```

| Member                                                | Does                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Storage.bee(dir, { spec, root, store, storageKey })` | A Hyperbee in its own Corestore under `dir`, or in `store`. `storageKey`, 32 bytes, encrypts it at rest.  |
| `Storage.rocks(dir, { spec, root })`                  | A RocksDB column family in `dir`'s storage. No `storageKey`.                                              |
| `put`, `set`, `get`, `del`, `watch`                   | As on a `Database`, with the same queries; `total` is always counted. No hooks, actions, `tx` or indexes. |

From a Cero build, its `spec` is `{ database: spec.local.database, meta: spec.meta.local }`. In Cero, the device's local `Storage` is a bee in the same Corestore under `dir/main`, holding the seed, the room writer keypairs, pending joins, mail, the channel and the `local` scope.

## Blobs

Bytes in one Hyperblobs core, addressed by position (not by content) and encrypted with the given `encryptionKey`, the identity's by default.

```js
import b4a from 'b4a'
import { Blobs } from '@cero-base/core'

// store, identity, network from above
const blobs = new Blobs({ store, identity, network })
await blobs.ready()
const blobId = await blobs.put(b4a.from('hello'))
const bytes = await blobs.get(blobId)
```

| Member                                                              | Does                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `new Blobs({ store, identity, encryptionKey, network, key, name })` | `identity` or `encryptionKey` is required. `key` opens an existing blob core; `name` names a new one, `'blobs'`. |
| `put(bytes)`, `put(readable)`                                       | The blob id: `{ blockOffset, blockLength, byteOffset, byteLength }`.                                             |
| `get(blobId)`, `createReadStream(blobId)`                           | The bytes, fetched from peers when not on the device; or a stream of them.                                       |
| `clear(blobId)`                                                     | Drop its blocks from this device.                                                                                |
| `key`, `id`, `discoveryKey`, `core`                                 | The core's key, its z32 id, its topic, the core.                                                                 |

`encodeId(coreKey, blobId, type)` and `decodeId(id)`, from `@cero-base/core/blobs/codec`, turn that into the one-string file id Cero stores. `FileServer`, from `@cero-base/core/blobs/server`, serves a file id at a local url: `new FileServer({ store, resolve })`, `listen()`, `getLink(id)`, `close()`. `cero.put(room.files, …)` is these three plus a `files` row.

## RPC

A typed channel over any duplex stream: hrpc on a length-framed pipe. One side serves, the other calls, and the pair is what separates a worker from a UI.

```js
import { RPCServer, RPCClient } from '@cero-base/core/rpc'
import HRPC from './rpc/index.js' // your own hrpc build, declaring a ping command
import * as schema from './schema/index.js' // and the hyperschema build it uses

// ipcA and ipcB: the two ends of a duplex pipe
const spec = { rpc: HRPC, schema }
const server = new RPCServer(ipcA, spec)
server.rpc.onPing(async (m) => `pong:${m}`)
const client = new RPCClient(ipcB, spec)
await server.ready()
await client.ready()
await client.rpc.ping('hi') // 'pong:hi'
```

Both take `(ipc, spec)`: `spec.rpc` is the hrpc class, `spec.schema` its hyperschema (`REQUIRED`). `.rpc` is the hrpc instance, whose commands are the ones your build declares. `bindCodec(spec)` adds `spec.codec`, the row and query encoders Cero's own channel uses. Cero's `serve(ipc, spec)` and its client's `cero(ipc, spec)` are this with Cero's handlers on one end and its operators on the other.

## How Cero puts them together

- `cero(dir, spec)` opens one Corestore under `dir/main`, and in it the local `Storage` above.
- It resolves the `Identity`, starts one `Network` and one `Mailbox`, and opens the root `Database` on the built `spec`: your list of rooms and your devices.
- Every room is another `Database` on `spec.handles.<type>`, with its own `Blobs` and a `Pairing`, sharing the root's network, identity and mailbox.
- The operators (`cero.put`, `cero.invite` and the rest) are thin wrappers over these, plus refs, file urls from a `FileServer`, and joins kept across restarts.
- In a split app, `serve` puts all of it behind an `RPCServer`, and the client reaches it through an `RPCClient`.

## Next

- [API reference](api.md): the surface Cero builds on these.
- [How it works](how-it-works.md): rotation, removal and joins, seen from the app.
- [Sharing](handles.md): what Cero does with pairing.
