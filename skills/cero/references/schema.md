# Schema

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

`put` is for collections only: on a single it throws `INVALID`, and a single is written with `set`. A single has no `id` and no fields
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

## Push a notification on a write

```js
const schema = cero.schema({
  room: { messages: t.collection({ text: t.string }, { push: true }) }
})
```

With `push`, a write to the collection, single or action pushes a notification to the other
members' devices through the handle's mirror, while their app is dead too. Refs without it never
push. The schema says only which refs push: what a notification says is the app's, in its push
worklet, where its other strings live; the written row rides along when it fits the push, so the
worklet can show it. [Network](network.md#push-while-the-app-is-dead) has the
setup. Declaring `push` changes nothing stored, so the contract stays.

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
`device`, `keypair`, `handle-keypairs`, `joins`, `inbox`, `outbox`, `environment`, `serving`,
`topics`.

## Add fields to a builtin

```js
const schema = cero.schema({ members: t.extend({ bio: t.string }) })
```

Every scope, the root and each handle, has the builtins `members`, `devices`, `invites`,
`requests`, `handles` and `files`. `t.extend` adds fields to one. Put it at the top level: it
extends that builtin in every scope, and inside a handle type it is ignored. Redeclaring a
builtin's own field fails the build.

The bundled extensions add fields too. `profileSync` declares `profile: t.single({ name, avatar })`
and copies `name` and its `fields` onto your row in `members`. To add a profile field, list it in
`fields`, and every member sees it, or declare `profile` yourself with it: a field outside `fields`
stays on `me.profile`, on your devices only. `profile` is not a builtin, so `t.extend` cannot add to
it. A `t.file` field is copied with its file, so it resolves in every handle. See
[the two that ship](extensions.md#the-two-that-ship).

## Reserved names

The build throws `INVALID` on a name Cero takes, and says which one to rename:

- A field of a collection named `id`, `memberId`, `index`, `createdAt` or `updatedAt`: Cero
  writes these on every row. In a single, and in a field added to a builtin, only `memberId` is
  taken.
- A ref named like a builtin of its scope: `members`, `devices`, `invites`, `requests`,
  `handles`, `files` and `status` at the root and in a handle type, and `joins`, `nearby` and
  `topics` at the root. In `local`, the names listed [above](#keep-data-on-this-device).
- A ref named like something Cero stores or sends under that name, such as `member`, `invite`,
  `epochs` or `counters`.
- A ref whose writes would take one of Cero's: an action named `accept`, or a collection named
  `member`, whose `add-member` Cero already has.
- A name the root, a handle, the local store or the client in a UI carries, such as `id`, `name`,
  `type`, `store`, `parent`, `children`, `device`, `identity`, `network`, `spec`, `signal`,
  `root`, `close`, `on` or the operators `put`, `set`, `get`, `del`, `watch` and `call`, and any
  name that starts with `_`.
- A handle type whose name is not a letter followed by letters, digits or `_`: `chatRoom` builds,
  `chat-room` does not.

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
type, a bad `t.extend`, a [reserved name](#reserved-names), or a change that would break stored
rows.

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

Fields are stored by position, so add new ones at the end. A field added later is optional: the
rows stored before it do not have it, so `t.required` on one fails the build. Removing or renaming
a field, or changing its type or `required`, fails the build too, and so does turning `own` on or
off for a collection that shipped: a new rule needs a new collection. A collection, a single or an
action that shipped stays in the schema: removing one, or declaring it as another kind, fails the
build, because every log holds writes to it. Reordering two fields of the same type builds, and
swaps their data on every row. A build that fails leaves `spec/` as it was. Keep
`spec/` in git and rebuild over it after every change: it records what shipped.

The build keeps one version for the app, its contract, in `spec/contract.json`. It rises by one in
a build that changes what is stored, a type, a collection or an action, at the root or in any handle
type, and never goes down. A build that changes nothing stored keeps it, and so does an upgrade of
Cero that changes only what a device computes on read, such as `status`, or how a UI talks to its
worker. An upgrade of Cero that changes what a write means raises it on the next build, as a stored
change does. An index added by a rebuild fills on the next open: the rows written before it are
found through it.

### A handle's version

The root and every handle each have a version of their own, `status.version`. A new one starts at the version its build asks for, and an owner's device on a newer build moves it there when
it opens it. Until then every device writes as the handle's version: what a newer build added and the
handle does not have yet is left alone, and a write naming it throws `UNSUPPORTED`. Once the handle
has moved past a device's build, that device reads, `status.behind` says so, and its writes throw
`BEHIND` until it updates. A device behind in its root is behind in every handle too.

### Hold back what a release adds

A release can ship a field, a collection, a single or an action before handles use it, so that the
devices still on the previous release keep writing. Mark it with `t.later`:

```js
const v3 = cero.schema({
  todos: t.collection({ text: t.string, done: t.bool, due: t.int, tag: t.later(t.string) }),
  visits: t.later(t.collection({ date: t.string }))
})
```

The build then asks handles for the version below the first thing held back, and an owner's device
moves them no further. A later release removes the mark, and a handle turns it on once an owner's
device has that release. In the app, check before showing it:

```js
if (await cero.supports(room.todos, 'tag')) showTags()
if (await cero.supports(room.visits)) showVisits()
```

`t.later` takes a field of a collection, a single or an action, a field of a builtin through
`t.extend`, or a whole collection, single or action, at the root or in a handle type. Things turn on
in the order they shipped: a build that adds something after a thing it holds back fails unless that
is held too, and a thing handles use already cannot be held. What one build adds turns on together,
and a handle type, an index or a change in an extension cannot be held back on its own.

## Next

- [Data](data.md) to write, query and watch what you described.
- [Sharing](handles.md) to open a handle and invite people.
- [Extensions](extensions.md) to give actions their handlers and reuse schema.
