# Your devices

Be the same user on every device, add a device from the phrase, and remove one you lost.

```js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

// the first device
const laptop = await cero('./laptop-data', spec, { name: 'laptop' })
const phrase = await cero.phrase(laptop) // show it to the user once

// a second device, from nothing but the phrase, while the laptop is online
const phone = await cero('./phone-data', spec, { seed: cero.toSeed(phrase), name: 'phone' })
phone.id === laptop.id // true: one identity, the same data and rooms
phone.device.id === laptop.device.id // false: each device has its own id
```

You are your phrase: 12 words, or 24, that every device of yours opens with. Each device, one
install of your app, has the same `me.id` and the same data, and is the same member in every room.
Invites are for rooms and other people; your own devices join by phrase.

## First run

```js
const fresh = !(await cero.peek('./data', spec))
const me = await cero('./data', spec, { name: 'laptop' })
if (fresh) showOnce(await cero.phrase(me)) // showOnce is your UI
```

`cero(dir, spec)` on an empty directory creates a new identity and stores it there. `cero.peek`
tells a first run from a returning one without opening anything. Show the phrase once and make
keeping it the user's job: Cero never sends it anywhere. Pass `{ words: 24 }` for a 24-word phrase.

## Add a device

```js
try {
  const me = await cero('./data', spec, {
    seed: cero.toSeed(phrase), // throws INVALID on a mistyped phrase
    channel: 'my-app', // the same channel and mirrors as your other devices
    mirrors: [mirrorKey] // mirrorKey from your mirror, see Network
  })
} catch (err) {
  // tell is your UI
  if (err.code === 'TIMEOUT') tell('open the app on one of your other devices, then retry')
}
```

Use a fresh directory, and have a device of yours online: the new one finds it and is let in by it,
with the phrase as proof. It waits in three steps, each up to `recoveryTimeout` (30 s by default),
and rejects `TIMEOUT` when no device of yours answers.

The seed is stored before that wait, so a retry is plain `cero(dir, spec)` with the same channel and
mirrors, and `cero.peek` reports the directory as used. It rejects `TIMEOUT` again until one of your
devices is reachable. [How it works](how-it-works.md) has the steps.

## Open your rooms on it

```js
// me from the device you just added
const { data: rooms } = await cero.get(me.room)
for (const { id } of rooms) await cero.open(me.room, { id })
```

Rooms do not open by themselves on a new device. The list arrives with the rest of your data, and
you open each room by id. The first open by id waits for a device already in that room, and rejects
`TIMEOUT` after 30 s.

## Switch to another identity

```js
// me is open on a directory that holds another identity
const restored = await cero.restore(me, cero.toSeed(phrase))
```

`cero.restore` closes `me`, deletes the directory's data, then opens it with the new seed and every
other option `me` had, the channel and mirrors included. It recovers like a new device, so it can
reject `TIMEOUT` after the delete; the new seed is stored by then, so retry with `cero(dir, spec)`.
Never pass a new seed to `cero()` on a used directory: switching goes through `cero.restore`.

A seed that is already `me`'s returns `me` unchanged. Over RPC the client's `cero.restore(me, phrase)`
takes the phrase itself.

## Remove a device

```js
const { data: devices } = await cero.get(me.devices) // [{ id, memberId, name, isMobile, ... }]
await cero.del(me.devices, lostId) // lostId: the id of the device you lost
```

`me.device.id` is this device's own id. A removed device cannot write to your data. It is not
locked out, though: a device that still holds the seed can add itself back like any new device, and
anyone with the phrase is you.

## Encrypt the seed at rest

```js
const storageKey = await keychain.get('cero') // 32 bytes; keychain is your OS keychain binding
const me = await cero('./data', spec, { storageKey })
```

The seed and this device's keys sit in the data directory unencrypted unless you pass `storageKey`.
Cero never stores the key: source it from the OS keychain and pass the same one on every open.

## Next

- [Network](network.md) for the channel and mirrors every device of yours shares.
- [Apps](apps.md) to run Cero in a worker and keep the phrase out of the UI.
- [How it works](how-it-works.md) for what recovery does step by step.
