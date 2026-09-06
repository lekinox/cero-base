# @cero-base/core

The building blocks `cero` is made of. Use them when `cero` is too high-level — when you want just an autobee, just a swarm, or just signed pairing.

Each subpath is a small, independent primitive. `ReadyResource`-shaped where it makes sense (`.ready()` + `.close()`).

```js
// Barrel import — everything in one place
import {
  Identity,
  Storage,
  Network,
  Database,
  Blobs,
  Pairing,
  Invite,
  RPCServer,
  RPCClient,
  t,
  schema,
  CeroError
} from '@cero-base/core'

// Or by subpath when you want a smaller graph
import { Identity } from '@cero-base/core/identity'
```

Ships with TypeScript declarations (`.d.ts`) generated from JSDoc. Plain JS source — no TS in the tree, no compile step for runtime.

## Identity

A keypair backed by a 12- or 24-word phrase. Signs and verifies. Derives a topic for swarm discovery.

```js
import { Identity } from '@cero-base/core/identity'

const me = await Identity.generate() // fresh random
const me2 = await Identity.fromPhrase('twelve words …') // restore
const sig = me.sign(message)
Identity.verify(me.publicKey, message, sig) // → true / false
me.id // z32-encoded public key
me.topic // 32-byte buffer for swarm.join(...)
me.toPhrase() // back to words
```

## Storage

Hyperbee or Rocks-backed local table store with a uniform put/set/get/del/count/watch surface.

```js
import { Storage } from '@cero-base/core/storage'

const s = Storage.bee('./data', { spec: { database, meta } })
await s.ready()
await s.put('drafts', { text: 'hi' })
const { data } = await s.get('drafts', 'some-id')
```

## Network

Hyperswarm + Wakeup. `join(topic)` returns a managed `Discovery` that auto-closes with the network.

```js
import { Network } from '@cero-base/core/network'

const net = new Network({ bootstrap })
await net.ready()
const discovery = net.join(identity.topic)
await discovery.flush() // bounded peer announce
net.attach(myCore) // start replicating
```

## Database

Autobee + HyperDB view with dispatch routing, hooks, and writer admission (bootstrap, claim).

```js
import { Database } from '@cero-base/core/database'

const db = new Database({ store, identity, network, spec })
await db.ready()
await db.bootstrap({ name: 'this-device' }) // mint a per-device writer
await db.put('messages', { text: 'hi' }) // memberId stamped automatically
db.before('put', (ctx) => {
  /* mutate or veto */
})
```

`db.bootstrap(...)` provisions this device. Its writer core was minted when the database opened and this device is its only author, ever. For a **second device** sharing the same identity, use `db.bootstrap({ recovering: true })` — it waits for the other devices' state, admits itself with a master-signed add-writer appended optimistically, then records the device.

`db.claim()` is an alternative path: a second device claims its existing local writer; the host admits it via `add-writer` once it sees the claim.

## Blobs

Content-addressed Hyperblobs store. `put(bytes)` returns a blob id you hand back to `get` (or `clear` to reclaim space).

```js
import { Blobs } from '@cero-base/core/blobs'

const blobs = new Blobs({ store, identity, network })
await blobs.ready()
const id = await blobs.put(Buffer.from('hello'))
const bytes = await blobs.get(id)
```

## Pairing

BlindPairing wrapper with signed invites. `createInvite()` mints, `join(invite)` consumes. The host gets a `candidate` event; call `candidate.confirm({ key, encryptionKey })` to admit.

```js
import { Pairing } from '@cero-base/core/pairing'

const pair = new Pairing({ network, identity, topic: myBeeKey })
await pair.ready()

const invite = await pair.createInvite({ role: 'write' })
// host side:
pair.on('candidate', async (c) => {
  await c.confirm({ key: bee.key, encryptionKey: bee.encryptionKey })
})

// joiner side:
const { key, encryptionKey } = await pair.join(invite, { userData, timeout: 30000 })
```

## RPC

