# API reference

Every export of Cero (`@cero-base/cero`) and its subpaths: each operator, option, builtin ref and status field.

```js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js' // written by build(), see Schema

const me = await cero('./data', spec, { name: 'laptop' })
const room = await cero.open(me.room, { name: 'general' })
await cero.put(room.messages, { text: 'hi' })
const { data } = await cero.get(room.messages, { limit: 20 })
```

## The package

| Export                                                   | What it is                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cero(dir, spec, opts)`                                  | Opens this device's data and resolves the root context, `me`.                                                                                                                                                                |
| the 24 operators                                         | `put`, `set`, `get`, `del`, `watch`, `call`, `open`, `tx`, `invite`, `revoke`, `rotate`, `accept`, `deny`, `leave`, `close`, `cancel`, `suspend`, `resume`, `activate`, `deactivate`, `phrase`, `nearby`, `before`, `after`. |
| `t`, `schema`                                            | The field types and the wrapper `build` takes.                                                                                                                                                                               |
| `restore(me, seed)`, `toSeed(phrase)`, `peek(dir, spec)` | Recovery and the first-run check.                                                                                                                                                                                            |
| `Handle`, `Ref`, `Local`                                 | The classes behind a context, a ref and `me.local`.                                                                                                                                                                          |

Everything but the classes is also a property of `cero`, so one import covers an app: write `cero.put`, never an aliased import. The subpaths are `/build`, `/server`, `/client` and `/extensions`, below.

## cero(dir, spec, opts)

Opens the data under `dir/main`, creating it on the first run, and resolves `me`. `dir` must be a non-empty string (`INVALID`); `spec` is what `build` wrote (`REQUIRED`).

| Option            | Default                                    | Meaning                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | `null`                                     | This device's name: written to its `me.devices` row on its first open, and read back as `me.device.name` for this call.                                                                                                          |
| `isMobile`        | `false`                                    | Written with the name to this device's row on its first open.                                                                                                                                                                    |
| `seed`            | none                                       | 16 or 32 bytes, `cero.toSeed(phrase)`. On a new `dir` it recovers that identity from another of its devices, and stores it.                                                                                                      |
| `words`           | `12`                                       | The phrase length of a fresh identity, `12` or `24`.                                                                                                                                                                             |
| `identity`        | none                                       | A Core `Identity` in place of `seed`. It recovers like `seed` on a new `dir`, and is not stored: pass it on every open.                                                                                                          |
| `recoveryTimeout` | `30000`                                    | How long recovery waits, in ms, to find another device of yours and be let in. Past it: `TIMEOUT`.                                                                                                                               |
| `storageKey`      | none                                       | 32 bytes that encrypt what the device keeps locally (seed, keys, pending joins, the `local` scope) at rest. Keep it in the OS keychain: Cero never stores it.                                                                    |
| `channel`         | none                                       | Only peers on the same channel meet. `dir` keeps the first channel it is opened with: another, or none, then throws `CHANNEL_MISMATCH`.                                                                                          |
| `mirrors`         | `[]`                                       | Mirror keys, strings or bytes. Rooms, files and join replies wait on them, so devices sync without being online together.                                                                                                        |
| `bootstrap`       | the public DHT                             | `[{ host, port }]` DHT nodes, for a test network.                                                                                                                                                                                |
| `backoffs`        | the swarm's                                | Reconnect backoff steps in ms.                                                                                                                                                                                                   |
| `presence`        | `{ active: 8, announced: 8, idle: 30000 }` | How many rooms search and announce, how many only announce, and the idle ms before the rest leave the swarm. The root always searches.                                                                                           |
| `bluetooth`       | `false`                                    | `true` turns the radio on for nearby sync. `{ autoStart: false }` leaves it off until `cero.nearby(me, true)`. Also `backend`, `maxOutbound`, `maxInbound`, and `pipe`: `'l2cap'` (default) or `'gatt'`, the same on both peers. |
| `extensions`      | the spec's                                 | The extensions this instance runs, in place of the ones the spec carries. See [Extensions](#extensions).                                                                                                                         |
| `onerror`         | the console                                | Where background errors go. See [Errors](errors.md).                                                                                                                                                                             |
| `key`             | none                                       | The root database's key: recover into it without looking it up on another device.                                                                                                                                                |
| `encryptionKey`   | the identity's                             | The root database's encryption key.                                                                                                                                                                                              |

## Contexts

`me` and each room are contexts: they hold state, and every act on one is an operator.

| Member        | On   | Holds                                                                                                                                                |
| ------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | both | `me`: your identity id. A room: its id. Both z32.                                                                                                    |
| `device`      | root | `{ id, name }`: this device's id in `me.devices`, and the `name` option of this `cero()` call. The stored name is on `me.devices`. `null` on a room. |
| `type`        | room | Its handle type, such as `'room'`. `null` on the root.                                                                                               |
| your refs     | both | One ref per schema entry: `me.todos`, `room.messages`. A handle ref, `me.room`, lists your rooms of that type.                                       |
| builtin refs  | both | [Below](#builtin-refs).                                                                                                                              |
| `local.<ref>` | root | The schema's `local` block: `put`, `set`, `get`, `del` and `watch`, never replicated. No hooks, actions or `tx`.                                     |

A ref is a `Ref`, `{ handle, name, kind, schema, type }`, where `kind` is `'collection'`, `'single'`, `'action'` or `'handle'`. A type ref, `me.room.messages`, names that ref in every room of the type and carries `type: 'room'`: hooks take it, reads and writes go through a room's own refs.

### For extensions

An extension's `setup(me)` also reads these, in process only. App code sticks to the operators.

| Member           | On   | Holds                                                                                                                                                           |
| ---------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`       | both | The Core `Identity`: `id`, `publicKey`, `sign`.                                                                                                                 |
| `signal`         | both | An `AbortSignal` that fires when the context closes.                                                                                                            |
| `children`       | root | The rooms open on this device, a `Set`.                                                                                                                         |
| `name`           | room | The name this device created it with. handleSync keeps it in step with the room's `profile`.                                                                    |
| `'handle'` event | root | `(room, { name })` for each room this device opens: created, joined or loaded. `name` is set only on create. The root is an event emitter: `on`, `once`, `off`. |

