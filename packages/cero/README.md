# @cero-base/cero

> [!IMPORTANT]
> This project is experimental. The API is subject to change and may break at any time.

Describe your data. Cero stores it on the device, syncs it across your devices and shares it with the people you invite. No server.

Cero is the SDK apps use, one of the two Cero Base packages, on the [Pear](https://pears.com) stack by [Holepunch](https://holepunch.to). The other, Core ([`@cero-base/core`](https://www.npmjs.com/package/@cero-base/core)), holds the primitives Cero is built from.

```sh
npm install @cero-base/cero
```

A Cero app is three files.

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  notes: t.collection({ title: t.string, body: t.string }),
  room: { messages: t.collection({ text: t.string }) }
})
```

```js
// build.js, run once and after every schema change
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

await build('./spec', schema)
```

```js
// index.js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

const me = await cero('./data', spec)
await cero.put(me.notes, { title: 'first', body: 'hello' })

const room = await cero.open(me.room, { name: 'general' })
console.log(await cero.invite(room)) // give this to a friend
```

Your friend, on their own machine, with the same three files:

```js
// index.js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

const me = await cero('./data', spec)
const invite = '…' // the string you gave them
const room = await cero.open(me.room, { invite })
for await (const { data } of cero.watch(room.messages)) console.log(data)
```

That is a working, encrypted, offline-first, peer-to-peer app. Your phrase, `await cero.phrase(me)`, opens the same identity on any other device.

## Docs

- [Quickstart](https://github.com/lekinox/cero-base/blob/main/docs/quickstart.md)
- [Guides](https://github.com/lekinox/cero-base/blob/main/docs/README.md): schema, data, sharing, your devices, network, apps, extensions, how it works
- [API reference](https://github.com/lekinox/cero-base/blob/main/docs/api.md)
- [Errors](https://github.com/lekinox/cero-base/blob/main/docs/errors.md)

## Exports

| Subpath                      | What it gives you                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@cero-base/cero`            | `cero`, `t`, `schema`, `restore`, `toSeed`, `peek`, the 24 operators, `Handle`, `Ref`, `Local`                                             |
| `@cero-base/cero/build`      | `build(specDir, schema, opts)`                                                                                                             |
| `@cero-base/cero/server`     | `serve(ipc, spec, opts)` and `Server`, the worker that owns the data                                                                       |
| `@cero-base/cero/client`     | `cero(ipc, spec)` (also `connect`), `Client`, `restore`, `t`, `schema` and every operator but `before`, `after` and `tx`, for a UI process |
| `@cero-base/cero/extensions` | `profileSync`, `handleSync`, `bundled`, `extensionsOf`, and a light `cero` with `t`, `schema` and the operators, for extension modules     |

The 24 operators, each also on the facade as `cero.put` and so on: `put`, `set`, `get`, `del`, `watch`, `call`, `open`, `tx`, `invite`, `revoke`, `rotate`, `accept`, `deny`, `leave`, `close`, `cancel`, `suspend`, `resume`, `activate`, `deactivate`, `phrase`, `nearby`, `before`, `after`.

Built on the [Pear](https://pears.com) stack: Hypercore, Autobee, HyperDB, Hyperblobs, Hyperswarm, blind-peering and Bare. Runs on Node and Bare, with TypeScript declarations.

## License

Apache-2.0
