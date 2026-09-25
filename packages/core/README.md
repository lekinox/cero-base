# @cero-base/core

> [!IMPORTANT]
> This project is experimental. The API is subject to change and may break at any time.

Core is the eight primitives Cero is built from, one of the two Cero Base packages: reach for it to build a tool on one of them. Each is a small wrapper over a [Pear](https://pears.com) module: just invites and pairing, just a mailbox, just a replicated database, just a swarm with wakeup, just a typed channel to a worker. For an app, use Cero, [`@cero-base/cero`](https://www.npmjs.com/package/@cero-base/cero).

```sh
npm install @cero-base/core
```

```js
import { Identity, Network, Database } from '@cero-base/core'
```

Each primitive but `Identity` is a `ReadyResource`: construct it, `await x.ready()`, `await x.close()`.

## Docs

- [Core primitives](https://github.com/lekinox/cero-base/blob/main/docs/core.md): each primitive with examples, and how Cero puts them together
- [Errors](https://github.com/lekinox/cero-base/blob/main/docs/errors.md): the stable codes a `CeroError` carries

## Exports

| Subpath                               | What it gives you                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@cero-base/core`                     | Every subpath below in one import, but `/database/encryption` and `/blobs/server`                                                                                  |
| `@cero-base/core/identity`            | `Identity`: a keypair from a seed; signs, verifies, seals, names a swarm topic                                                                                     |
| `@cero-base/core/network`             | `Network`: Hyperswarm plus wakeup, with managed discovery sessions; `channelTopic`                                                                                 |
| `@cero-base/core/database`            | `Database`: multi-writer, permissions checked at apply, hooks, key rotation                                                                                        |
| `@cero-base/core/database/encryption` | `Keyring`, `EpochAutobee`, `EpochEncryption`, `blobEpochKey`, `loadEpochs`, `seal`, `opened`, `wraps`, `epochEntries`: the key epochs a `Database` rotates through |
| `@cero-base/core/mailbox`             | `Mailbox`: messages to an address, delivered directly or held by a mirror                                                                                          |
| `@cero-base/core/pairing`             | `Pairing`: invites into a database, joins admitted at apply; `sealJoin`                                                                                            |
| `@cero-base/core/invite`              | `Invite`: parse an invite string, read its `data` before joining                                                                                                   |
| `@cero-base/core/storage`             | `Storage`: local tables on Hyperbee or RocksDB, for device-only data                                                                                               |
| `@cero-base/core/blobs`               | `Blobs`: bytes in a Hyperblobs core, addressed by position, encrypted; `encodeId`, `decodeId`                                                                      |
| `@cero-base/core/blobs/codec`         | `encodeId`, `decodeId`: a core key, blob id and type as one string                                                                                                 |
| `@cero-base/core/blobs/server`        | `FileServer`: a file id served at a local url                                                                                                                      |
| `@cero-base/core/rpc`                 | `RPCServer`, `RPCClient`, `bindCodec`: a typed channel over any duplex stream                                                                                      |
| `@cero-base/core/schema`              | `t`, `schema`: the field types and the wrapper a build takes                                                                                                       |
| `@cero-base/core/utils`               | `WRITE`, `INVITE`, `ASSIGN`, `REMOVE`, `can`, `grants`, `outranks`, `isRank`, `filter`, `searchHit`, `onAbort`, `subscribe`, `admission`, `ownership`, `joining`   |
| `@cero-base/core/errors`              | `CeroError`                                                                                                                                                        |

Runs on Node and Bare, with TypeScript declarations.

## License

Apache-2.0