## Builtin refs

Every context carries these, undeclared. `t.extend` adds fields to the first six.

| Ref        | On    | Rows                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `members`  | every | `{ id, role, name, key, createdAt, updatedAt, index }`. `id` is the member's identity id.                                                                                                                                                                                                                                                                |
| `devices`  | every | `{ id, memberId, name, isMobile, createdAt, updatedAt, index }`: each member's devices.                                                                                                                                                                                                                                                                  |
| `invites`  | every | `{ id, role, expires, reuse, confirm, createdAt, index }`: live invites. `id` is the invite's public id in hex; `expires` is ms since 1970, `0` for never.                                                                                                                                                                                               |
| `requests` | every | `{ id, identity, invite, role, admitted, expires, reply, createdAt, index }`: a join until the joiner has its keys. `id` is the joiner's device, `identity` their identity key as raw bytes, `invite` the invite id in hex. `{ admitted: false }` rows wait on `cero.accept` or `cero.deny`.                                                             |
| `handles`  | every | `{ id, type, key, encryptionKey, name, createdAt, updatedAt, index }`: on the root, your rooms, which `me.room` reads by type.                                                                                                                                                                                                                           |
| `files`    | every | `{ id, name, memberId, type, size, url, index }`, and `from` on a copy of another context's file: files put into the context. `url` is served on this device.                                                                                                                                                                                            |
| `status`   | every | One row, [below](#status). Read-only.                                                                                                                                                                                                                                                                                                                    |
| `joins`    | root  | `{ id, type, invite }`: the joins this device still waits on. `id` is the room's discovery key in hex, not its `room.id`. Read-only.                                                                                                                                                                                                                     |
| `nearby`   | root  | `{ id, device, name, isMobile }`: the devices linked over Bluetooth, one row each: `id` is the person's identity (your own other devices carry yours), `device` a key that stays the same for that device. `name` is their `profile`'s, else theirs in a room you share and have open here, else `null`; `isMobile` is their device's option. Read-only. |

`status`, `joins` and `nearby` are computed on the device and never stored. A schema cannot declare `status` anywhere, nor `joins` or `nearby` at the root.

Each row of your own collections carries `id`, `memberId` (its author), `index` (insertion order), `createdAt` and `updatedAt` (ms) next to its fields. A `local` row carries `id`, `createdAt` and `updatedAt`.

### status

| Field       | Value                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `role`      | Your role here, `null` when you are not a member.                                                                        |
| `writable`  | `true` once this device can write here.                                                                                  |
| `epoch`     | The key in use, by number: `0` before the first re-key.                                                                  |
| `suspended` | `true` between `cero.suspend(me)` and `cero.resume(me)`.                                                                 |
| `behind`    | `0`, or the version of a newer app some peer writes with: this device skips those writes until it updates.               |
| `nearby`    | The radio: `'on'`, `'off'`, `'waiting'`, `'starting'`, `'unauthorized'`, `'unsupported'`, or `null` without `bluetooth`. |

## Data

| Call                                        | Resolves                                                                | Notes                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cero.put(ref, row)`                        | `{ data }`, the stored row                                              | Insert into a collection, or overwrite by `id`, keeping its `createdAt`. Stamps `id` when missing, and `createdAt` and `updatedAt` over any you pass. A single is written with `set`. |
| `cero.put(ctx.files, { data, type, name })` | `{ data }`: the file's `{ id, type, size, url }`, and `name` when given | `data` is the bytes, `type` a MIME type.                                                                                                                                              |
| `cero.set(ref, row, { upsert })`            | `{ data }`, or `null` when `{ upsert: false }` finds no row             | Merge over the stored row, keeping `createdAt`. On a collection it inserts when `id` is new or missing, unless `{ upsert: false }`.                                                   |
| `cero.get(ref)` on a single                 | `{ data }`, the row or `null`                                           |                                                                                                                                                                                       |
| `cero.get(ref, id)`                         | `{ data }`, the row or `null`                                           | On a handle ref, that room's row in your list.                                                                                                                                        |
| `cero.get(ref, query)`                      | `{ data, total, size }`                                                 | `size` rows in `data`. `total` counts every match, or is `null` when `limit` filled the page: add `total: true` to count anyway. On a handle ref, your rooms of that type.            |
| `cero.del(ref, id)`                         | `undefined`                                                             | Delete by id. `cero.del(ref)` clears a single.                                                                                                                                        |
| `cero.watch(ref, query, { signal })`        | a `Readable`                                                            | Each item is what `get` returns at that moment; `query` may be an id. [Below](#watch).                                                                                                |
| `cero.call(ref, data)`                      | `undefined`                                                             | Run an action: its `after` hooks are what it does. `INVALID` when it has none on this device.                                                                                         |

A write with a field the schema does not declare, or a row missing a `t.required` field, throws `INVALID` naming the field. Through an index, rows come back ordered by the index fields, then `id`; a range (`gt`, `gte`, `lt`, `lte`) in `id` order, reading only the page; otherwise in insertion order. `me.local` lists in `id` order.

| Query key                | Meaning                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| any field                | Equality: `{ done: false }`. An index whose fields are exactly these keys serves it. |
| `gt`, `gte`, `lt`, `lte` | Bounds on `id`.                                                                      |
| `limit`                  | At most this many rows.                                                              |
| `reverse`                | Last first.                                                                          |
| `search`                 | Every word must appear in some string field, case and accents ignored.               |
| `fields`                 | The fields `search` reads, every string field but `memberId` by default.             |
| `total`                  | `true` counts every match even when `limit` filled the page.                         |

### watch

```js
// me from cero(); render and patch are your UI's
const todos = cero.watch(me.todos, { done: false, changes: true })
for await (const { data, changes, reset } of todos) {
  if (reset) render(data)
  else patch(changes)
}
```

A slow reader gets only the newest item. With `changes: true` in the query, each item also carries `changes`, the `{ prev, next }` rows that changed since the reader's last item (`prev: null` when added, `next: null` when deleted), and `reset`, `true` on the first item, whose changes list every row. A stream ends when its context closes, or with the `signal`.

## Rooms

| Call                                          | Resolves                     | Notes                                                                                                                                                              |
| --------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cero.open(ref, { name })`                    | the room                     | Create one. `name` is optional.                                                                                                                                    |
| `cero.open(ref, { id })`                      | the room                     | Open one in your list. `UNKNOWN` when it is not there.                                                                                                             |
| `cero.open(ref, invite)`, `(ref, { invite })` | the room                     | Join. [Below](#join).                                                                                                                                              |
| `cero.invite(room, opts)`                     | the invite, a string         | [Options below](#invite-options). `INVALID` on the root.                                                                                                           |
| `cero.revoke(room, invite)`                   | `true` if it was live        | Takes the string `cero.invite` returned, not a `room.invites` row. Its waiting requests go with it. Needs remove: `DENIED`.                                        |
| `cero.accept(room, request, { role })`        | `undefined`                  | Let in a `room.requests` row. `role` is the invite's by default: above it `INVALID`, above your own `REFUSED`. `EXPIRED` past the invite's `ttl`.                  |
| `cero.deny(room, request, reason)`            | `undefined`                  | Turn it away: the joiner's `open` rejects with `DENIED` and your `reason` as `err.reason`.                                                                         |
| `cero.rotate(room)`                           | `{ epoch }`                  | Re-key: a member removed before it reads nothing written after. A removal re-keys by itself shortly after; this is the one to await. Needs remove: `REFUSED`.      |
| `cero.leave(room)`                            | `undefined`                  | Remove yourself from its members, drop it from your list on every device and close it here. `INVALID` on the root, and for the last owner of a room others are in. |
| `cero.close(ctx)`                             | `undefined`                  | Close a room, or `me` and everything under it. The data stays.                                                                                                     |
| `cero.cancel(me, invite)`                     | `true` if a join was waiting | Give up a join for good. Its waiting `open` rejects with `CLOSED`.                                                                                                 |

`accept` and `deny` need the invite permission (`REFUSED`) and throw `UNKNOWN` for a request already settled or not seen yet.

### Join

`cero.open(me.room, invite)` resolves the room once a member's device lets you in and hands over its keys. A room already in your list resolves at once.

- After 30 s it rejects with `TIMEOUT` and the join goes on: it is listed in `me.joins`, resumes after a restart, and the room joins `me.room` when you are let in. `open` again with the same invite waits on the same join; `cero.cancel(me, invite)` ends it.
- It rejects with `DENIED`, their reason in `err.reason`, when a member turned you away, `EXPIRED` when the invite is past its `ttl`, `INVALID_INVITE` when the string is not an invite, and `NETWORK_ERROR` when the join could not be sent: `open` again.
- A spent or revoked invite is never answered: the join waits until the invite expires, or until you cancel it.

### Invite options

| Option    | Default           | Meaning                                                                                                         |
| --------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `role`    | `'member'`        | `'owner'`, `'admin'`, `'member'` or `'reader'`. Above your own role: `DENIED`. Anything else: `INVALID`.        |
| `ttl`     | never expires     | In ms, or a duration: `'12h'`, `'2d'`.                                                                          |
| `reuse`   | `false`, one join | `true` lets in any number of joiners, at `'member'` or below (`INVALID` above).                                 |
| `confirm` | `false`           | `true` holds each join in `room.requests` until a member accepts or denies it.                                  |
| `data`    | `null`            | A `Uint8Array` the joiner reads before joining, with `Invite.parse(invite).data` from `@cero-base/core/invite`. |

### Roles

| Role     | May                                      |
| -------- | ---------------------------------------- |
| `owner`  | everything; whoever created the room     |
| `admin`  | write, invite, remove members, set roles |
| `member` | write, invite                            |
| `reader` | read                                     |

Set a role with `cero.set(room.members, { id, role })`: you need to be an admin or owner, outrank the member's current role, and not grant above your own (`REFUSED` otherwise). Remove a member with `cero.del(room.members, id)`: admin or owner, and outrank them. Anyone may remove themselves, except the last owner of a room others are in (`INVALID`). `cero.del(room.devices, id)` removes a device the same way. A member set to reader stops writing at once, and writes again once set back.

## App and device

| Call                    | Resolves    | Notes                                                                                                                                                                                                                                                |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cero.suspend(me)`      | `undefined` | The app goes to the background: network, storage and radio pause, and every `status.suspended` reads `true`. `INVALID` on a room.                                                                                                                    |
| `cero.resume(me)`       | `undefined` | The app is back. `INVALID` on a room.                                                                                                                                                                                                                |
| `cero.activate(room)`   | `undefined` | The room is in use: it ranks first on the swarm, searching and announcing.                                                                                                                                                                           |
| `cero.deactivate(room)` | `undefined` | Take the room off the swarm until something lands in it.                                                                                                                                                                                             |
| `cero.phrase(me)`       | the phrase  | The recovery phrase, 12 or 24 words.                                                                                                                                                                                                                 |
| `cero.nearby(me, mode)` | `undefined` | The radio: `true` joins the nearby mesh, `false` turns it off, an invite string holds that invite's meeting point until the next call or the invite expires, so a joiner in range finds this device with no internet. `INVALID` without `bluetooth`. |

## tx

```js
// room from cero.open, with a messages collection
const before = await cero.tx(room, async (tx) => {
  await cero.put(tx.messages, { text: 'one' })
  await cero.put(tx.messages, { text: 'two' })
  const { data } = await cero.get(tx.messages)
  return data.length // the room before the batch: neither new message yet
})
```

- `cero.tx(ctx, fn)` resolves what `fn` returns. Writes through `tx`, the context `fn` receives, land as one batch, or none do when one is refused. A write through `room` itself lands on its own, outside the batch.
- `fn` must take `tx` (`INVALID` otherwise). Reads through `tx` see what has landed, not the batch's own writes.
- Atomic, not isolated: other writes, from this device or another, can land between `fn`'s reads and the commit.
- `cero.rotate` cannot run inside (`INVALID`). Not on a client.

## Hooks

```js
// extensions.js, for the room type in Schema types below
import { cero, profileSync, handleSync } from '@cero-base/cero/extensions'

const rules = {
  setup(me) {
    cero.before(me.room.messages, ({ op, row }) => {
      if (op !== 'del' && !row.text) return false // refused on every peer
    })
    cero.after(me.room.react, ({ row, put }) =>
      put('reactions', { messageId: row.messageId, emoji: row.emoji })
    )
  }
}

export const extensions = [profileSync(), handleSync(), rules]
```

A hook runs where the data lives: at apply, on every peer, inside the op's transaction. Register hooks in an extension's `setup` on a type ref, as above, so every device and worker runs the same rules on every room of the type before any op applies. A hook added later sees only the ops applied after it.

| Call                               | Returns   | Notes                                                                                                                                     |
| ---------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cero.before(ref, fn, { signal })` | a remover | Runs before a write or action lands. Return `false` to refuse it; change `ctx.row` to change what lands.                                  |
| `cero.after(ref, fn, { signal })`  | a remover | Runs after it lands, in the same transaction: derive rows with `ctx.put`, `ctx.set`, `ctx.del`. On an action, it is what the action does. |

| `ctx`                      | Holds                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `op`                       | `'put'`, `'set'`, `'del'`, or the action's name. `cero.set` on a collection is an upsert and applies as `'put'`, unless `{ upsert: false }`.                                                       |
| `name`                     | The ref's name.                                                                                                                                                                                    |
| `row`                      | The row being written, merged with the stored one on a `'set'`; `null` on a `'del'`; an action's data.                                                                                             |
| `existing`                 | The stored row, or `null`.                                                                                                                                                                         |
| `id`                       | The row's id, on a collection.                                                                                                                                                                     |
| `memberId`, `role`         | Who writes. `null` on a builtin until the writer is a member: a join, a claim, a room's first write.                                                                                               |
| `get`, `put`, `set`, `del` | The operators on the room as it stands at this op, in its transaction. They take a ref name or a ref, and write as the op's writer: its rank and `own` rules apply, and rows carry its `memberId`. |

- A `false` from `before`, or a throw from either, refuses the op on every peer: the writer's call rejects with `REFUSED` (`err.rule` is `'hook'`, in process) and its whole batch is dropped.
- A ctx write the writer may not make refuses the whole op, like a throw.
- Hooks fire on the builtin refs too: a join is a `'put'` on `members`, `devices` and `requests`, a role change a `'set'` on `members`, a removal a `'del'`. A hook that writes on every join checks `ctx.role` first, or it refuses the joins of readers.
- A hook is deterministic: it reads `ctx` only, never a clock, random numbers or device state. The imported operators throw `INVALID` inside it: use the ones on `ctx`.
- Not on a client: hooks take functions, so they run in the worker.

## Recovery

```js
// spec from build(); phrase: typed on the first-run screen, or null for a new identity
const known = await cero.peek('./data', spec) // before cero() opens the dir
const seed = !known && phrase ? cero.toSeed(phrase) : undefined
const me = await cero('./data', spec, { seed })
```

| Call                     | Resolves                            | Notes                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cero.toSeed(phrase)`    | the seed, a `Uint8Array`            | Not a promise. `INVALID` for a phrase that is not BIP-39.                                                                                                                                                                                                                                                                             |
| `cero.restore(me, seed)` | the new `me`                        | The same identity: `me`, unchanged. Otherwise it closes `me`, deletes `dir/main` (every room, key and local row on this device), then opens with the seed and the other options and recovers from a device of that identity. None reachable within `recoveryTimeout`: `TIMEOUT`, and the old data is gone. `REQUIRED` without a seed. |
| `cero.peek(dir, spec)`   | `true` when `dir` holds an identity | For a launcher choosing between a first-run screen and a normal boot. Call it before `cero()` opens `dir`. An `identity` option is not stored, so `peek` does not see it.                                                                                                                                                             |

## Extensions

An extension is `{ name, schema, setup }`, and a bare function is `{ setup }`. `schema` adds refs, or `t.extend` on a builtin, nested by handle type like the app schema; the app's own entries win. `setup(me)` runs before the root opens, and an operator it calls waits for the open, so it may write. It may return a function to run on close.

| Where the list goes                                      | What runs                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build(dir, schema, { extensions: '../extensions.js' })` | A module path, relative to `dir`, exporting `extensions`. The schema folds in and the spec imports the module, so every process runs the same list. |
| `build(dir, schema, { extensions: [list] })`             | Folds the schema and records the list's names. Pass the same list to `cero(dir, spec, { extensions })`: without one, `cero()` throws `INVALID`.     |
| `build(dir, schema, { extensions: [] })`                 | None, at build and at open.                                                                                                                         |
| neither                                                  | profileSync and handleSync.                                                                                                                         |

## @cero-base/cero/build

```js
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js' // your cero.schema({ ... })

await build('./spec', schema, { extensions: '../extensions.js' })
```

`build(specDir, schema, { ns, extensions })` compiles a schema into `specDir` and writes an `index.js` there exporting `spec` and `meta`. `schema` is a `cero.schema(...)` or its plain object; `ns` prefixes the schema ids, `'cero'` by default. It throws `INVALID` on a builtin name (`status` anywhere, `joins` or `nearby` at the root), on `t.extend` of anything but a builtin, and on a redeclared base field. Run it again after every schema change.

## @cero-base/cero/server

```js
import { serve } from '@cero-base/cero/server'

// ipc: the worker's end of the pipe to the UI; spec from build()
const server = await serve(ipc, spec, { storage: './data', name: 'laptop' })
```

`serve(ipc, spec, opts)` resolves a ready `Server` that bridges a framed duplex to a Cero instance. `opts.storage` is the data dir (`REQUIRED`); every other option goes to `cero()`. It opens the root at once, and a client's connect waits for it. The worker's `onerror` gets background errors only while no client is connected; otherwise each client gets them. `Server` is exported too.

## @cero-base/cero/client

```js
import { cero } from '@cero-base/cero/client'

// ipc: the UI's end of the pipe to the worker; spec from build()
const me = await cero(ipc, spec, { onerror: (err) => console.error(err.code) })
```

`cero(ipc, spec, { onerror })`, also `cero.connect`, resolves a client root with the same refs as `me`, so app code runs on either side. The facade carries every operator but `before`, `after` and `tx`, plus `t`, `schema`, `connect` and `restore(me, phrase)`, which takes the phrase: the worker turns it into the seed. The operators are named exports too, with `Client`.

- A client root has `id`, `device`, its refs and `local`. A room has `id`, `type`, `name` and its refs.
- `before`, `after`, `tx`, `peek` and `toSeed` stay in the worker. `status`, `joins`, `nearby`, `requests` and `cero.phrase(me)` read as in process.
- An error crosses with its `code` and `message`, and a denied join with its `reason`: match `err.code`, `err.rule` stays in the worker. The worker's background errors reach `onerror` with `code`, `message`, `stack` and `reason`.
- Opening or joining a room from inside a room is `UNSUPPORTED`.

## @cero-base/cero/extensions

```js
import { cero, profileSync, handleSync } from '@cero-base/cero/extensions'
```

A light `cero` facade, `t`, `schema` and the 24 operators without the runtime, for an extension module or your own functions over the operators: the spec bundles them into the UI. The operators are named exports too, with `bundled`, the default two, and `extensionsOf(spec, list)`, the list a spec runs.

| Extension                 | Declares                                                                  | Does                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `profileSync({ fields })` | a root `profile` single, `{ name, ...fields }`, and `fields` on `members` | Mirrors your `profile` onto your member row in every room you open.                                                                                                                  |
| `handleSync({ fields })`  | `fields` on `handles`                                                     | Mirrors a room's own `profile` onto its row in `me.handles`, and writes a new room's name into it. The room type must declare its own `profile` single with `name` and the `fields`. |

`fields` defaults to `{ avatar: t.string }` in both. A `t.file` field is copied with its file into the room or `handles` row it lands on, and resolves there: `profileSync({ fields: { avatar: t.file } })`.

## Schema types

```js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  profile: t.single({ name: t.required(t.string), avatar: t.string }),
  todos: t.collection({ text: t.string, done: t.bool }, { indexes: { 'by-done': ['done'] } }),
  members: t.extend({ alias: t.string }),
  room: {
    profile: t.single({ name: t.string, avatar: t.string }),
    messages: t.collection({ text: t.string, image: t.file }, { own: true }),
    reactions: t.collection({ messageId: t.string, emoji: t.string }),
    react: t.action({ messageId: t.string, emoji: t.string })
  },
  local: { drafts: t.collection({ text: t.string }) }
})
```

| Declaration                  | Meaning                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t.string`, `t.bool`         | String, boolean.                                                                                                                                                                                  |
| `t.uint`, `t.int`            | Unsigned and signed integers.                                                                                                                                                                     |
| `t.bytes`                    | Bytes.                                                                                                                                                                                            |
| `t.json`                     | Any JSON value.                                                                                                                                                                                   |
| `t.fixed32`, `t.fixed64`     | Fixed-width bytes, for keys and hashes.                                                                                                                                                           |
| `t.file`                     | A file id from `cero.put(ctx.files, …)`. Reads resolve to `{ id, type, size, url }`.                                                                                                              |
| `t.required(type)`           | A required field: a row without it throws `INVALID`. Fields are optional by default.                                                                                                              |
| `t.single(fields)`           | One record, written with `set` and read without an id.                                                                                                                                            |
| `t.collection(fields, opts)` | Rows by `id`. `indexes` names field lists to query by. `own: true`: anyone who writes adds rows, only a row's author changes or deletes it, and admins and owners moderate (`REFUSED` otherwise). |
| `t.action(fields)`           | A write that stores no row: its `after` hooks are what it does.                                                                                                                                   |
| `t.extend(fields)`           | Extra fields on a builtin: `members`, `devices`, `invites`, `requests`, `handles`, `files`. Redeclaring a base field throws.                                                                      |
| `schema(defs)`               | Wraps the definitions for `build`.                                                                                                                                                                |

A plain object is a handle type: `room` above gives `me.room`. Handle types nest one level. The `local` block is device-only.

## Next

- [Errors](errors.md): every code these calls throw, and what to do.
- [Data](data.md): the operators at work.
- Core primitives: the layer underneath.
