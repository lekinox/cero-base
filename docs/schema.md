# Schema

[Docs](README.md) · Previous: [Quickstart](quickstart.md) · Next: [Data](data.md)

Describe your app's data once, build it, and every device opens the same shape.

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  profile: t.single({ name: t.string }),
  todos: t.collection({ text: t.required(t.string), done: t.bool }),
  room: {
    profile: t.single({ name: t.string }),
    messages: t.collection({ text: t.string }, { own: true })
  },
  local: { drafts: t.collection({ text: t.string }) }
})
```

`profile` is a single and `todos` a collection, the two kinds of data you declare, explained
[below](#singles-and-collections). A plain object such as `room` is a handle type, shared with
other people. `local` never leaves this device.

## Singles and collections

Everything you store is one of two kinds:

- A **single** is one record, such as a profile or the app's settings. There is exactly one per
  context: `me.settings` is yours, on every device you link, and `room.profile` belongs to each
  handle, the same for all its members.
- A **collection** holds many rows, such as todos or messages. Every row has an `id`, and you add,
  change, find and delete rows one at a time.

```js
const schema = cero.schema({
  settings: t.single({ theme: t.string, compact: t.bool }),
  todos: t.collection({ text: t.string, done: t.bool })
})
```

```js
// me from cero('./data', spec), see the quickstart
await cero.set(me.settings, { theme: 'dark' }) // merges into the one record
const { data: settings } = await cero.get(me.settings) // the record, or null

