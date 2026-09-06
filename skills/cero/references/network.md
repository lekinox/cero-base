# Network

```js
const me = await cero('./data', spec, {
  channel: 'my-app',
  mirrors: ['<blind-peer-key>']
})
```

cero finds peers over the DHT and syncs directly with them. These options change how peers meet, not what they sync.

## On this page

- [Channels](#channels)
- [Mirrors](#mirrors)
- [Backgrounding](#backgrounding)
- [Nearby sync over Bluetooth](#nearby-sync-over-bluetooth)
- [App versions](#app-versions)

## Channels

```js
const me = await cero('./data', spec, { channel: 'my-app-staging' })
```

A channel is a label that isolates your app's network. Only peers on the same channel meet. Use one per app, or one per environment, so a test build never talks to production.

A storage directory remembers its channel. Reopening it under a different channel, or under none, throws `CHANNEL_MISMATCH` instead of silently joining another network.

## Mirrors

Two devices can only sync while both are online. A mirror is an always-on peer that holds your handles' encrypted blocks and serves them to members, so a device picks up what was written while it was away. It is blind: everything it stores is ciphertext.

```js
const me = await cero('./data', spec, { mirrors: [mirrorKey] })
```

Every handle and every file is mirrored, nothing else changes. Mirror keys carry through `restore`. Recovery of a second device works through a mirror too, so your data is reachable even when none of your devices is online.

Running one is a few lines with `blind-peer`:

```js
import Hyperswarm from 'hyperswarm'
import BlindPeer from 'blind-peer'

const swarm = new Hyperswarm()
const mirror = new BlindPeer('./mirror-store', { swarm })
await mirror.listen()
console.log(mirror.publicKey.toString('hex')) // pass this as mirrors: [...]
```

## Backgrounding

```js
await me.suspend() // drop sockets, keep state
await me.resume()
me.suspended // true between the two
```

Mobile apps call these when the app leaves and returns to the foreground. `suspend` is idempotent and cheap.

```js
room.setActive(false) // stay reachable, stop searching
room.setActive(true) // on focus
```

`setActive(false)` demotes a handle to server-only announcing. Use it for rooms the user is not looking at.

## Nearby sync over Bluetooth

```js
const me = await cero('./data', spec, { channel, bluetooth: true })

me.bluetooth.state // 'unsupported' | 'unauthorized' | 'off' | 'waiting' | 'on'
me.bluetooth.peers // live links
me.bluetooth.on('update', () => {})
```

Bluetooth is a transport, not another API. The same refs, roles and streams ride over it, with no internet at all. Same-channel devices in range find each other, a stranger who connects syncs nothing.

Pass `{ autoStart: false }` to build `me.bluetooth` without turning the radio on, then `await me.bluetooth.start()` and `stop()` from a settings toggle. Without a Bluetooth backend `state` is `'unsupported'`. macOS, iOS and Android are supported.

An invite works offline too. The host announces it while the QR code is on screen, and the joiner runs the same `open` as online:

```js
const invite = await room.invite({ role: 'member', expiresIn: 3600_000 })
const stop = me.bluetooth.announce(invite) // stops by itself at expiresIn
// later, or when the QR closes
stop()
```

## App versions

Every op carries the app's contract version, stamped into the spec by `build`. Peers on different versions keep working together:

- Ops from a newer version are skipped, not errors. `me.store.behind` holds the highest version seen, and the store emits `behind` once per version, which is your cue to show an update prompt.
- After the app upgrades past what it skipped, the next open replays those ops and the store emits `rebuild` once. Nothing is lost.

```js
me.store.on('behind', (version) => showUpdatePrompt())
```

## Next

- Examples for a mobile app that suspends, resumes and syncs nearby.
- [Identity](identity.md) for recovery, which mirrors keep working offline.
- [Encryption](encryption.md) for why a mirror sees nothing.
