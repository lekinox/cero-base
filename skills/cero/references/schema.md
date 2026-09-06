# Schema

## On this page

- [Field types](#field-types)
- [Top-level shapes](#top-level-shapes)
- [Collections](#collections)
- [Indexes and ordering](#indexes-and-ordering)
- [Actions](#actions)
- [Child handles](#child-handles)
- [The local scope](#the-local-scope)
- [Builtins and t.extend](#builtins-and-textend)
- [Add, never reorder](#add-never-reorder)
- [build(specDir, schema, opts)](#buildspecdir-schema-opts)

Describe. Build once. Done.

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  profile: t.single({ name: t.string }),
  todos: t.collection({ text: t.string, done: t.bool }),
  room: { messages: t.collection({ text: t.string }) }
})
```

One row: `t.single`. Many rows: `t.collection`. A place to share: a nested object. `cero.schema(defs)` only wraps the object so the builder recognises it, so mistakes surface at build time.

## Field types

`t` carries one marker per primitive. A marker is a plain value you can reuse across fields.

| Marker      | Column type in the built spec          |
| ----------- | -------------------------------------- |
| `t.string`  | `string`                               |
| `t.uint`    | `uint`                                 |
| `t.int`     | `int`                                  |
| `t.bool`    | `bool`                                 |
| `t.bytes`   | `buffer`                               |
| `t.json`    | `json`, any JSON round-trippable value |
| `t.fixed32` | `fixed32`                              |
| `t.fixed64` | `fixed64`                              |
| `t.file`    | `string`, holding a durable file id    |

A `t.file` field stores the id you get from uploading through the `files` builtin, and reads resolve it back to `{ id, name?, type, size, url }`. See [Files](files.md).

Fields are optional. `t.required(marker)` returns a copy with `required: true`, it does not mutate the shared marker.

```js
t.collection({ title: t.required(t.string), body: t.string })
```

## Top-level shapes

```js
export const schema = cero.schema({
  profile: t.single({ name: t.string }), // one record
  todos: t.collection({ text: t.string }), // many rows
  archive: t.action({ before: t.int }), // an op, no row
  members: t.extend({ alias: t.string }), // more fields on a builtin
  room: { messages: t.collection({ text: t.string }) }, // a child handle type
  local: { drafts: t.collection({ text: t.string }) } // device only
})
```

Each key of a schema is one of five things.

| Declaration                   | Result                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `t.single(fields)`            | One record, no id. `get`, `set` and `del` act on the whole record.             |
| `t.collection(fields, opts?)` | Many rows keyed by `id`.                                                       |
| `t.action(fields)`            | An op that travels through the log but persists no row.                        |
| `t.extend(fields)`            | Extra fields merged onto a builtin type.                                       |
| a plain object                | A child handle type: its own scope, opened with `cero.open`, shared by invite. |

The key `local` is reserved for device-only data.

## Collections

```js
todos: t.collection(
  { text: t.string, done: t.bool },
  { indexes: { 'by-done': ['done'] }, own: true }
)
```

Every row carries these fields ahead of the ones you declare.

| Field       | Type     | Written by                                         |
| ----------- | -------- | -------------------------------------------------- |
| `id`        | `string` | `put`, from your row or a generated 16-byte z32 id |
| `memberId`  | `string` | apply time, from the signing device's member       |
| `index`     | `uint`   | apply time, a monotonic counter per collection     |
| `createdAt` | `int`    | the write path, in milliseconds                    |
| `updatedAt` | `int`    | the write path, in milliseconds                    |

`t.collection(fields, opts)` takes two options.

| Option    | Type                       | Default | Meaning                                                                                 |
| --------- | -------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `indexes` | `Record<string, string[]>` | none    | Secondary indexes, name to field list.                                                  |
| `own`     | `boolean`                  | `false` | A row belongs to whoever wrote it. Only they may change or delete it, moderators aside. |

Without `own`, any writer may edit any row in the collection.

## Indexes and ordering

```js
t.collection({ name: t.string }, { indexes: { 'by-name': ['name'] } })
```

The index is used when a query's equality keys match its fields exactly, so `cero.get(ref, { name: 'jb' })` reads through it. Ranges, `reverse`, `limit` and `search` apply afterwards, so an index is an optimisation and never changes results. Every main-scope collection also gets an implicit index on `index`, which lets `reverse` and `limit` push down instead of scanning. Local collections do not get it.

## Actions

`t.action(fields)` declares an op with no row behind it. `cero.call` appends it, and the route you registered runs on every peer as the op applies.

```js
const team = await cero.open(me.team, {
  routes: {
    promote: async (op, ctx) => {
      await ctx.view.insert('@cero/members', { id: op.memberId, role: op.role })
    }
  }
})

await cero.call(team.promote, { memberId, role: 'admin' })
```

The route takes `(op, ctx)`, where `ctx` is `{ view, host, key, dbKey, dryRun }`. It also runs against a throwaway transaction before the op is appended, so keep its effects inside `ctx.view`. Calling a declared action with no route throws `INVALID`.

## Child handles

A plain nested object declares a child handle type. It compiles like a main scope of its own, and the parent gets a ref you open. A child handle carries the same builtins as the root, so it has its own members, devices, invites and files. The examples name theirs `room`.

```js
const team = await cero.open(me.team, { name: 'engineering' })
await cero.put(team.messages, { text: 'hi team' })
```

See [Handles](handles.md).

## The local scope

Everything under `local` stays on this device and never replicates. Declare it as `local: { drafts: t.collection({ text: t.string }) }` and reach it through `me.local`:

```js
await cero.put(me.local.drafts, { text: 'draft' })
```

cero keeps its own device rows in the same scope, so a schema without a `local` block still gets one.

## Builtins and `t.extend`

Every scope includes `members`, `devices`, `invites`, `handles` and `files` whether the schema mentions them or not. `t.extend(fields)` adds fields to one of those five, keyed by ref name:

```js
members: t.extend({ alias: t.string })
```

Extending anything else throws `'<name>' is not an extendable builtin`, and redeclaring a base field throws `'<field>' is a base field of '<type>' and cannot be redeclared`.

The bundled extensions contribute schema too: `profileSync` declares a `profile` single and extends `members`, `handleSync` extends `handles`. Your schema wins on a conflict. See [Extensions](extensions.md).

## Add, never reorder

```js
// v1
todos: t.collection({ text: t.string, done: t.bool })
// v2, fine: a new field at the end
todos: t.collection({ text: t.string, done: t.bool, due: t.int })
// never: inserting, removing or reordering breaks every row on disk
```

Fields are numbered in declaration order, and that numbering is on the wire and on disk. New fields go at the end of a type. Never remove or reorder existing ones, or old rows decode as the wrong fields. Rebuild over the existing `spec/` rather than deleting it first, because route ids are numbered positionally and persisted.

## `build(specDir, schema, opts)`

```js
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

await build('./spec', schema)
```

| Option       | Type      | Default  | Meaning                                                       |
| ------------ | --------- | -------- | ------------------------------------------------------------- |
| `ns`         | `string`  | `'cero'` | Namespace prefix for the emitted ids, as in `@cero/messages`. |
| `extensions` | `boolean` | `true`   | `false` leaves out the bundled extensions' schema.            |

Build with `{ extensions: false }` and open with `{ extensions: false }` too, or the spec and the runtime disagree.

`build` writes `spec/index.js` plus `main/`, `local/` and one `handles/<name>/` per room type, each holding `schema/` and `db/`, and `dispatch/` for the replicated scopes. Only `main/` gets `rpc/`. `spec/index.js` exports `spec`, which you hand to `cero()`, and `meta`, which describes the shape: `ns`, `version`, `refs`, `local`, `handles`.

`meta.version` is the contract version, the highest of the auto-bumped schema, db and dispatch versions. Every op is stamped with it, and a peer on an older build skips newer ops and emits `behind` rather than failing on them.

## Next

- [Data](data.md) to read and write what you just described.
- [Handles](handles.md) for invites, roles and members.
- [Files](files.md) for the `t.file` column.
