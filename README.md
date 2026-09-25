# Cero Base

> [!IMPORTANT]
> This project is experimental. The API is subject to change and may break at any time.

**Cero** is a local-first, peer-to-peer SDK on the [Pear](https://pears.com) stack by [Holepunch](https://holepunch.to). Describe your data: Cero stores it on the device, syncs it across your devices and shares it with the people you invite. No server.

```sh
npm install @cero-base/cero
```

Cero Base is the repository: [Cero](packages/cero), the SDK your app uses, and [Core](packages/core) (`@cero-base/core`), the primitives Cero is built from, for building a tool on one of them.

## Why Cero

- **Nothing to host.** Data lives on the device and syncs peer to peer. No backend, no accounts.
- **Schema in, API out.** Declare collections and fields; Cero gives you `put`, `get`, `watch` and the rest.
- **Sharing built in.** Rooms with invites and roles (owner, admin, member, reader), enforced by every peer.
- **Encryption built in.** Every room has its own key, re-keyed when someone is removed.
- **Recovery built in.** A twelve-word phrase brings the account to a new device.
- **Mirrors and Bluetooth.** Optional always-on peers so devices sync without being online together, and nearby sync with no internet.
- **Ready for real apps.** Run the data in a worker and use the same calls from an Electron or Expo UI.
- **Node and Bare, typed.** Desktop, mobile, tests and CLIs.

## Quickstart

Describe your data:

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  profile: t.single({ name: t.string }),
  room: { messages: t.collection({ text: t.string }) }
})
```

Build it, and again after every schema change:

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
console.log(await cero.invite(room)) // give this to a friend
```

Your friend, on their own machine, with the same `spec/`:

```js
const me = await cero('./data', spec)
const invite = process.argv[2] // the string you gave them
const room = await cero.open(me.room, invite)
for await (const { data } of cero.watch(room.messages)) console.log(data)
```

That is a working, encrypted, offline-first, peer-to-peer chat. The [quickstart](docs/quickstart.md) walks through it, and a second device of your own.

## Built on Pear

Under the hood Cero composes [Hypercore](https://github.com/holepunchto/hypercore), [Autobee](https://github.com/holepunchto/autobee), [HyperDB](https://github.com/holepunchto/hyperdb), [Hyperblobs](https://github.com/holepunchto/hyperblobs), [Hyperswarm](https://github.com/holepunchto/hyperswarm) and [blind-peering](https://github.com/holepunchto/blind-peering), and runs on [Bare](https://github.com/holepunchto/bare) and Node, so the same code runs on desktop and mobile. TypeScript declarations ship with the packages.

## Docs

Start with the [quickstart](docs/quickstart.md), then follow the guides in order. The [docs index](docs/README.md) lists every page.

|                                      |                                                                 |
| ------------------------------------ | --------------------------------------------------------------- |
| [Quickstart](docs/quickstart.md)     | A shared app running in two terminals.                          |
| [Guides](docs/README.md)             | Schema, data, sharing, your devices, network, apps, extensions. |
| [How it works](docs/how-it-works.md) | What happens offline, on a join, on a removal.                  |
| [API reference](docs/api.md)         | Every export on one page.                                       |
| [Core primitives](docs/core.md)      | The building blocks under Cero.                                 |

## Develop

```sh
npm install
npm test
```

## License

Apache-2.0
