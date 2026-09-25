# Data

[Docs](README.md) · Previous: [Schema](schema.md) · Next: [Sharing](handles.md)

Write, query and watch rows, react to every write with a rule, batch writes and attach files.

```js
import { cero } from '@cero-base/cero'

// me from cero('./data', spec), with the schema from the Schema page
const { data: todo } = await cero.put(me.todos, { text: 'buy milk' })
await cero.set(me.todos, { id: todo.id, done: true })
const { data: open } = await cero.get(me.todos, { done: false })
await cero.del(me.todos, todo.id)
```

The data operators take a ref first: `me.todos` on the root, `room.messages` in a room. The same
calls work in the worker and over RPC.

## Add a row

```js
const { data: row } = await cero.put(me.todos, { text: 'call mum' })
// row: { id, text, createdAt, updatedAt }
await cero.put(me.todos, { id: 'weekly', text: 'water the plants' }) // your own id
```

`memberId` and `index` appear when you read the row back. A `put` over an existing id replaces the
whole row: fields you leave out are cleared. A field the schema does not declare throws `INVALID`,
except in `me.local` and through a hook's ctx, where it is dropped.

## Change a row

```js
await cero.set(me.todos, { id: row.id, done: true }) // row from the block above
await cero.set(me.profile, { name: 'Ana' })
const none = await cero.set(me.todos, { id: 'nope', done: true }, { upsert: false }) // null
```

`set` reads the row on this device, lays your fields over it, keeps `createdAt` and writes the
whole row. When two devices set the same row at once, the write that ends up last wins every
field, not only the ones it changed. Without an id on a collection, `set` adds a row like `put`.
With `{ upsert: false }` it only changes a row that exists, and resolves `null` when there is
none; over RPC, `{ data: undefined }`.

## Read rows

```js
const { data: profile } = await cero.get(me.profile) // the record, or null
const { data: one } = await cero.get(me.todos, row.id) // the row, or null
const { data, total, size } = await cero.get(me.todos) // a list
```

A list comes back in the order rows were added. Through an index, it comes back ordered by the
index fields, then id, and `me.local` lists in id order.

## Filter, search and page

```js
await cero.get(me.todos, { done: false, limit: 20 })
await cero.get(me.todos, { reverse: true, limit: 20 }) // the newest 20
await cero.get(me.todos, { search: 'milk', fields: ['text'] })
```

Any key not in this table is an equality filter on that field.

| Key                      | Does                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `limit`                  | At most this many rows.                                                                      |
| `reverse`                | The other way round: newest first on a plain list.                                           |
| `total`                  | `true` counts every match even when `limit` filled the page.                                 |
| `search`                 | Case and accent insensitive; every word must appear in a string field other than `memberId`. |
| `fields`                 | The string fields `search` looks at.                                                         |
| `gt`, `gte`, `lt`, `lte` | Bounds on `id`, compared as strings.                                                         |

`total` is how many rows matched and `size` how many came back. When `limit` filled the page,
`total` can be `null`; ask with `total: true` to count. There is no sort and no range on fields
other than `id`: read the rows and sort them in memory. Generated ids are random, so `gt` and `lt`
are not a cursor: for more rows, raise `limit`. Over RPC, `limit: 0` is dropped and every row
comes back.

## Delete a row

```js
await cero.del(me.todos, row.id)
await cero.del(me.profile) // wipes the single
```

## Follow changes

```js
const ac = new AbortController()
cero.watch(me.todos, { done: false }, { signal: ac.signal }).on('data', ({ data }) => {
  console.log(data.length, 'open')
})
```

The stream sends the result at once and after every change, local or remote; a slow reader
gets only the newest. It ends when the signal aborts or the handle closes, and a
`for await` loop then throws an error with the code `STREAM_DESTROYED`, so `break` out to stop.

```js
for await (const { data } of cero.watch(me.todos, { id: row.id })) {
  if (data[0]?.done) break // one row followed: data holds it, or nothing once deleted
}
```

`changes: true` in the query adds `changes`, the `{ prev, next }` rows that changed since the item
before, and `reset`, true on the first item, whose changes list every row with `prev: null`. A
slow reader gets fewer items, never fewer changes, and a row that leaves the query shows up with
`next: null`.

```js
for await (const { changes } of cero.watch(me.todos, { changes: true })) {
  for (const { prev, next } of changes) console.log(prev ? (next ? 'changed' : 'gone') : 'new')
}
```

## React to writes

A hook is a rule every device runs on each write to a ref, inside that write: `before` decides
what lands, `after` writes what follows from it.