const { data: todo } = await cero.put(me.todos, { text: 'buy milk' }) // adds a row
await cero.set(me.todos, { id: todo.id, done: true }) // changes that row
const { data: open } = await cero.get(me.todos, { done: false }) // a list of rows
await cero.del(me.todos, todo.id) // deletes it
```

|        | Single                                            | Collection                                                                                          |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Holds  | one record                                        | many rows, each with an `id`                                                                        |
| Add    | nothing to add: `set` writes it                   | `cero.put(ref, row)`: a new row, or replaces the whole row with that `id`                           |
| Change | `cero.set(ref, fields)`: merges into the record   | `cero.set(ref, { id, ...fields })`: merges into that row                                            |
| Read   | `cero.get(ref)`: `{ data }`, the record or `null` | `cero.get(ref, id)`: `{ data }`, the row or `null`. `cero.get(ref, query)`: `{ data, total, size }` |
| Delete | `cero.del(ref)` wipes the record                  | `cero.del(ref, id)` deletes that row                                                                |
| Follow | `cero.watch(ref)`                                 | `cero.watch(ref, query)`                                                                            |

`put` is for collections only: a single is written with `set`. A single has no `id` and no fields
of Cero's. Every row of a collection also carries fields Cero writes, which you can't declare
yourself:

| Field       | Is                                                                   |
| ----------- | -------------------------------------------------------------------- |
| `id`        | a string, generated unless you pass one                              |
| `memberId`  | the member who last wrote the row                                    |
| `index`     | a number per collection, rising as rows are added; kept on overwrite |
| `createdAt` | milliseconds, the first write of the row                             |
| `updatedAt` | milliseconds, its latest write                                       |

[Data](data.md) covers every call in full: queries, paging, search and watching.

## Pick a field type

| Marker                   | Holds                                             | Unset reads |
| ------------------------ | ------------------------------------------------- | ----------- |
| `t.string`               | text                                              | `null`      |
| `t.uint`, `t.int`        | a whole number, unsigned or signed                | `0`         |
| `t.bool`                 | `true` or `false`                                 | `false`     |
| `t.bytes`                | a buffer                                          | `null`      |
| `t.json`                 | any JSON value                                    | `null`      |
| `t.fixed32`, `t.fixed64` | a buffer of exactly 32 or 64 bytes                | `null`      |
| `t.file`                 | a file id, read back as `{ id, type, size, url }` | `null`      |

Every field is optional, and falsy values are not stored: a string written as `''` reads back
`null`. `t.required(t.string)` makes a field required: a write that leaves it unset throws
`INVALID`, naming the field. A `t.file`
field holds the id of an upload, see [Files](data.md#files).

## Let only the author change a row

```js
const schema = cero.schema({ notes: t.collection({ text: t.string }, { own: true }) })
```

With `own`, anyone who may write adds rows, but only the author, or a member with the remove
permission (admins and owners), changes or deletes one. Without it, everyone who may write edits
every row. [Sharing](handles.md) explains roles.

## Look rows up by a field

```js
const schema = cero.schema({
  todos: t.collection({ text: t.string, done: t.bool }, { indexes: { 'by-done': ['done'] } })
})
```

A query whose equality fields are exactly an index's fields reads through it, here
`cero.get(me.todos, { done: false })`. Through an index, rows come back ordered by the index
fields, then id, and `reverse` and `limit` follow that order. Every collection outside `local`
also has an index on `index`, so `{ reverse: true, limit: 20 }` reads only the newest 20 rows.

## Share a space with other people

```js
const schema = cero.schema({
  room: {
    profile: t.single({ name: t.string }),
    messages: t.collection({ text: t.string })
  }
})
```

A plain object declares a handle type: a space you open, share by invite and remove people from.
The examples call theirs `room`. Each handle also has its own builtins, `room.members` and the rest.
Handle types nest one level: a plain object inside one is dropped without an error.
[Sharing](handles.md) opens and shares them.

## Keep data on this device

```js
// me from cero('./data', spec), see the quickstart
await cero.put(me.local.drafts, { text: 'half a thought' })
```

`local` holds collections and singles that stay on this device, at `me.local.<name>`. They have no
hooks, batches, actions or `t.file`, and lists come back in id order. Cero keeps its own device data there, so these names are taken: `master`,
`keypair`, `handle-keypairs`, `joins`, `inbox`, `outbox`, `environment`, `serving`.

## Add fields to a builtin

```js
const schema = cero.schema({ members: t.extend({ bio: t.string }) })
```

Every scope, the root and each handle, has the builtins `members`, `devices`, `invites`,
`requests`, `handles` and `files`. `t.extend` adds fields to one. Put it at the top level: it
extends that builtin in every scope, and inside a handle type it is ignored. Redeclaring a
builtin's own field fails the build.

The bundled extensions add fields too. A `profile` you declare replaces the extension's, and each
of its fields is copied onto your row in `members`, so each must exist there with the same type.
A `t.file` field is copied with its file, so it resolves in every handle. See
[the two that ship](extensions.md#the-two-that-ship).

## Reserved names

- `status` at the root or in a handle type, and `joins` or `nearby` at the root: Cero computes
  these on the device, and the build throws.
- A builtin's name, such as `members` or `files`, for a ref of your own.
- A name the root or a handle already carries, such as `id`, `type`, `store`, `parent`,
  `children`, `device`, `identity`, `network`, `spec`, `signal` or `root`. It builds, then throws
  `INVALID` when the root or the handle opens.

## Declare an action

```js
const schema = cero.schema({ archive: t.action({ until: t.int }) })
```

```js
await cero.call(me.archive, { until: Date.now() }) // throws INVALID until it has a handler
```

An action is a named write with a payload and no row, and `cero.call` resolves `undefined`. What
it does is its handler, an `after` hook registered in an extension:
[Give an action its handler](extensions.md#give-an-action-its-handler). An action in a handle type
is called on a handle, `cero.call(room.archive, data)`.

## Build the spec

```js
// build.js
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

await build('./spec', schema)
```

`spec/index.js` exports `spec`, which you pass to `cero()`. The build fails on an unknown field
type, a bad `t.extend`, a computed name, or a change that would break stored rows.

| Option       | Default         | Does                                                                                                                                                                |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions` | the bundled two | A module path, resolved from the spec directory, whose `extensions` list the spec imports; or a list, folded into the schema only. See [Extensions](extensions.md). |
| `ns`         | `'cero'`        | The namespace of the emitted ids.                                                                                                                                   |

## Change a schema that shipped

```js
const v1 = cero.schema({ todos: t.collection({ text: t.string, done: t.bool }) })
// a new field goes at the end
const v2 = cero.schema({ todos: t.collection({ text: t.string, done: t.bool, due: t.int }) })
```

Fields are stored by position, so add new ones at the end. Removing a field, or changing its type
or `required`, fails the build. Reordering two fields of the same type builds, and swaps their
data on every row. Keep `spec/` in git and rebuild over it after every change: it records what
shipped. A device on an older build skips writes from a newer one until it updates, and
`me.status` says so in `behind`.

## Next

- [Data](data.md) to write, query and watch what you described.
- [Sharing](handles.md) to open a handle and invite people.
- [Extensions](extensions.md) to give actions their handlers and reuse schema.
