---
name: cero
description: >-
  How to build local-first, peer-to-peer apps with cero (@cero-base/cero).
  Use for any task on a project that depends on @cero-base/*: designing a
  schema, using the operators, child handles and invites, roles, multi-device
  identity and phrase recovery, split apps with serve/connect over a Bare
  worker or worklet, extensions and custom operators, or "build a p2p app
  with cero".
---

# cero

A simple peer-to-peer SDK on top of the Pear stack by Holepunch. One function, a
schema, and a handful of operators. cero stores data on the
device, syncs it between a user's devices, and shares it with the people they
invite. No server, no accounts. Runs on Node and on Bare.

Experimental: the API is subject to change and may break at any time.

This file is the short version. The `references/` folder holds the full guides, one file per topic; the table at the end names the file for each task.

## Mental model

**Everything is a handle. Handles contain refs. Refs contain rows.**

- `me = await cero(dir, spec)` is the root handle: the user, their devices,
  their child handles.
- A child handle is a space opened from `me` and shared with other people:
  `cero.open(me.room, { name })` creates one, `cero.open(me.room, { invite })`
  joins one, `{ id }` reopens one. The examples call theirs rooms.
- A ref is a table on a handle: `me.notes`, `room.messages`, `room.members`.
  Every operator takes a ref first. Builtin refs on every handle: `members`,
  `devices`, `invites`, `handles`, `files`.
- The identity is a phrase. The same phrase on another device is the same
  user, with that device's own writer and the full history.

## The workflow, always the same three files

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  notes: t.collection({ title: t.string, body: t.string }),
  room: { messages: t.collection({ text: t.string }) }, // an object = a child handle type
  local: { settings: t.collection({ key: t.string, value: t.string }) } // device only
})
```

```js
// build.js, run once and after every schema change
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

await build('./spec', schema)
```

```js
// app
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

const me = await cero('./data', spec)
await cero.put(me.notes, { title: 'first', body: 'hello' })

const room = await cero.open(me.room, { name: 'general' })
const invite = await room.invite()
await cero.put(room.messages, { text: 'hi' })
for await (const { data } of cero.watch(room.messages)) render(data)
```

Another device, same built spec: `cero('./data', spec, { phrase })` becomes
the same user; `cero.open(me.room, { invite })` joins the handle.

## Rules

1. **Open against the built spec**, never the raw schema. Build, server and
   client all import the same generated `spec/index.js`.
2. **Register before you build or open**: `cero.use(extensions)` before
   `build()` and before `cero()` / `serve()` / `connect()`, in every process.
   `cero.define(operators)` once at startup on both sides of RPC.
3. **The schema is append-only.** Fields and refs are numbered in declaration
   order. Add at the end; never insert, remove or reorder.
4. **`put` inserts, `set` merges.** `set` reads the stored row, merges your
   fields over it, and writes, atomically. A one-field update is
   `cero.set(ref, { id, field })`. On a single, `cero.set(me.profile, { name })`.
5. **Use the facade.** `import { cero } from '@cero-base/cero'` and call
   `cero.put`, `cero.get`, `cero.open`. In a UI process,
   `import * as cero from '@cero-base/cero/client'`. Never alias named imports.
6. **Cleanup follows the handle.** `watch` streams end with their handle; pass
   `{ signal: me.signal }` to `before` / `after` / `on`; `await me.close()` on
   shutdown.
7. **Invites come from child handles.** `room.invite({ role })` admits a
   member. The root handle has no invites; a new device joins with the
   phrase. Roles are the ranks `owner`, `admin`, `member`, `reader`; map app
   roles onto them.
8. **A phrase recovers, it never creates.** `cero(dir, spec)` with no phrase
   mints an identity and you show `me.identity.toPhrase()` once. With a phrase
   and no stored writer, cero finds one of the user's devices and recovers;
   with none reachable it rejects with `TIMED_OUT` after `recoveryTimeout`.
9. **Bare has no Node globals.** Import `fs`, `path`, `crypto` plainly, no
   `node:` prefix; the package maps them to `bare-*` under Bare.

## Reading

```js
const { data, total } = await cero.get(me.notes, { pinned: true, reverse: true, limit: 20 })
cero.watch(me.notes, { pinned: true }).on('data', ({ data }) => render(data))
for await (const { changes } of cero.changes(room.messages)) apply(changes)
```

- `get(ref)` lists, `get(ref, id)` fetches one, `get(ref, { field })` filters.
  Queries: equality fields, `gt` / `gte` / `lt` / `lte` on the id, `reverse`,
  `limit`, `total`, `search` with optional `fields`. Declared indexes
  (`t.collection(fields, { indexes: { 'by-name': ['name'] } })`) serve equality
  queries natively.
- `watch(ref, query)` streams the current rows now and after every change,
  local or remote. `changes(ref, query)` streams `{ prev, next }` deltas.
- `count(ref, query)` counts.

## Split apps

```js
// backend (Node, Bare worker or worklet)
const server = await serve(ipc, spec, { storage: './data' })
// UI
import * as cero from '@cero-base/cero/client'
const me = await cero.connect(ipc, spec)
```

The process that owns the data runs `serve(ipc, spec, { storage })`; the UI
runs `connect(ipc, spec)` and gets the same operators over the wire. Electron
uses a Bare worker, Expo a Bare worklet, tests a duplex pair. Same code on
every transport. See [apps](references/apps.md).

## Where to read

| Task                                                       | Page                                   |
| ---------------------------------------------------------- | -------------------------------------- |
| First app, first device, second device                     | [quickstart](references/quickstart.md) |
| Field types, singles, collections, handles, local, indexes | [schema](references/schema.md)         |
| Operators, queries, watch, changes, hooks                  | [data](references/data.md)             |
| Invites, roles, members, devices, leaving                  | [handles](references/handles.md)       |
| The phrase, recovery, restore, peek                        | [identity](references/identity.md)     |
| serve, connect, Electron, Expo                             | [apps](references/apps.md)             |
| use, define, bind, profileSync, handleSync                 | [extensions](references/extensions.md) |
| Files next to rows                                         | [files](references/files.md)           |
| Channels, mirrors, suspend, Bluetooth, app versions        | [network](references/network.md)       |
| Every export and option                                    | [api reference](references/api.md)     |
| Every error code                                           | [errors](references/errors.md)         |
| Encryption epochs and key rotation                         | [encryption](references/encryption.md) |

## References in this skill

Every guide the table names lives in `references/`, plus [references/testing.md](references/testing.md) on how cero apps are tested. Copy the whole `skills/cero` folder; nothing points outside it.
