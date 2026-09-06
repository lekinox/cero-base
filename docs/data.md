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
- [del and count](#del-and-count)
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

## del and count

```js
await cero.del(me.todos, id) // one row
await cero.del(me.profile) // wipe the single
const { data: open } = await cero.count(me.todos, { done: false })
```

`count` takes the same query as `get`.

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

```js
cero.before(
  me.todos,
  (ctx) => {
    if (!ctx.row.text.trim()) return false // cancel the write
    ctx.row.text = ctx.row.text.trim() // or change it
  },
  { signal: me.signal }
)

cero.after(me.todos, ({ op, row }) => audit(op, row), { signal: me.signal })
```

`before` runs in the write path and is awaited. Return `false` to cancel, or mutate `ctx.row`. `after` runs once the write is in the log and never blocks it. Both receive `{ op, name, row }`, where `op` is `put`, `set` or `del`. Both return an unsubscribe function, and `{ signal }` unsubscribes on abort.

Hooks fire only on the device doing the write. They are not available over RPC.

## Store events

```js
room.store.on('writable', () => {}) // this device may write
room.store.on('unwritable', () => {}) // access ended, you were removed
room.store.on('update', () => {}) // a batch of ops applied
```

To see every applied op, local and replicated, use `room.store.onApply(fn)`. It returns an unsubscribe function and runs inside apply, so keep it cheap.

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
