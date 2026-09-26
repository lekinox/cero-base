# Cero Base

[Docs](README.md) · Next: [Quickstart](quickstart.md)

Cero is a local-first, peer-to-peer SDK: describe your data, and Cero stores it on the device, syncs it across the user's devices and shares it with the people they invite, with no server.

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  room: { messages: t.collection({ text: t.string }) }
})
```

Build it into `spec/`, and again after every schema change:

```js
// build.js
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

await build('./spec', schema)
```

Open a room, write to it and invite a friend:

```js
// app.js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

const me = await cero('./data', spec)
const room = await cero.open(me.room, { name: 'general' })

await cero.put(room.messages, { text: 'hi' })
console.log(await cero.invite(room)) // give this to a friend
```

Your friend runs this on their machine, with the same `spec/`, while `app.js` is still running:

```js
// friend.js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

const invite = process.argv[2] // the code app.js printed
const me = await cero('./data', spec)
const room = await cero.open(me.room, { invite })

cero.watch(room.messages).on('data', ({ data }) => console.log(data))
// [{ id, memberId, index, createdAt, updatedAt, text: 'hi' }]
```

That is an encrypted chat between two machines, with nothing to host.

Cero Base is the repository: Cero (`@cero-base/cero`), the SDK these pages teach, and [Core](core.md) (`@cero-base/core`), the primitives it is built from.

> [!IMPORTANT]
> Cero Base is experimental. The API may change and break at any time.

## How it fits together

`me` is the user on this device, and a room is a space they open from it and share by invite, with its own members, roles and encryption key. Each holds the tables your schema declares, plus a few Cero keeps for you such as `room.members`, and every act is a verb on `cero` that takes one: `cero.put(room.messages, row)`, `cero.invite(room)`. Writes land on the device first and sync whenever another device is in reach, over the internet, through a mirror (an always-on peer that stores only ciphertext) or over Bluetooth. [How it works](how-it-works.md) explains what happens offline, on conflict and when someone is removed.

## Where to start

- **New to Cero?** The [Quickstart](quickstart.md) builds the chat above in two terminals, in about ten minutes.
- **Building an app?** Read the guides in order, from [Schema](schema.md) to [How it works](how-it-works.md).
- **Looking something up?** The [API reference](api.md), [Errors](errors.md) and [Core primitives](core.md).

Working with an AI agent? Point it at [skills/cero/SKILL.md](../skills/cero/SKILL.md), the short version of these pages.

## All pages

| Page                            | After it you can                                                               |
| ------------------------------- | ------------------------------------------------------------------------------ |
| [Quickstart](quickstart.md)     | run a shared, encrypted app in two terminals                                   |
| [Schema](schema.md)             | model any app's data                                                           |
| [Data](data.md)                 | write, query, watch, react to writes, batch, attach files                      |
| [Sharing](handles.md)           | open rooms, invite people, confirm joins, set roles, remove members            |
| [Your devices](identity.md)     | be the same user on every device, recover, remove a device                     |
| [Network](network.md)           | sync offline through mirrors, go nearby over Bluetooth, background, many rooms |
| [Apps](apps.md)                 | run Cero in a worker behind an Electron or Expo UI, run the three example apps |
| [Extensions](extensions.md)     | write behaviour once and reuse it: your own functions, extensions, actions     |
| [How it works](how-it-works.md) | predict what happens offline, on conflict, on removal, on join                 |
| [API reference](api.md)         | look up any verb, option, collection, status field                             |
| [Errors](errors.md)             | handle every error code                                                        |
| [Core primitives](core.md)      | build a tool on one primitive without the SDK                                  |

## Next

- [Quickstart](quickstart.md): the chat above, typed along, in two terminals.
- [Schema](schema.md): every field type, and changing a schema that shipped.
- [How it works](how-it-works.md): what the user sees offline, on conflict and on removal, and why.
