# Your devices

Be the same user on every device, link a device from one you have, recover from the phrase when you
have none, and remove one you lost.

```js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'

// the first device
const laptop = await cero('./laptop-data', spec, { name: 'laptop' })
const phrase = await cero.phrase(laptop) // show it to the user once

// a second device, linked from the laptop: an invite there, accepted there
const invite = await cero.invite(laptop)
const phone = await cero('./phone-data', spec, { invite, name: 'phone' })
phone.id === laptop.id // true: one identity, the same data and rooms
phone.device.id === laptop.device.id // false: each device has its own key and id
```

You are your phrase: 12 words, or 24, that wrote your identity. Its key signs one thing, a device's
proof, when the identity is created or recovered on it. Every device then signs with a key of its
own, under that proof: a stolen device leaks itself, and another device of yours removes it. Each
device, one install of your app, has the same `me.id` and the same data, and is the same member in
every handle.

## First run

```js
const fresh = !(await cero.peek('./data', spec))
// a first run offers three ways in: a new account, or an account you have, by linking a device
// of it or by its phrase
const me = fresh
  ? await cero('./data', spec, {
      name: 'laptop',
      ...(invite ? { invite } : phrase ? { phrase } : {})
    })
  : await cero('./data', spec)
if (fresh && !invite && !phrase) showOnce(await cero.phrase(me)) // showOnce is your UI
```

`cero(dir, spec)` on an empty directory creates a new identity and stores it there. With `invite`
it links this device to the identity that minted it; with `phrase` it recovers that identity.
`cero.peek` tells a first run from a returning one without opening anything. Show the phrase once
and make keeping it the user's job: Cero never sends it anywhere. Pass `{ words: 24 }` for a 24-word
phrase.

## Link a device

```js
// on a device of yours: mint the invite, show the requests, accept the one that matches
const invite = await cero.invite(me) // single-use, two hours: { ttl } sets it
for await (const { data } of cero.watch(me.requests, { admitted: false })) {
  for (const request of data) {
    if (await confirm(request.id))
      await cero.accept(me, request) // confirm is your UI
    else await cero.deny(me, request, 'not mine')
  }
}

// on the new device, a fresh directory
const me = await cero('./data', spec, {
  invite, // scanned or pasted from the other device
  onrequest: (id) => show(id), // the same id the other device shows: compare before accepting
  channel: 'my-app', // the same channel and mirrors as your other devices
  mirrors: [mirrorKey]
})
```

The new device asks in with the invite and a key of its own; the device that accepts attests that
key under your identity and sends the root's keys. From then on it is you, with no phrase on it:
`cero.phrase` is `INVALID` there, and it can link further devices itself. Show the request id on
both screens: an intercepted invite can ask in, but only the request you compared gets accepted.

`cero()` waits `recoveryTimeout` (30 s by default, `0` for as long as the invite lasts) for the
accept and rejects `TIMEOUT`, keeping the request: the next `cero(dir, spec)`, with no invite,
resumes it. A denied request rejects `DENIED`, and leaves nothing to resume: the next
`cero(dir, spec)` starts fresh, as a new identity.

## Recover from the phrase

```js
try {
  const me = await cero('./data', spec, {
    phrase, // throws INVALID on a mistyped phrase
    channel: 'my-app', // the same channel and mirrors as your other devices
    mirrors: [mirrorKey] // mirrorKey from your mirror, see Network
  })
} catch (err) {
  // tell is your UI
  if (err.code === 'TIMEOUT') tell('open the app on one of your other devices, then retry')
}
```

When no device of yours is around to accept, the phrase is the way in: it attests a fresh key for
this device, and the device holds the phrase from then on, like the one that created the identity.
Use a fresh directory, and have a device of yours online, or in range with the radio on at both
ends: `bluetooth: { on: true }` on the new one, since the recovery runs inside `cero()`. The new one
finds it and is let in by it, with the proof the phrase gave its device key. It waits in three steps, each up to
`recoveryTimeout` (30 s by default), and rejects `TIMEOUT` when no device of yours answers.

The seed is stored before that wait, so a retry is plain `cero(dir, spec)` with the same channel and
mirrors, and `cero.peek` reports the directory as used. It rejects `TIMEOUT` again until one of your
devices is reachable. [How it works](how-it-works.md) has the steps.

## Open your handles on it

```js
// me from the device you just added
const { data: rooms } = await cero.get(me.room)
for (const { id } of rooms) await cero.open(me.room, { id })
```

Handles do not open by themselves on a new device. The list arrives with the rest of your data, and
you open each handle by id. The first open by id waits for a device already in that handle, and rejects
`TIMEOUT` after 30 s.

## Switch to another identity

```js
// me is open on a directory that holds another identity
const restored = await cero.restore(me, phrase)
```

`cero.restore` closes `me`, deletes the directory's data, then opens it with the phrase's identity and every
other option `me` had, the channel and mirrors included. It recovers like a new device, so it can
reject `TIMEOUT` after the delete; the new identity is stored by then, so retry with `cero(dir, spec)`.
Another phrase in `cero()` on a used directory is `INVALID`: switching goes through `cero.restore`.

A phrase that is already `me`'s returns `me` unchanged. A client makes the same call.

```js
// or link it as a device of the identity behind an invite from another device
const linked = await cero.link(me, invite, { onrequest: (id) => show(id) })
```

`cero.link` is the same switch by a device invite: `me` closes, the directory's data goes, and it
opens linking, as `cero()` with `invite` does. It waits for the accept as long as the invite lasts,
since the other device is in the user's other hand; `DENIED` ends it.
An app whose worker opens cero before the user chooses, as one driven over RPC does, offers all
three ways in from one screen with `cero.restore` and `cero.link`.

## Remove a device

```js
const { data: devices } = await cero.get(me.devices) // [{ id, memberId, name, isMobile, ... }]
await cero.del(me.devices, lostId) // lostId: the id of the device you lost
```

`me.device.id` is this device's own id. A removed device loses its seat in your root and in every
handle, the root re-keys so it reads nothing written after, and its key never comes back: not by a
claim, a join or a link, nor through a device it links. It returns only as a new device, after a
wipe, with the phrase or an invite you accept. A device that holds the phrase can still come back
that way: anyone with the phrase is you.

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
