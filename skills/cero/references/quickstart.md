# Quickstart

## On this page

- [1. Describe your data](#1-describe-your-data)
- [2. Build it, once](#2-build-it-once)
- [3. Use it](#3-use-it)
- [Watch instead of poll](#watch-instead-of-poll)
- [Share with a handle](#share-with-a-handle)
- [The first device and its phrase](#the-first-device-and-its-phrase)
- [Another device from the phrase](#another-device-from-the-phrase)
- [Node or Bare](#node-or-bare)

```sh
npm install @cero-base/cero
```

A cero app is three files.

## 1. Describe your data

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  notes: t.collection({
    title: t.string,
    body: t.string,
    pinned: t.bool
  })
})
```

`t.collection` is a table of rows. cero adds `id`, `createdAt`, `updatedAt`, `index` and `memberId` to every row for you.

## 2. Build it, once

```js
// build.js
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

await build('./spec', schema)
```

```sh
node build.js
```

This writes `spec/`, the compiled form of your schema. Run it again whenever the schema changes. Add `"prepare": "node build.js"` to package.json and it happens on install.

## 3. Use it

```js
// index.js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

const me = await cero('./data', spec)

await cero.put(me.notes, { title: 'first', body: 'hello', pinned: true })

const { data } = await cero.get(me.notes)
console.log(data) // [{ id, memberId, index, createdAt, updatedAt, title, body, pinned }]

await me.close()
```

Run it with `node index.js`. That is the whole loop. `me` is your root handle. `me.notes` is the ref for your collection. `cero.put` writes, `cero.get` reads.

## Watch instead of poll

```js
cero.watch(me.notes).on('data', ({ data }) => render(data))
```

Or as a loop:

```js
for await (const { data } of cero.watch(me.notes)) render(data)
```

The stream sends the current rows now and again after every change, local or from a peer. Destroy it when you are done, or pass `{ signal: me.signal }` and it dies with the handle.

## Share with a handle

Anything you want other people to see goes in a child handle. Declare one as a nested object in the schema, then open it from `me`. The examples call it a room:

```js
// schema.js
export const schema = cero.schema({
  notes: t.collection({ title: t.string, body: t.string, pinned: t.bool }),
  room: { notes: t.collection({ title: t.string, body: t.string }) }
})
```

```js
const room = await cero.open(me.room, { name: 'team' })
await cero.put(room.notes, { title: 'shared', body: 'everyone sees this' })

const invite = await room.invite()
```

Send the invite string any way you like. On the other side:

```js
const room = await cero.open(me.room, { invite })
```

Both sides now write to the same room and see each other's rows, online or after reconnecting.

## The first device and its phrase

There is no identity option on a fresh app. cero generates the identity, and you show the phrase to the user once.

```js
const me = await cero('./data', spec, { name: 'laptop' })

console.log(me.identity.toPhrase())
// twelve words: keep them, they are the account
```

The next launch on the same machine is the same call with no phrase. The identity and this device's writer are stored in `./data`, so `cero('./data', spec)` opens as you.

## Another device from the phrase

The user types the phrase. Nothing else.

```js
const me = await cero('./data', spec, { phrase, name: 'phone' })

me.id // same as on the laptop
const { data: rooms } = await cero.get(me.room)
// [{ id, type: 'room', name: 'team', ... }]  the laptop's rooms, replicated
```

Underneath, the phone derived a pointer core from the phrase, read the root database key from a device of yours that is online, opened that database with a writer core of its own, pulled the history, and admitted itself with a signature only the phrase can produce. It never writes to a core the laptop wrote. If no device of yours is reachable it rejects with `TIMED_OUT` after `recoveryTimeout`, 30 seconds by default, rather than start a second history.

A supplied phrase only ever recovers, it never creates an identity, so a typo cannot silently hand you an empty account.

## Node or Bare

```js
import fs from 'fs' // not 'node:fs'
import { join } from 'path'
```

Both, Node 22 or newer. Import `fs`, `path`, `crypto`, `events` and `url` as usual, with no `node:` prefix; on Bare the package maps them to the `bare-*` modules. Nothing in your code changes.

## Next

- [Schema](schema.md) for every field type, singles, actions and rooms.
- [Data](data.md) for queries, `set`, `del`, `changes` and hooks.
- [Handles](handles.md) for roles, invites that expire, and revoking.
