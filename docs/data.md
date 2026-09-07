# Data

[Docs](README.md) · Previous: [Schema](schema.md) · Next: [Handles](handles.md)

```js
const { data: todo } = await cero.put(me.todos, { text: 'buy milk' })
await cero.set(me.todos, { id: todo.id, done: true })
const { data: todos } = await cero.get(me.todos, { done: false })
await cero.del(me.todos, todo.id)
```

Every operator takes a ref first. `me.todos` is a ref on the root handle, `room.messages` a ref on a child handle. The same calls work on both, and over RPC.

## On this page

- [put](#put)
- [set](#set)
- [get](#get)
- [Queries](#queries)
- [del](#del)
- [watch](#watch)
- [changes](#changes)
- [Hooks](#hooks)
- [Store events](#store-events)
- [Batching writes in process](#batching-writes-in-process)
- [Errors you will hit](#errors-you-will-hit)

## put

```js
const { data } = await cero.put(me.todos, { text: 'buy milk' })
data // { id, text, createdAt, updatedAt, memberId, index }
```

`put` inserts a row. Give it an `id` to choose the id yourself, otherwise cero generates one. `createdAt` and `updatedAt` are stamped on the way in, `memberId` and `index` when the op applies. A `put` with an id that already exists overwrites that row.

On `files`, `put` uploads bytes instead. See [Files](files.md).

## set

```js
await cero.set(me.todos, { id, done: true })
await cero.set(me.profile, { name: 'jb' })
```

`set` merges. It reads the stored row, lays your fields over it, keeps `createdAt` and stamps `updatedAt`, then writes. A one-field change is one `set`. Two concurrent sets on the same row keep each other's fields, the read and the write run as one step.

Without an id on a collection, `set` inserts like `put`. With `{ upsert: false }` it only updates a row that exists and returns `null` otherwise. On a single there is no id, `set` merges over the one record.

Every field you write must be declared in the schema. An unknown field throws `INVALID` instead of being dropped by the encoder.

## get

```js
const { data: profile } = await cero.get(me.profile) // single: the record or null
const { data: one } = await cero.get(me.todos, id) // by id: the row or null
const { data, total, size } = await cero.get(me.todos) // list
```

A list comes back in insertion order. `total` is how many rows matched before `limit`, `size` how many came back. On a handle ref, `cero.get(me.room)` lists your child handles of that type.

## Queries

Any key that is not reserved is an equality filter on that field. The reserved keys are:

| Key                      | Meaning                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `gt`, `gte`, `lt`, `lte` | Bounds on `id`.                                                     |
| `reverse`                | Newest first.                                                       |
| `limit`                  | At most this many rows.                                             |
| `total`                  | `true` counts the whole match even when `limit` filled the page.    |
| `search`                 | Case and accent insensitive substring match, every word must match. |
| `fields`                 | Which string fields `search` looks at. Default: all of them.        |

```js
await cero.get(me.todos, { done: false })
await cero.get(me.todos, { done: false, reverse: true, limit: 20 })
await cero.get(me.todos, { search: 'milk', fields: ['text'] })
await cero.get(me.todos, { gt: lastId, limit: 50 }) // cursor pagination on id
```

An equality query on an indexed field reads through the index. Declare one with `t.collection(fields, { indexes: { 'by-done': ['done'] } })`. `reverse` and `limit` are served by the store when nothing else narrows the read, so a page of the newest rows touches `limit` rows, not the whole collection.

## del

```js
await cero.del(me.todos, id) // one row
await cero.del(me.profile) // wipe the single
```

To count, read `total`: `(await cero.get(me.todos, { done: false })).total`.

## watch

```js
const stream = cero.watch(me.todos, { done: false })
stream.on('data', ({ data, total, size }) => render(data))
```

Or as a loop:

```js
for await (const { data } of cero.watch(me.todos)) render(data)
```

The stream sends the current result now and again after every change, local or from a peer. Under a slow consumer it keeps only the newest snapshot. The stream ends with its handle. Pass `{ signal }` for a shorter life, or call `stream.destroy()`.

`cero.watch(me.room)` streams your list of child handles the same way.

## changes

```js
for await (const { changes, reset } of cero.changes(room.messages)) {
  for (const { prev, next } of changes) {
    if (next === null) removed(prev)
    else if (prev === null) added(next)
    else updated(next)
  }
}
```

`changes` streams deltas instead of snapshots: batches of `{ prev, next }` pairs, nothing dropped. The first batch carries the current rows as inserts with `reset: true`, and so does any batch after the view moved to another core. Replaying every batch into a `Map` keyed by id always rebuilds the current state. `limit` and `reverse` do not apply. A removed member shows up here as a delete on `room.members`.

## Hooks

A hook is a rule, not a listener. It runs when the op applies — on every peer, inside the op's transaction.

```js
cero.before(room.messages, ({ row }) => {
  if (!row.text.trim()) return false // refuse the write, everywhere
  row.text = row.text.trim() // or change what lands
})

cero.before(room.messages, async ({ memberId, get }) => {
  if ((await get(room.banned, memberId)).data) return false
})

cero.after(room.banned, ({ row, memberId, put }) =>
  put(room.audit, { kind: 'ban', by: memberId, target: row.id })
)
```

`before` decides. Return `false` and the op is refused: the writer's own call rejects with `REFUSED` and no peer stores the row. Mutating `row` rewrites what lands — the call still returns the row it submitted, the hook decides what everyone keeps.

`after` derives. Write the rows that follow from this one and they commit in the same transaction. A hook that throws refuses the op too: a rule that errors must not leave one peer with a row its neighbour rejected.

Both receive the same ctx:

| Field                      | Is                                                       |
| -------------------------- | -------------------------------------------------------- |
| `op`                       | `put`, `set` or `del`, as it applies                     |
| `name`                     | The ref the op is on                                     |
| `row`                      | The incoming row, mutable in `before`, `null` on a `del` |
| `existing`                 | The stored row this op replaces, or `null`               |
| `id`                       | The row id                                               |
| `memberId`, `role`         | Who signed the op, and what they may do                  |
| `get`, `put`, `set`, `del` | The operators, on the room as it stands at this op       |

The operators on the ctx are the ones you already use — `get(room.banned, id)`, `put(room.audit, row)` — reading and writing inside the transaction. The imported `cero.put` and `cero.get` throw inside a hook; go through the ctx.

An upsert on a collection applies as an add, so `cero.set(me.todos, { id, done: true })` reaches a hook as a `put`. `op` is always the op as it applies.

Three rules follow from running on every peer:

- **Be deterministic.** Read `ctx` and nothing else. No clock, no random, no local state — two peers that disagree store different rows.
- **Register before the data moves.** Hooks live in the process that owns the data, set up in `cero.use` or right after `cero()`, before any op applies. A peer that registers late has already applied ops without the rule. They are not available over RPC.
- **Expect to run twice on the writer.** The writing device runs its hooks once to check the op, then again when it applies. Pure hooks do not notice.

`before` and `after` return an unsubscribe function, and `{ signal }` unsubscribes on abort. To watch writes locally instead of ruling on them, use [`changes`](#changes).

## Store events

```js
room.store.on('writable', () => {}) // this device may write
room.store.on('unwritable', () => {}) // access ended, you were removed
room.store.on('update', (touched) => {}) // a batch applied; touched = the refs it changed
```

To see every applied op, local and replicated, listen for `apply` on the store: `room.store.on('apply', ({ op, name, row }) => ...)`. It fires inside apply, so keep it cheap.

## Batching writes in process

```js
await me.store.tx(async (tx) => {
  await tx.put('todos', { text: 'a' })
  await tx.put('todos', { text: 'b' })
})
```

The two writes land as one atomic batch, both or neither. `tx` is on the underlying database and only in process, it does not cross RPC.

## Errors you will hit

```js
try {
  await cero.put(me.todos, { nope: 1 })
} catch (err) {
  if (err.code === 'INVALID') showFieldError(err.message)
  else throw err
}
```

| Code           | When                                                                |
| -------------- | ------------------------------------------------------------------- |
| `INVALID`      | A field is not in the schema, or an argument has the wrong shape.   |
| `UNKNOWN`      | The ref name is not in the built spec.                              |
| `NOT_WRITABLE` | This device is not admitted as a writer, yet or any more.           |
| `REFUSED`      | Your role may not do this: a reader writing, editing someone's row. |
| `CLOSED`       | The handle was closed under the call.                               |

Match on `err.code`. [Errors](errors.md) lists every code.

## Next

- [Handles](handles.md) to share a collection with other people.
- [Files](files.md) for bytes next to rows.
- [API reference](api.md) for every signature on one page.
