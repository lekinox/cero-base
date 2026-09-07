# cero

> [!IMPORTANT]
> This project is experimental. The API is subject to change and may break at any time.

A simple peer-to-peer SDK on top of the [Pear](https://pears.com) stack by [Holepunch](https://holepunch.to).

Describe your data. cero stores it on the device, syncs it across your devices and shares it with the people you invite. No server.

## Why cero

- **Nothing to host.** Your app stores data on the device and syncs it peer to peer. No backend, no accounts.
- **Schema in, API out.** Declare collections and fields; cero gives you `put`, `get`, `watch` and the rest.
- **Sharing built in.** Shared spaces with invites and roles (owner, admin, member, reader), enforced by every peer.
- **Encryption built in.** Per-space keys, rotated on removal, so a removed member cannot read what comes after.
- **Recovery built in.** A twelve-word phrase restores the account on a new device, history included.
- **Mirrors and Bluetooth.** Optional always-on peers for availability, and nearby sync with no internet.
- **Ready for split apps.** Run the data in a worker and use the same API from the UI over RPC.
- **Extensible.** Extensions, custom operators, and the underlying primitives one import away.
- **Node and Bare, typed.** Desktop, mobile, tests and CLIs.

## Quickstart

```sh
npm install @cero-base/cero
```

Describe your data:

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  profile: t.single({ name: t.string }),
  room: { messages: t.collection({ text: t.string }) }
})
```

Build it, once:

```js
// build.js
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

await build('./spec', schema)
```

Use it:

```js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

const me = await cero('./data', spec)
await cero.set(me.profile, { name: 'Alice' })

const room = await cero.open(me.room, { name: 'general' })
await cero.put(room.messages, { text: 'hi' })
console.log(await room.invite()) // give this to a friend
```

Your friend, on their own machine:

```js
const room = await cero.open(me.room, { invite })
for await (const { data } of cero.watch(room.messages)) console.log(data)
```

That is a working, encrypted, offline-first, peer-to-peer chat. The [quickstart](docs/quickstart.md) walks through it, and a second device of your own.

## Built on Pear

Under the hood cero composes [Hypercore](https://github.com/holepunchto/hypercore), [Autobee](https://github.com/holepunchto/autobee), [HyperDB](https://github.com/holepunchto/hyperdb), [Hyperblobs](https://github.com/holepunchto/hyperblobs), [Hyperswarm](https://github.com/holepunchto/hyperswarm), [blind-pairing](https://github.com/holepunchto/blind-pairing) and [blind-peering](https://github.com/holepunchto/blind-peering), and runs on [Bare](https://github.com/holepunchto/bare) and Node, so the same code runs on desktop and mobile. TypeScript declarations ship with the packages.

## Docs

Start with the [quickstart](docs/quickstart.md), then follow the guides in order. The [docs index](docs/README.md) lists every page.

|                                     |                                                                  |
| ----------------------------------- | ---------------------------------------------------------------- |
| [Quickstart](docs/quickstart.md)    | The three files every cero app has, and a second device.         |
| [Guides](docs/README.md#guides)     | Schema, data, rooms, identity, apps, extensions, files, network. |
| [Examples](docs/examples.md)        | A CLI, an Electron app and an Expo app.                          |
| [API reference](docs/api.md)        | Every export on one page.                                        |
| [Advanced](docs/README.md#advanced) | The core primitives and encryption.                              |

## Related

[`@cero-base/core`](packages/core) holds the seven primitives cero is built from: identity, database, network, pairing, storage, blobs and rpc. Reach for it when cero is too high level. See [Core primitives](docs/core.md).

## Develop

```sh
npm install
npm test
```

## License

Apache-2.0
