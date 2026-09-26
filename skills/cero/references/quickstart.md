# Quickstart

Build a chat that runs in two terminals: one creates a room and prints an invite, the other joins with it, and every line typed in either shows up in both.

```sh
mkdir chat && cd chat
npm init -y
npm pkg set type=module
npm install @cero-base/cero
```

You need Node 22 or newer. The app is three files: a schema, a build script and the chat.

## Describe the data

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  room: {
    messages: t.collection({ from: t.string, text: t.string })
  }
})
```

`room` declares a kind of room: a space you open and share by invite, encrypted with its own key. `messages` is a collection, a table of rows. Cero adds `id`, `memberId`, `index`, `createdAt` and `updatedAt` to every row.

## Build it

```js
// build.js
import { build } from '@cero-base/cero/build'
import { schema } from './schema.js'

await build('./spec', schema)
```

```sh
node build.js
```

This writes `spec/`, the compiled schema your app imports. Run it again after every schema change. Every device in a room needs the same `spec/`: one on an older build skips the newer writes and shows `behind` in its `room.status`.

## Write the chat

```js
// chat.js
import readline from 'readline'
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

const [name, invite] = process.argv.slice(2)
const me = await cero(`./${name}`, spec)

let room
if (invite) {
  room = await cero.open(me.room, { invite })
  console.log('joined')
} else {
  room = await cero.open(me.room, { name: 'chat' })
  console.log('invite:', await cero.invite(room))
}

cero.watch(room.messages, { changes: true }).on('data', ({ changes }) => {
  for (const { prev, next } of changes) if (!prev) console.log(`${next.from}: ${next.text}`)
})

readline.createInterface({ input: process.stdin }).on('line', (text) => {
  cero.put(room.messages, { from: name, text })
})
```

`me` is you on this device: the first run in a directory creates your identity there, later runs open it. An invite lets one person in as a member and never expires; call `cero.invite(room)` again for the next person. `watch` sends the messages now and after every change, and with `changes: true` each item lists what changed, `prev` being `null` for a new row.

## Run it in two terminals

Start alice in one terminal, and bob in another with the whole invite alice printed. They are two users, with their data in `./alice` and `./bob`. Then type a line in either and press Enter.

```console
$ node chat.js alice
invite: yryb1pgmtzjph1yw6syywotoufh55ur7tgtjgqiysnm4h1…
hi, anyone here?
alice: hi, anyone here?
bob: hi alice
welcome, bob
alice: welcome, bob
```

```console
$ node chat.js bob yryb1pgmtzjph1yw6syywotoufh55ur7tgtjgqiysnm4h1…
joined
alice: hi, anyone here?
hi alice
bob: hi alice
alice: welcome, bob
```

Lines without a name are what you typed, the others come from the room. Bob sees alice's first line as he joins: the first item of a watch holds every row already there.

The first connection over the internet can take a few seconds. If the join takes longer than 30 seconds, `cero.open` rejects with `TIMEOUT`: run the same command again and the join picks up where it stopped. Ctrl+C stops a side, and its data stays in its directory.

Cero prints errors that happen in the background, away from any call, and keeps going; pass `onerror` to `cero()` to handle them yourself.

## Open the same room next time

As it stands, every run of `node chat.js alice` creates another room with a new invite, because every `cero.open(me.room, { name })` does. Your rooms are the rows of `me.room`, so before the next run, change chat.js to open the first one by id when there is one.

```js
// chat.js, in place of the lines that open the room; me and invite from above
const { data: rooms } = await cero.get(me.room)

let room
if (invite) {
  room = await cero.open(me.room, { invite })
  console.log('joined')
} else if (rooms.length) {
  room = await cero.open(me.room, { id: rooms[0].id })
} else {
  room = await cero.open(me.room, { name: 'chat' })
  console.log('invite:', await cero.invite(room))
}
```

```console
$ node chat.js alice
alice: hi, anyone here?
bob: hi alice
alice: welcome, bob
```

The history prints first, as it did for bob when he joined. `node chat.js bob`, with no invite, reopens the room bob joined.

## Be alice on another device

Your phrase is twelve words Cero generated with your identity on the first run. The same phrase on another device makes it the same user. Print it from chat.js:

```js
// chat.js, after the cero() line
console.log('phrase:', await cero.phrase(me))
```

Restart alice: she prints her phrase, and one of her devices is online. Then, in a third terminal, open her from the phrase in a fresh directory:

```js
// device.js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

const [name, phrase] = process.argv.slice(2)
const me = await cero(`./${name}`, spec, { seed: cero.toSeed(phrase) })

cero.watch(me.room).on('data', ({ data }) => console.log(data.map((room) => room.name)))
```

```console
$ node device.js alice-laptop "<alice's twelve words>"
[ 'chat' ]
```

Her rooms arrive as they sync, which is why this watches `me.room` instead of reading it once. Stop it, and `node chat.js alice-laptop` opens the same room as alice, from her second device.

A phrase recovers only in a fresh directory, with the same `channel` and `mirrors` options as your other devices, while one of them is online. Otherwise `cero()` rejects with `TIMEOUT` after 30 seconds and creates nothing. The seed sits unencrypted in the data directory unless you pass `storageKey`. [Your devices](identity.md) has the full story.

## What you built

| File        | Idea                                                                                  |
| ----------- | ------------------------------------------------------------------------------------- |
| `schema.js` | Your data, described once: a kind of room and the messages in it.                     |
| `build.js`  | The compiled `spec/` every device runs, rebuilt after each schema change.             |
| `chat.js`   | `me` is you, a room is shared by invite, `put` writes and `watch` shows every change. |
| `device.js` | The phrase makes another device the same user, with the same rooms.                   |

[example/chat-terminal](../example/chat-terminal) is the full version, with display names, more invites and a flag for the phrase.

## Next

- [Schema](schema.md): every field type, and growing a schema without breaking older builds.
- [Sharing](handles.md): roles, invites that expire or wait for a yes, removing a member.
- [Your devices](identity.md): the phrase, recovery and removing a device.
