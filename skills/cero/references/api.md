# API reference

Every export of `@cero-base/cero` and its subpaths, in one page.

## On this page

- [The package](#the-package)
- [cero(dir, spec, opts)](#cerodir-spec-opts)
- [Operators](#operators)
- [Handle](#handle)
- [restore and peek](#restore-and-peek)
- [use, define and bind](#use-define-and-bind)
- [@cero-base/cero/build](#cero-basecerobuild)
- [@cero-base/cero/server](#cero-baseceroserver)
- [@cero-base/cero/client](#cero-baseceroclient)
- [@cero-base/cero/extensions](#cero-baseceroextensions)
- [Schema types](#schema-types)

## The package

```js
import { cero, t, schema } from '@cero-base/cero'
```

The package exports `cero`, `t`, `schema`, `restore`, `peek`, the fourteen
operators (`put`, `set`, `get`, `del`, `count`, `watch`, `changes`, `call`,
`open`, `rotate`, `before`, `after`, `bind`, `define`) and the classes `Handle`,
`Ref` and `Local`. Every operator is also a property of `cero`, so one import is
enough. Use the facade, `cero.put`, never an aliased named import. Subpaths:
`@cero-base/cero/build`, `/server`, `/client`, `/extensions`.

## cero(dir, spec, opts)

```js
const me = await cero('./data', spec, { name: 'laptop' })
```

Opens or creates a cero instance at `dir` and resolves to the ready root `Handle`,
with every schema ref attached as a property. `spec` is the built spec.

| Option            | Type                          | Default | Meaning                                                                                                                                         |
| ----------------- | ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | `string \| null`              | `null`  | Friendly device name, persisted on the identity claim.                                                                                          |
| `phrase`          | `string`                      | -       | BIP-39 mnemonic. On a device with no writer it recovers the identity from a reachable device.                                                   |
| `seed`            | `Uint8Array`                  | -       | 16 or 32 bytes of entropy, the alternative to `phrase`.                                                                                         |
| `words`           | `12 \| 24`                    | `12`    | Mnemonic length when generating a fresh identity.                                                                                               |
| `identity`        | `Identity`                    | -       | A pre-resolved identity, instead of `seed` or `phrase`.                                                                                         |
| `recoveryTimeout` | `number`                      | `30000` | How long recovery waits to find another device and be admitted, in ms.                                                                          |
| `storageKey`      | `Uint8Array`                  | -       | 32-byte key encrypting local key material at rest. Source it from the OS keychain, cero never stores it.                                        |
| `channel`         | `string`                      | -       | Network-isolation label. Only same-channel peers meet, and a storage remembers its channel.                                                     |
| `mirrors`         | `Array<string \| Uint8Array>` | `[]`    | Blind-peer keys. Rooms and files mirror through them, so peers sync while never online together.                                                |
| `bootstrap`       | `Array<{ host, port }>`       | -       | Custom DHT bootstrap nodes.                                                                                                                     |
| `backoffs`        | `number[]`                    | -       | Swarm reconnect backoff tiers in ms, for tests and tuning.                                                                                      |
| `isMobile`        | `boolean`                     | `false` | Marks this device as mobile.                                                                                                                    |
| `bluetooth`       | `boolean \| object`           | `false` | `true` starts nearby sync. `{ autoStart: false }` builds `me.bluetooth` without the radio. Also `backend`, `maxOutbound`, `maxInbound`, `pipe`. |
| `extensions`      | `boolean`                     | `true`  | `false` drops the bundled extensions. Build with `{ extensions: false }` too, so the spec matches.                                              |
| `routes`          | `Record<string, Function>`    | `{}`    | Handlers for the action refs your schema declares.                                                                                              |
| `onerror`         | `(err) => void`               | -       | Background-task error handler.                                                                                                                  |
| `key`             | `Uint8Array`                  | -       | Existing database key to recover into, skipping the pointer lookup.                                                                             |
| `encryptionKey`   | `Uint8Array`                  | -       | Pre-existing encryption key.                                                                                                                    |

## Operators

```js
await cero.put(me.todos, { text: 'buy milk' })
await cero.set(me.todos, { id, done: true })
const { data } = await cero.get(me.todos, { done: false, limit: 20 })
await cero.del(me.todos, id)
const { data: open } = await cero.count(me.todos, { done: false })
cero.watch(me.todos).on('data', ({ data }) => render(data))
for await (const { changes } of cero.changes(me.todos)) apply(changes)
await cero.call(room.promote, { memberId, role: 'admin' })
const room = await cero.open(me.room, { name: 'general' })
await cero.rotate(room)
cero.before(room.messages, ({ row }) => (row.text ? undefined : false))
cero.after(room.banned, ({ row, put }) => put(room.audit, { target: row.id }))
```

Every operator takes a `Ref` first. `me.messages` is a data ref, `me.room` a handle ref.

| Call                         | Returns                                                    | Notes                                                                             |
| ---------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `cero.put(ref, row)`         | `{ data }`                                                 | Insert, or overwrite by id. On `files`, uploads the bytes.                        |
| `cero.set(ref, row, opts)`   | `{ data }`                                                 | Merge over the stored row, keeping `createdAt`. `{ upsert: false }` updates only. |
| `cero.get(ref, q)`           | `{ data }`, `{ data \| null }`, or `{ data, total, size }` | Single, by id string, or a list. On a handle ref, lists child handles.            |
| `cero.del(ref, id)`          | `undefined`                                                | Delete a row by id, or wipe a single.                                             |
| `cero.count(ref, q)`         | `{ data: number }`                                         | Rows matching `q`.                                                                |
| `cero.watch(ref, q, opts)`   | `Readable`                                                 | Re-emits the latest `get` on every mutation, holding only the newest snapshot.    |
| `cero.changes(ref, q, opts)` | `Readable`                                                 | Batches of `{ prev, next }` pairs. Lossless. Not available on handle refs.        |
| `cero.call(ref, data)`       | `Promise<any>`                                             | Invoke an action ref.                                                             |
| `cero.open(ref, arg)`        | `Promise<Handle>`                                          | Create, join, or load a child handle.                                             |
| `cero.rotate(handle)`        | `{ epoch }`                                                | New encryption epoch. Needs the remove permission.                                |
| `cero.before(ref, fn, opts)` | `() => void`                                               | Rule run at apply on every peer. Return `false` to refuse, or mutate `ctx.row`.   |
| `cero.after(ref, fn, opts)`  | `() => void`                                               | Rule run at apply on every peer, in the same transaction. Derive rows here.       |

`watch`, `changes`, `before` and `after` take `{ signal }`. Watch streams are tied
to their handle and destroyed when it closes; a signal gives a shorter scope.

A hook's `ctx` is `{ op, name, row, existing, id, memberId, role, get, put, set, del }`.
The four operators on it read and write the room as it stands at this op, inside
the transaction; the imported ones throw inside a hook. Hooks must be
deterministic, and registered in the process that owns the data before any op
applies. See [Hooks](data.md#hooks).

`cero.open(ref, arg)` dispatches on `arg`: a string or `{ invite }` joins, `{ id }`
loads an existing child, anything else creates one. Create options are `name`,
`routes`, `role` (what auto-accepted candidates get) and `accept: false`, which
turns auto-accept off so you answer `handle.pair` yourself.

In a query `q`, any key that is not reserved is an equality filter on that field.
The reserved keys are `gt`, `gte`, `lt`, `lte` (bounds on `id`), `reverse`,
`limit`, `search`, `fields` and `total`. [Data](data.md) has the detail.

## Handle

```js
me.id // identity id
me.device // { id, name }
me.identity.toPhrase() // the twelve words

const room = await cero.open(me.room, { name: 'general' })
const invite = await room.invite({ role: 'member', expiresIn: 3600_000 })
await room.revoke(invite)
room.store.on('unwritable', () => showRemoved())
await room.leave()

await me.suspend()
await me.resume()
await me.close()
```

The root handle and every child handle are the same class.

| Member                    | Meaning                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `id`                      | Identity id on the root, the database key on a child. Both z32.               |
| `device`                  | `{ id, name }` for this device. `null` on a child.                            |
| `identity`                | The `Identity`. `identity.toPhrase()` returns the mnemonic.                   |
| `name`                    | Display name, on child handles.                                               |
| `root` / `parent`         | Top of the chain, and the immediate parent (`null` on the root).              |
| `store`                   | The underlying `Database`. `store.tx(fn)` batches writes atomically.          |
| `signal` / `suspended`    | An `AbortSignal` that fires on close, and whether the root is suspended.      |
| `blobs` / `fileServer`    | This handle's blob store, and the identity's file server.                     |
| `invite(opts)`            | Mint an invite. `{ role, expiresIn, data, reuse }`, resolves to a z32 string. |
| `revoke(invite)`          | Drop an invite everywhere. `true` if it was found.                            |
| `accept(candidate, opts)` | Admit a candidate. `{ role, name }`. Only needed with `accept: false`.        |
| `leave()`                 | Drop membership of a child handle and close it.                               |
| `close()`                 | Close this handle and everything under it.                                    |
| `suspend()` / `resume()`  | Pause and restore networking and storage. Root only, idempotent.              |
| `setActive(active)`       | Announce server-only when `false`, search again when `true`.                  |
| `getLink(id)`             | Local, ephemeral download url for a file id.                                  |
| `own(resource)`           | Destroy `resource` when this handle closes.                                   |
| `on(event, fn, opts)`     | Listener with an optional `{ signal }`.                                       |

A handle emits `'handle'` with `(child, opts)` when a child opens, and `'close'`.
Writability and app-version events live on `handle.store`: `'writable'`,
`'unwritable'`, `'update'`, `'behind'` and `'rebuild'`.

`me.local.<ref>` are the device-only refs from the schema's `local` block. They
take the same operators and never replicate. Every handle also carries the
builtin refs `members`, `devices`, `invites`, `handles` and `files`, undeclared.

## restore and peek

```js
const me2 = await cero.restore(me, phrase)
const exists = await cero.peek('./data', spec)
```

`restore(me, phrase)` closes the instance, wipes `dir/main` and reopens with the
phrase, carrying every other option over. It returns the running instance
unchanged when the phrase is already this identity. `peek(dir, spec)` resolves
`true` when `dir` already holds an identity, which is how a launcher chooses
between a first-run screen and a normal boot.

## use, define and bind

```js
cero.use(profileSync({ fields: { avatar: t.string } }))
cero.define({ room: { chat: { send } } })
```

`cero.use(...exts)` registers extensions. Call it before `build` and before
`cero()`, in both processes. It takes one extension, several, or an array; a bare
function is shorthand for `{ setup }`; a named one replaces a registered one of
the same name.

`cero.define(map)` registers custom operators by scope: a bare key binds on the
root, a key naming a child-handle type on every handle of that type.
`cero.bind(handle, map)` binds a `{ ns: module }` map by hand. Both curry the
handle as argument zero, so `room.chat.send(text)` calls `send(room, text)`.

## @cero-base/cero/build

```js
import { build } from '@cero-base/cero/build'

await build('./spec', schema)
```

`build(specDir, schema, opts)` compiles a schema into `specDir` and writes an
`index.js` there exporting `spec` and `meta`. `schema` is a `cero.schema(...)`
wrapper or its raw defs. Options: `ns` (namespace prefix, default `'cero'`) and
`extensions` (`false` leaves the bundled extensions out).

## @cero-base/cero/server

```js
import { serve } from '@cero-base/cero/server'

const server = await serve(ipc, spec, { storage: './data', name: 'alice' })
```

`serve(ipc, spec, opts)` bridges a framed duplex stream to a cero instance and
resolves to a ready `Server`. `opts.storage` is the data directory, and every
other option passes straight through to `cero()`. The root opens lazily, on the
client's first `init`.

## @cero-base/cero/client

```js
import { cero, connect } from '@cero-base/cero/client'

const me = await connect(ipc, spec)
```

`connect(ipc, spec)` resolves to a `Client` carrying the same refs and operators
as a local root handle. `cero(ipc, spec)` is an alias, so app code runs on either
side. The subpath also re-exports the operators, `t`, `schema`, `restore`, `bind`
and `define`. Handle stubs expose `invite`, `revoke`, `rotate`, `close` and
`leave`, and `me.identity.toPhrase()` is async here. `before`, `after`, `peek` and
`store.tx` are not on a client: hooks run where the data lives, so register them
on the backend.

## @cero-base/cero/extensions

```js
import { profileSync, handleSync } from '@cero-base/cero/extensions'
```

Both are bundled and on by default. `profileSync({ fields })` declares a `profile`
single and mirrors it onto your `member` row in every handle you are in.
`handleSync({ fields })` mirrors a child handle's `profile` onto its row in the
parent's `handles` list. `fields` defaults to `{ avatar: t.string }` in both.

## Schema types

```js
export const schema = cero.schema({
  profile: t.single({ name: t.required(t.string), avatar: t.file }),
  todos: t.collection({ text: t.string, done: t.bool }, { indexes: { 'by-done': ['done'] } }),
  promote: t.action({ memberId: t.string, role: t.string }),
  members: t.extend({ alias: t.string }),
  room: { messages: t.collection({ text: t.string }, { own: true }) },
  local: { drafts: t.collection({ text: t.string }) }
})
```

| Declaration                  | Meaning                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `t.string`                   | String.                                                                             |
| `t.uint` / `t.int`           | Unsigned and signed integers.                                                       |
| `t.bool`                     | Boolean.                                                                            |
| `t.bytes`                    | Buffer.                                                                             |
| `t.json`                     | Any JSON value.                                                                     |
| `t.fixed32` / `t.fixed64`    | Fixed-width buffers, for keys and hashes.                                           |
| `t.file`                     | A file id. Reads resolve to `{ id, name, type, size, url }`.                        |
| `t.required(type)`           | Marks a field required. Fields are optional by default.                             |
| `t.single(fields)`           | One record, read and written without an id.                                         |
| `t.collection(fields, opts)` | Rows keyed by `id`. `opts.indexes`, and `opts.own` to restrict a row to its author. |
| `t.action(fields)`           | A mutation that persists no row, handled by a `routes` entry.                       |
| `t.extend(fields)`           | Extra fields on a builtin. Redeclaring a base field throws.                         |
| `schema(defs)`               | Wraps the definitions for `build`.                                                  |

A nested plain object is a child handle type. A `local` block is device-only.

## Next

- [Errors](errors.md), for every code these calls can throw.
- [Data](data.md), for the operators in context.
- Core primitives, for the layer underneath.
