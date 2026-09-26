# Extensions

[Docs](README.md) · Previous: [Apps](apps.md) · Next: [How it works](how-it-works.md)

Write behaviour once and reuse it: your own functions for what the app does, extensions for rules
and schema every device runs, actions for named writes.

```js
// todo.js
import { cero } from '@cero-base/cero/extensions'

export const add = (me, text) => cero.put(me.todos, { text })
export const finish = (me, id) => cero.set(me.todos, { id, done: true })
export const remove = (me, id) => cero.del(me.todos, id)
export const pending = (me) => cero.get(me.todos, { done: false })
```

```js
import * as todo from './todo.js'

// me from cero('./data', spec) in the worker, or from cero(ipc, spec) in the UI
const { data: row } = await todo.add(me, 'buy milk')
await todo.finish(me, row.id)
```

## Your own functions

A feature is a file of plain functions, each taking the context first, `me` or a room, and calling
the `cero.` operators. Nothing registers them: import the file and call `todo.add(me, 'buy milk')`.

```js
// chat.js
import { cero } from '@cero-base/cero/extensions'

export const say = (room, text) => cero.put(room.messages, { text })
export const rename = (room, name) => cero.set(room.profile, { name })
```

Import `cero` from `@cero-base/cero/extensions`: it carries the operators without the runtime, so
the same file runs in the worker and bundles into the UI. Everything but `before`, `after` and
`tx` works on a client.

## Write an extension

An extension is `{ schema, setup }`, both optional. Its schema is folded into the build, and its
setup runs with the root wherever `cero()` opens the data, on every device.

```js
// seen.js
import { cero, t } from '@cero-base/cero/extensions'

export const seen = {
  schema: { room: { seen: t.collection({ at: t.int }) } },
  setup: (me) =>
    cero.after(me.room.messages, ({ op, row, memberId, put }) => {
      if (op === 'del') return // row is null on a delete
      return put(me.room.seen, { id: memberId, at: row.updatedAt })
    })
}
```

The schema nests by handle type like the app's, so `room.seen` joins the app's own refs on `room`.
A hook on the type ref `me.room.messages` reaches every room of the type, created, joined or
reopened, before it opens. The rules every hook follows are in
[React to writes](data.md#react-to-writes).

`setup(me)` runs before the root opens, so its hooks see every write. An operator called inside
it waits for the open, so `setup` may read and write, on a fresh identity too. `setup` may be
async, a function it returns runs on close, and a throw makes `cero()` reject.

## Name them in the build

```js
// extensions.js
import { profileSync, handleSync } from '@cero-base/cero/extensions'
import { seen } from './seen.js'

export const extensions = [profileSync(), handleSync(), seen]
```

```js
// build.js
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

await build('./spec', schema, { extensions: '../extensions.js' })
```

The path is resolved from the spec directory. The build folds each extension's schema in and
writes an import of the module into `spec/index.js`, so `cero('./data', spec)` runs every setup,
and a UI that loads the spec runs none. Because the spec imports it, `extensions.js` and every
extension module import from `@cero-base/cero/extensions`, never `@cero-base/cero`, and a setup
that needs something heavy imports it inside the function. A bare function in the list is
shorthand for `{ setup }`.

A list instead of a path, `build('./spec', schema, { extensions: [seen] })`, folds the schema only:
pass the same list to `cero('./data', spec, { extensions: [seen] })`, or `cero()` throws `INVALID`. `extensions: []` means none, at build and at open. `spec.extensions`
is the list `cero()` runs: the module's, `[]`, or with no option the two that ship. After a list,
it is `null`.

## The two that ship

| Extension       | Does                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `profileSync()` | Declares `profile: t.single({ name, avatar })` and copies it onto your row in `members` of every room you are in, on open and on every change. |
| `handleSync()`  | Copies a room's own `profile` onto its row in your `handles` list, so a room list shows names without opening the rooms.                       |

Both run when the build names no extensions, and neither writes when the row already matches.
Drop one by naming a list without it, or both with `[]`.

```js
// extensions.js
import { profileSync, handleSync, t } from '@cero-base/cero/extensions'

export const extensions = [
  profileSync({ fields: { avatar: t.string, status: t.string } }),
  handleSync()
]
```

`fields` replaces the default `{ avatar: t.string }` and lands on both `profile` and `members`. A
`profile` you declare yourself replaces the extension's; each of its fields must then exist on
`members` with the same type and hold a plain value or a file. A `t.file` avatar,
`profileSync({ fields: { avatar: t.file } })`, is copied with its file into each room, where every
member reads it.

`handleSync` needs the room type to declare `profile: t.single({ name: t.string })`, and any other
field of it must exist on `handles`, as `avatar` does by default. A `t.file` avatar,
`handleSync({ fields: { avatar: t.file } })`, is copied with its file into your list, and reads
with the room closed. `cero.open(me.room, { name })` writes the name into that profile.

## Give an action its handler

```js
// archive.js
import { cero, t } from '@cero-base/cero/extensions'

export const archive = {
  schema: { archive: t.action({ until: t.int }) },
  setup: (me) =>
    cero.after(me.archive, async ({ row, get, del }) => {
      const { data } = await get(me.todos)
      const old = data.filter((todo) => todo.done && todo.updatedAt < row.until)
      for (const todo of old) await del(me.todos, todo.id)
    })
}
```

```js
await cero.call(me.archive, { until: Date.now() })
```

An action's `after` hook is what it does, on every device, with `row` as the payload. It follows
every hook rule: read and write through ctx only, and a throw, or a `before` that returns `false`,
refuses the call. Its writes through ctx are the caller's own: an action cannot do what its caller
may not, such as raise a role. Calling an action with no `after` hook throws `INVALID`, and a
device without the hook reports the action to `onerror`. In a handle type, register on the type
ref, `cero.after(me.room.archive, fn)`, and call it on a room, `cero.call(room.archive, data)`.

## Add to an app that shipped

An extension's `t.extend` fields go ahead of the fields already added to that builtin, so adding
one to a shipped app can reorder them and break stored rows, see
[Change a schema that shipped](schema.md#change-a-schema-that-shipped). Give the extension its
own collection instead, as `seen` does: `schema: { room: { seen: t.collection({ at: t.int }) } }`.

## Next

- [How it works](how-it-works.md) for what a hook sees offline and on conflict.
- [Apps](apps.md) for which process runs what.
- [API reference](api.md) for every operator and option.