```js
// rules.js, a bare-function extension: see Extensions
import { cero } from '@cero-base/cero/extensions'

// room: { messages: t.collection({ text: t.string }), seen: t.collection({ at: t.int }) }
export const rules = (me) => {
  cero.before(me.room.messages, ({ op, row }) => {
    if (op === 'del') return // row is null on a delete
    if (!row.text?.trim()) return false // refused, on every device
    row.text = row.text.trim() // what every device stores
  })
  cero.after(me.room.messages, ({ op, row, memberId, put }) => {
    if (op !== 'del') return put(me.room.seen, { id: memberId, at: row.updatedAt })
  })
}
```

When `before` returns `false` or either hook throws, no device stores the write and the writer's
call rejects with `REFUSED`. Register hooks in an extension's `setup`, on type refs like
`me.room.messages`: every room of the type has them before it opens, so every device runs the same
rules on every write ([Extensions](extensions.md)). Both return a function that removes the hook
and take `{ signal }` as a third argument. Hooks never fire on the builtins.

| ctx                        | Is                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `op`                       | `put`, `set` or `del`; on a collection `cero.set` arrives as `put`, or as `set` with `{ upsert: false }`; on an action, its name |
| `name`                     | the ref's name                                                                                                                   |
| `row`                      | the incoming row, `null` on a `del`                                                                                              |
| `existing`                 | the stored row, or `null`                                                                                                        |
| `id`                       | the row's id                                                                                                                     |
| `memberId`, `role`         | who wrote it, as `owner`, `admin` or `member`                                                                                    |
| `get`, `put`, `set`, `del` | read and write inside this write                                                                                                 |

The `cero.` operators throw inside a hook: use the ones on ctx. `ctx.put` mints the same id on
every device, `ctx.set` needs an id on a collection, and `ctx.get` returns `t.file` fields as bare
ids. Writes through ctx skip the role and `own` checks, so check `ctx.role` before a privileged
one. A hook reads only ctx, never a clock, random numbers or local state, or devices store
different rows; the writing device runs it twice, to check the write and to store it.

## Batch writes

```js
await cero.tx(me, async (tx) => {
  await cero.put(tx.todos, { text: 'a' })
  await cero.put(tx.todos, { text: 'b' })
})
```

Writes through `tx` land together or not at all. The function must take `tx` and write only
through it: a `set` through `me` inside it waits for the batch to end, and hangs. Reads through
`tx` see the data as it stood before the batch, so two `set`s on one row both merge over the old
row, and the second wins. `cero.tx` runs in the worker only, not over RPC.

## Files

```js
const { data: file } = await cero.put(me.files, {
  data: Buffer.from('hello'),
  type: 'text/plain',
  name: 'hello.txt'
})
// file: { id, name, type, size, url }
```

The root and every room have a `files` builtin. `data` is bytes, or a Readable in the worker
process; `type` is required, `name` optional. To put a file on a row, store its id in a `t.file`
field, which reads back as `{ id, type, size, url }`:

```js
// room from cero.open(me.room), bytes a Buffer of the photo
// messages: t.collection({ text: t.string, photo: t.file })
const { data: photo } = await cero.put(room.files, { data: bytes, type: 'image/jpeg' })
await cero.put(room.messages, { text: 'look', photo: photo.id })
const { data: messages } = await cero.get(room.messages) // messages[0].photo.url
```

- A `url` works on this device, for this run: it changes on every start. Store the id and read
  the row again for a fresh url.
- A `t.file` field resolves only for a file in the same room's `files`, or the root's for a root
  row. A string that is not a file id makes every read of that row throw `INVALID`.
- Files have no timestamps, they read `0`: order them by `index`.
- `cero.del(me.files, id)` removes the row, not the bytes. Files are `own`: only the uploader, an
  admin or an owner deletes one.
- A member removed from a room can't read files added after the room re-keys. See
  [How it works](how-it-works.md).

## Handle errors

```js
try {
  await cero.put(me.todos, { text: 'buy bread' })
} catch (err) {
  if (err.code !== 'NOT_WRITABLE' && err.code !== 'REFUSED') throw err
  console.log('you cannot write here')
}
```

| Code           | When                                                                    | Do                                                                                   |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `NOT_WRITABLE` | This device may not write here: not admitted yet, removed, or a reader. | Show the room read-only; `room.status` has `writable`.                               |
| `REFUSED`      | Your role, `own`, or a `before` hook said no.                           | Say the write is not allowed. `err.message` starts with the code: don't show it raw. |
| `INVALID`      | An unknown field or a bad value.                                        | Fix the call.                                                                        |
| `UNKNOWN`      | `cero.open(ref, { id })` with an id not in your list.                   | Read the list again.                                                                 |

[Errors](errors.md) lists every code.

## Next

- [Sharing](handles.md) to put these rows in a room other people see.
- [Extensions](extensions.md) to register hooks and reuse your own functions.
- [API reference](api.md) for every signature and option.