Framed bare-rpc over any duplex stream. `bindCodec(spec)` attaches encode/decode helpers for hyperschema-typed envelopes.

```js
import { RPCServer, RPCClient, bindCodec } from '@cero-base/core/rpc'

class MyServer extends RPCServer {
  async _open() {
    await super._open()
    this.rpc.onPing(async (m) => `pong:${m}`)
  }
}
const server = new MyServer(ipc, spec)
const client = new RPCClient(ipc2, spec)
await server.ready()
await client.ready()
await client.rpc.ping('hi') // → 'pong:hi'
```

## Utils

```js
import { genId, subscribe } from '@cero-base/core/utils'

genId() // short z32 of 16 random bytes (for ids)
```

Keys travel as z32 strings through `hypercore-id-encoding` (`hid.encode(bee.key)` / `hid.decode(id)`).

`subscribe({ get, watch })` builds a Readable that re-emits the latest `get()` on every `watch(fn)` tick — the primitive `Database.watch` is built on.

## Errors

`CeroError` is what the library itself throws. It's diagnostic — your app should still wrap calls in its own try/catch and decide what's user-facing, retryable, fatal, etc. The codes are stable so you can branch on them safely.

```js
import { CeroError } from '@cero-base/core/errors'

try {
  await cero.open(me.room, invite)
} catch (e) {
  if (!CeroError.isCeroError(e)) throw e
  switch (e.code) {
    case 'INVALID_INVITE':
      return showToast('Bad invite link')
    case 'EXPIRED':
      return showToast('This invite has expired')
    case 'DENIED':
      return showToast(`Denied${e.reason ? `: ${e.reason}` : ''}`)
    case 'TIMEOUT':
      return retry()
    default:
      return reportError(e)
  }
}
```

### Codes

Generic:

| Code               | Thrown when                                                                    |
| ------------------ | ------------------------------------------------------------------------------ |
| `REQUIRED`         | A constructor or function arg is missing (`store`, `identity`, `spec`, …)      |
| `INVALID`          | Arg has the wrong shape/type (`publicKey must be a 32-byte buffer`)            |
| `CLOSED`           | You called a method on a closed `Database`, `Storage`, `Network`, `Pairing`, … |
| `NOT_READY`        | You called a method before `await x.ready()`                                   |
| `DESTROYED`        | A `Discovery` is destroyed                                                     |
| `UNKNOWN`          | Asked for a `ref`, `handle`, or other thing that doesn't exist                 |
| `NOT_WRITABLE`     | Tried to write to a `Database` whose local writer isn't admitted yet           |
| `TIMED_OUT`        | A bounded wait elapsed (`until(...)` etc.)                                     |
| `UNSUPPORTED`      | Feature not yet wired (nested handles, …)                                      |
| `CHANNEL_MISMATCH` | Storage stamped with one `channel` reopened under another (or none)            |
| `CONFLICT`         | The operation raced an existing state (e.g. double init)                       |

Pairing-specific:

| Code             | Thrown when                                                 | Extra fields |
| ---------------- | ----------------------------------------------------------- | ------------ |
| `INVALID_INVITE` | Invite string is malformed, wrong version, or signature bad | —            |
| `EXPIRED`        | Invite past its `expiresIn`                                 | —            |
| `DENIED`         | Host rejected the candidate                                 | `reason`     |
| `TIMEOUT`        | Pairing didn't complete in time                             | —            |
| `NETWORK_ERROR`  | Underlying swarm/blind-pairing failure                      | —            |

Every factory produces a `CeroError` with `name === 'CeroError'`, `isCeroError === true`, the listed `.code`, and (where applicable) the extra fields above. Pattern-match on `.code`, not on the message.

## Tests

```sh
cd packages/core && npm test
```

Runs every `test/**/*.test.js` under brittle-node (brittle v4). `npm run build:test` regenerates the test fixture spec.

## Types

```sh
npm run build:types
```

Emits `.d.ts` from JSDoc into `types/`. Runs automatically on `npm publish` via `prepublishOnly`.
