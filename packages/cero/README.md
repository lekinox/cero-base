# @cero-base/cero

cero means zero. Zero servers. Zero accounts. Zero sync code.

You describe your data. cero stores it on the device, syncs it between your devices, and shares it with the people you invite.

```sh
npm install @cero-base/cero
```

A cero app is three files.

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
console.log(await room.invite()) // give this to a friend
```

Your friend, on their own machine:

```js
const room = await cero.open(me.room, { invite })
for await (const { data } of cero.watch(room.messages)) console.log(data)
```

That is a working, encrypted, offline-first, peer-to-peer app. Your phrase, `me.identity.toPhrase()`, opens the same identity on any other device.

## Docs

- [Quickstart](https://github.com/lekinox/cero-base/blob/main/docs/quickstart.md)
- [Guides](https://github.com/lekinox/cero-base/blob/main/docs/README.md#guides): schema, data, rooms, identity, apps, extensions, files, network
- [API reference](https://github.com/lekinox/cero-base/blob/main/docs/api.md)
- [Examples](https://github.com/lekinox/cero-base/blob/main/docs/examples.md)

## Exports

| Subpath                      | What it gives you                                                            |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `@cero-base/cero`            | `cero`, `t`, `schema`, `restore`, `peek`, `Handle`, `Ref`, `Local`           |
| `@cero-base/cero/build`      | `build(specDir, schema, opts)`                                               |
| `@cero-base/cero/server`     | `serve(ipc, spec, opts)` and `Server`, the process that owns the data        |
| `@cero-base/cero/client`     | `connect(ipc, spec)`, `Client`, `restore` and the operators for a UI process |
| `@cero-base/cero/extensions` | `profileSync`, `handleSync`                                                  |

Works on Node and on Bare. Ships TypeScript declarations generated from JSDoc.

## License

Apache-2.0
