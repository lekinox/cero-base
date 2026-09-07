# Extensions

[Docs](README.md) · Previous: [Apps](apps.md) · Next: [Operators](operators.md)

```js
// bookmarks.js
import { cero, t } from '@cero-base/cero/extensions'

export const bookmarks = {
  schema: { bookmarks: t.collection({ url: t.string, title: t.string }) },
  setup: (me) =>
    cero.after(me.bookmarks, ({ row }) => console.log('bookmarked', row.url), { signal: me.signal })
}
```

An extension is a piece of cero you can add: a collection, a field, a
behaviour, or all three. `me.bookmarks` now exists like any ref you declared
yourself.

## Named once

An app names its extensions in one module and tells `build` where it is. The
build folds each `schema` into the spec and writes an import of that module into
`spec/index.js`, so `cero()` finds the list there and runs each `setup`.

```js
// extensions.js
import { profileSync, handleSync } from '@cero-base/cero/extensions'
import { bookmarks } from './bookmarks.js'

export const extensions = [profileSync(), handleSync(), bookmarks]
```

```js
// build.js
await build('./spec', schema, { extensions: '../extensions.js' })
```

The path is written into the spec as given, so it is relative to the spec
directory and names the file as it exists at runtime. Nothing else registers
anything: `cero('./data', spec)` runs the list. A UI process loads the same
spec and ignores it, `setup` never runs on a client.

The list holds extension objects, or a bare function as shorthand for
`{ setup }`.

```js
export const extensions = [
  profileSync(),
  bookmarks,
  (me) => {
    const timer = setInterval(() => cero.set(me.profile, { seenAt: Date.now() }), 60_000)
    return () => clearInterval(timer) // the returned function runs on close
  }
]
```

Two things follow from the spec importing the module. It is bundled into the UI,
so `extensions.js` and every extension module import from
`@cero-base/cero/extensions`, which carries the `cero` facade, `t` and `schema`
without the runtime, never from `@cero-base/cero`. And a `setup` that needs
something heavy imports it inside the function.

## The two that ship

| extension     | what it does for you                                                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| `profileSync` | Set your profile once. Every room you are in shows your name and avatar in its member list. |
| `handleSync`  | Name a room once. Your room list shows names and avatars without opening any of them.       |

Both run when a build names no list. `profileSync` declares a `profile` single of
`{ name, avatar }` and extends the `member` builtin with the same extra fields,
then republishes when you open a room and whenever your profile changes.
`handleSync` extends the `handle` builtin and mirrors a room's own `profile`
onto its row in your list, leaving room types without a `profile` alone. Neither
writes when the row already matches, so reopening rooms costs no ops.

To reconfigure one, name a list that holds your instance. To drop them, name a
list without them.

```js
export const extensions = [profileSync({ fields: { status: t.string } }), handleSync()]
```

An app that declares its own richer `profile` wins: on a field conflict the app
schema beats the extension's.

A list can also be passed directly. `build(dir, schema, { extensions: [] })` folds
nothing and writes no import, and `cero(dir, spec, { extensions })` runs that
list instead of the spec's. That is the hatch for tests and for an extension
configured at runtime, a devtools tap with a live transport for instance:
`{ extensions: [...spec.extensions, devtools({ transport })] }`.

## Writing one

| field       | meaning                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `schema`    | Folded into the build. New refs, or `t.extend` on a builtin, nested by handle type like the schema. |
| `setup(me)` | Runs once the root handle is ready. May be async. A returned function runs on close.                |

```js
export const lastSeen = {
  schema: { members: t.extend({ seenAt: t.uint }) },
  setup: (me) =>
    cero.after(me.room.messages, ({ row, memberId, set }) =>
      set('members', { id: memberId, seenAt: row.updatedAt })
    )
}
```

`t.extend` adds fields to `members`, `devices`, `invites`, `handles` or `files`.
Redeclaring a field the builtin already has fails at build time. The hook runs
on every peer inside the message's transaction, so it writes through `ctx.set`
and stamps the row's own time, never the clock. `me.signal` aborts when the root
closes, so a listener registered with it goes with it.

A `setup` that throws makes `cero()` reject and closes what it opened, so a
retry in the same process works.

## On every room

A schema nests by handle type, exactly like the app schema, so an extension adds
a collection to rooms with `{ room: { notes: ... } }` and the app's own refs on
`room` are kept. A hook on `me.room.notes` applies to every room, the ones open
now and every one opened later, so `setup` never has to wait for a `handle`
event.

```js
export const notes = {
  schema: { room: { notes: t.collection({ text: t.string }) } },
  setup: (me) => cero.before(me.room.notes, ({ row }) => !!row.text.trim())
}
```

The functions an app calls on those notes are [operators](operators.md), named
the same way and kept apart.

## Next

- [Operators](operators.md) for functions bound on handles.
- [Files](files.md) for the `files` builtin extensions can extend.
- [Handles](handles.md) for the `handle` event.
- [Apps](apps.md) for which process runs what.
