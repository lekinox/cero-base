---
name: cero
description: >-
  How to build local-first, peer-to-peer apps with Cero (@cero-base/cero), the
  SDK of Cero Base. Use for any task on a project that depends on @cero-base/*:
  designing a schema, reading and writing data, rooms and invites, roles,
  confirming joins, multi-device identity and phrase recovery, apps with a UI
  over a Bare worker or worklet, extensions and hooks, mirrors and Bluetooth,
  or "build a p2p app with cero".
---

# Cero

Cero is a local-first, peer-to-peer SDK on the Pear stack by Holepunch: describe your data, and Cero
stores it on the device, syncs it between a user's devices and shares it with the people they
invite. No server, no accounts. Runs on Node and on Bare. It is one of the two packages of Cero Base;
the other, Core (`@cero-base/core`), holds the primitives Cero is built from.

Experimental: the API is subject to change and may break at any time.

This file is the short version. `references/` holds the full guides; the table at the end names the
file for each task.

## Mental model

- `me = await cero(dir, spec)` is the root: the user, their devices, their rooms.
- A room is a space shared with other people: `cero.open(me.room, { name })` creates one,
  `cero.open(me.room, invite)` joins one, `cero.open(me.room, { id })` reopens one.
- `me` and every room are contexts: plain state, no methods. Refs hang off them: `me.notes`,
  `room.messages`, and the builtins `members`, `devices`, `invites`, `requests`, `handles`,
  `files`, `status` on every context, `joins` and `nearby` on `me`.
- Every act is a verb on the `cero` facade. Data verbs take a ref first
  (`cero.put(room.messages, row)`); the rest take the context first (`cero.invite(room)`,
  `cero.leave(room)`, `cero.suspend(me)`). What changes is read with `get` and followed with `watch`.
- The identity is a phrase. The same phrase on another device is the same user; each device writes
  its own log.

## The workflow, always the same three files

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  notes: t.collection({ title: t.string, body: t.string }),
  room: { messages: t.collection({ text: t.string }) }, // an object is a room type
  local: { settings: t.collection({ key: t.string, value: t.string }) } // this device only
})
```

```js
// build.js: run it after every schema change, over the same spec/
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

await build('./spec', schema)
```

```js
// app.js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

const me = await cero('./data', spec)
await cero.put(me.notes, { title: 'first', body: 'hello' })

const room = await cero.open(me.room, { name: 'general' })
const invite = await cero.invite(room) // give this string to a friend
await cero.put(room.messages, { text: 'hi' })
for await (const { data } of cero.watch(room.messages)) console.log(data)
```

A friend with the same `spec/` joins with `cero.open(me.room, invite)`. Another device of yours:
`cero('./data', spec, { seed: cero.toSeed(phrase) })` in a fresh directory.

## Rules

1. **Open against the built spec**, never the raw schema. The app, the worker and the UI import the
   same generated `spec/index.js`. Keep `spec/` in git.
2. **Name extensions at build time, by module path**:
   `build('./spec', schema, { extensions: '../extensions.js' })`, so the spec carries them. A list
   passed to `build` folds the schema only; then pass the same list to
   `cero(dir, spec, { extensions })`. `setup(me)` runs before the root opens, so hooks registered
   there see every op; a hook on a type ref (`me.room.notes`) reaches every room of the type.
3. **Add fields at the end.** Removing a field or changing its type fails the build; reordering two
   fields of the same type swaps their data.
4. **`put` writes a whole row, `set` merges.** `put` creates a row, or replaces it whole when you
   pass an existing `id`. `set` merges your fields over the stored row on this device and writes it:
   of two devices setting one row at once, the one applied last wins. On a single, always `set`.
5. **Use the facade.** `import { cero } from '@cero-base/cero'` (or `/client` in a UI) and call
   `cero.put`, `cero.get`, `cero.open`. Never alias named imports. Contexts have no methods.
6. **Cleanup follows the context.** `watch` streams end with their context, or pass
   `cero.watch(ref, query, { signal })`; `await cero.close(me)` on shutdown.
7. **Invites come from rooms.** `cero.invite(room, { role })` admits a member at that rank
   (`owner`, `admin`, `member`, `reader`; `member` by default). A `confirm` invite holds each join in
   `room.requests` until `cero.accept(room, request)` or `cero.deny(room, request, reason)`.
   `cero.del(room.members, id)` removes a member and re-keys the room shortly after;
   `await cero.rotate(room)` re-keys at once.
8. **A phrase recovers, it never creates.** `cero(dir, spec)` with no seed makes a new identity;
   show `await cero.phrase(me)` to the user once. With a seed, Cero finds one of the user's devices
   (same `channel` and `mirrors`) and recovers, or rejects with `TIMEOUT`.
9. **Bare has no Node globals.** Import `fs`, `path`, `crypto` plainly, no `node:` prefix, and map
   them in your package.json `imports` (`"fs": { "bare": "bare-fs", "default": "fs" }`), as Cero
   does for its own.
10. **An action is its `after` hook.** `cero.after(me.room.promote, fn)` in an extension's `setup`
    is what `cero.call(room.promote, args)` does, on every peer. An action with no `after` hook
    throws `INVALID`. In a hook, `row` is `null` on a delete.

## Reading

```js
const { data, total } = await cero.get(me.notes, { title: 'first', reverse: true, limit: 20 })
cero.watch(me.notes, {}).on('data', ({ data }) => console.log(data))
const { data: status } = await cero.get(room.status) // { role, writable, epoch, suspended, behind, nearby }
```

- `get(ref)` lists, `get(ref, id)` fetches one, `get(ref, { field })` filters. Queries: equality on
  fields, `gt` / `gte` / `lt` / `lte` on the id, `reverse`, `limit`, `total`, `search` with
  optional `fields`. There is no sort: sort in memory.
- `watch(ref, query)` streams `{ data }`: the result now and after every change, local or remote.
  With `changes: true` in the query each item also carries `changes`, the `{ prev, next }` rows
  that changed since the item before, and `reset` on the first.
- `status` is this device's view of a context: `writable` and `role` turn `false` / `null` when you
  are removed, `suspended` follows `cero.suspend(me)` / `cero.resume(me)` (the app's background and
  foreground), `behind` asks for an app update. `cero.activate(room)` ranks the room on screen first
  on the swarm.

## Apps with a UI

```js
// the worker (Node, a Bare worker or worklet)
import { serve } from '@cero-base/cero/server'
const server = await serve(ipc, spec, { storage: './data' })
```

```js
// the UI
import { cero } from '@cero-base/cero/client'
const me = await cero(ipc, spec, { onerror: console.error })
```

The UI gets every verb over the wire but `before`, `after` and `tx`, which take functions and run
only in the worker. Match errors on `err.code`: only the code and message cross. Electron uses a
Bare worker, Expo a Bare worklet, tests a duplex pair.

## Where to read

| Task                                                           | Page                                       |
| -------------------------------------------------------------- | ------------------------------------------ |
| A first app running in two terminals                           | [quickstart](references/quickstart.md)     |
| Field types, singles, collections, rooms, local, indexes       | [schema](references/schema.md)             |
| Writes, queries, watch, hooks, batches, files                  | [data](references/data.md)                 |
| Rooms, invites, confirming joins, roles, removing, leaving     | [sharing](references/handles.md)           |
| The phrase, a second device, recovery, restore                 | [your devices](references/identity.md)     |
| Mirrors, channels, background, many rooms, Bluetooth, versions | [network](references/network.md)           |
| A worker behind an Electron or Expo UI, the examples           | [apps](references/apps.md)                 |
| Your own functions, extensions, actions                        | [extensions](references/extensions.md)     |
| What happens offline, on a join, on a removal, on recovery     | [how it works](references/how-it-works.md) |
| Every export and option                                        | [api reference](references/api.md)         |
| Every error code                                               | [errors](references/errors.md)             |
| Testing an app                                                 | [testing](references/testing.md)           |

Copy the whole `skills/cero` folder; nothing points outside it.
