# Extensions

```js
cero.use({
  name: 'bookmarks',
  schema: { bookmarks: t.collection({ url: t.string, title: t.string }) },
  setup(me) {
    cero.after(me.bookmarks, ({ row }) => console.log('bookmarked', row.url), {
      signal: me.signal
    })
  }
})
```

An extension is a piece of cero you can add: a collection, a field, a behaviour,
or all three. `me.bookmarks` now exists like any ref you declared yourself.

## Where to register

An extension's `schema` is folded into the build, and its `setup` runs inside
`cero()`. So register it in the two files that do those things, before they do
them: `build.js` and whichever file opens cero.

```js
// build.js
import { cero } from '@cero-base/cero'
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'
import { bookmarks } from './bookmarks.js'

cero.use(bookmarks())
await build('./spec', schema)
```

```js
// server.js, or index.js when cero runs in-process
cero.use(bookmarks())
const me = await cero('./data', spec)
```

Miss one of the two and the spec and the runtime disagree. A UI process
registers nothing: `@cero-base/cero/client` has no `use`.

`cero.use` accepts one extension, several, an array, or a bare function as
shorthand for `{ setup }`. Registering the same `name` again replaces the
earlier one instead of adding a second.

```js
cero.use(a, b)
cero.use([a, b])
cero.use((me) => {
  const timer = setInterval(() => cero.set(me.profile, { seenAt: Date.now() }), 60_000)
  return () => clearInterval(timer) // the returned function runs on close
})
```

## The two that ship

| extension     | what it does for you                                                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| `profileSync` | Set your profile once. Every room you are in shows your name and avatar in its member list. |
| `handleSync`  | Name a room once. Your room list shows names and avatars without opening any of them.       |

Both are registered already. `profileSync` declares a `profile` single of
`{ name, avatar }` and extends the `member` builtin with the same extra fields,
then republishes when you open a room and whenever your profile changes.
`handleSync` extends the `handle` builtin and mirrors a room's own `profile`
onto its row in your list, leaving room types without a `profile` alone. Neither
writes when the row already matches, so reopening rooms costs no ops.

Reconfigure or disable them from `@cero-base/cero/extensions`.

```js
import { profileSync } from '@cero-base/cero/extensions'

cero.use(profileSync({ fields: { status: t.string } }))
```

```js
await build('./spec', schema, { extensions: false })
const me = await cero('./data', spec, { extensions: false })
```

An app that declares its own richer `profile` wins: on a field conflict the app
schema beats the extension's.

## Writing one

| field       | meaning                                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| `name`      | Optional. Registering the same name again replaces the earlier one.                  |
| `schema`    | Folded into the build. New refs, or `t.extend` on a builtin.                         |
| `setup(me)` | Runs once the root handle is ready. May be async. A returned function runs on close. |

```js
export function lastSeen() {
  return {
    name: 'last-seen',
    schema: { members: t.extend({ seenAt: t.int }) },
    setup(me) {
      me.on(
        'handle',
        async (room) => {
          const { data } = await cero.get(room.members, me.identity.id)
          if (data) {
            await cero.set(
              room.members,
              { id: me.identity.id, seenAt: Date.now() },
              { upsert: false }
            )
          }
        },
        { signal: me.signal }
      )
    }
  }
}
```

`t.extend` adds fields to `members`, `devices`, `invites`, `handles` or `files`.
Redeclaring a field the builtin already has fails at build time. `me.signal`
aborts when the root closes, so the listener goes with it. `{ upsert: false }`
updates a row that exists and never invents one. Read before you write: an
unconditional write on every open is a new op in the room's log forever.

A `setup` that throws makes `cero()` reject and closes what it opened, so a
retry in the same process works.

## Custom operators

`cero.define` registers plain functions by scope. A bare key binds on the root
handle, a key that names a handle type binds on every handle of that type. cero
curries the handle as the first argument when it opens each one.

```js
cero.define({
  user: { rename: (h, name) => cero.set(h.profile, { name }) },
  room: { note: { add: (h, text) => cero.put(h.notes, { text }) } }
})

await me.user.rename('jb')
const room = await cero.open(me.room, { name: 'general' })
await room.note.add('hello')
```

Call `define` once at startup, before `cero()` or `connect()`, in both
processes. The operators are composed from the ordinary operators, so the same
call works in-process and over RPC.

`cero.bind(handle, { ns: module })` does the same binding by hand, for a handle
you built yourself or a namespace you do not want registered globally.

## Next

- [Files](files.md) for the `files` builtin extensions can extend.
- [Handles](handles.md) for the `handle` event extensions hook.
- [Apps](apps.md) for which process registers what.
