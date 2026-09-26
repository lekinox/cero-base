# Network

[Docs](README.md) · Previous: [Your devices](identity.md) · Next: [Apps](apps.md)

Sync while devices are offline through a mirror, sync nearby over Bluetooth, background the app and
keep many rooms cheap.

```js
// spec from the quickstart, mirrorKey from your mirror below
const me = await cero('./data', spec, {
  channel: 'my-app',
  mirrors: [mirrorKey]
})
```

Cero finds peers over the DHT and syncs directly with them. Devices that start together meet within
seconds, and meet again as fast after a restart, a dropped connection or a network change. These options change how peers
meet, never what they sync. Give every device of your app the same ones.

## Keep apps apart with a channel

```js
const me = await cero('./data', spec, { channel: 'my-app-staging' })
```

A channel is a label: only peers on the same channel meet. Use one per app, or one per environment,
so a test build never talks to production. A directory keeps the first channel it is opened with;
opening it with a different channel, or none, then throws `CHANNEL_MISMATCH`.

## Sync offline through a mirror

Two devices sync only while both are online. A mirror is an always-on peer that holds your rooms'
and files' encrypted blocks, so a device catches up on the writes it missed while offline. It is
blind: it stores ciphertext and reads nothing.

Without mirrors, every member's device holds a room's full history once caught up, so any member
online serves it, to a joiner too. With mirrors, a device may hold only part of a room; the mirror
holds it all.

```js
import BlindPeer from 'blind-peer'
import b4a from 'b4a'

const mirror = new BlindPeer('./mirror-store')
await mirror.listen()
console.log(b4a.toHex(mirror.publicKey)) // your mirrorKey
```

The key lives in `./mirror-store`: keep that directory, and do not hand the mirror a swarm of your
own. A swarm with no keyPair gets a new key every restart, which breaks every app's `mirrors`.
`services/mirror` in this repo runs one in a container.

Joins go through the mirror too:

- A join waits there until a member device comes online, and the member's answer waits there for the
  joiner.
- The invite names no mirrors: each side uses its own, so give every device the same `mirrors`.
- If more than 32 people join while no member device is online, the mirror passes on the 32 most
  recent; the rest go through once joiner and member are online together.

## Background the app

```js
await cero.suspend(me) // to the background: network, storage and Bluetooth pause
await cero.resume(me) // back in front
```

They are the app's lifecycle, so they take `me`: on a room they throw `INVALID`. Between the two,
`status.suspended` is `true` on `me` and on every room. Both are cheap and safe to repeat.

```js
// React Native; me from cero(ipc, spec)
import { AppState } from 'react-native'

AppState.addEventListener('change', (state) => {
  if (state === 'background') cero.suspend(me)
  if (state === 'active') cero.resume(me)
})
```

```js
// Electron main; win is your BrowserWindow
import { powerMonitor } from 'electron'

powerMonitor.on('suspend', () => win.webContents.send('lifecycle', 'suspend'))
powerMonitor.on('resume', () => win.webContents.send('lifecycle', 'resume'))

// renderer; bridge is what your preload exposes, me from cero(ipc, spec)
window.bridge.onLifecycle((event) => (event === 'suspend' ? cero.suspend(me) : cero.resume(me)))
```

## Many rooms

```js
// room: any room you have open
await cero.activate(room) // the room on screen: ranked first
await cero.deactivate(room) // off the swarm after about 30 s idle, until something lands in it
```

Rooms are ranked by their last update, from anyone: the latest 8 search and announce, the next 8
only announce, the rest leave the swarm. A room moves up the moment something lands in it and down
only after 30 s idle, so rooms at the edge do not churn the DHT. Your own data, on `me`, always
searches.

A room off the swarm still reads, writes and watches. It still syncs over the connections other
rooms bring in and through your mirrors. `cero.activate` has nothing to do with `cero.suspend`: a
suspended app keeps its ranks.

```js
const me = await cero('./data', spec, { presence: { active: 8, announced: 8, idle: 30000 } })
```

Those are the defaults. `active` rooms search and announce, `announced` rooms only announce, and
`idle` is the ms before a room drops a tier.

## Sync nearby over Bluetooth

```js
const me = await cero('./data', spec, { channel: 'my-app', bluetooth: true })

const { data: status } = await cero.get(me.status)
status.nearby // see the table
const { data: peers } = await cero.get(me.nearby) // [{ id, device, name, isMobile }]
```

Bluetooth is a transport, not another API: the same refs, roles and data ride over it with no
internet, between your own devices too, and a phrase recovers over it. `me.nearby` lists the devices
linked, one row each: `id` is the person (`me.id` on your other devices), `device` tells two devices
of one person apart, strangers on the same channel included; a stranger syncs nothing it has no key for. macOS 13+, iOS and Android are supported.

`name` comes from the peer's `me.profile`, else their member row in a room you share and have open, else
`null`; `isMobile` is their device's option. Only Bluetooth carries them, with proof of whose device
it is. `cero.watch` follows both refs, renames included.

| `status.nearby`  | means                         | do                                  |
| ---------------- | ----------------------------- | ----------------------------------- |
| `'on'`           | the radio runs                |                                     |
| `'starting'`     | the radio is coming up        |                                     |
| `'waiting'`      | the OS Bluetooth is off       | ask the user to turn it on          |
| `'unauthorized'` | no Bluetooth permission       | send the user to the app's settings |
| `'off'`          | stopped                       | `cero.nearby(me, true)`             |
| `'unsupported'`  | no Bluetooth on this platform |                                     |
| `null`           | no `bluetooth` option         |                                     |

`bluetooth: { autoStart: false }` opens with the radio off; `cero.nearby(me, true)` and
`cero.nearby(me, false)` drive it from a settings toggle. `bluetooth: { pipe: 'gatt' }` picks the
other data pipe, `'l2cap'` by default, and both peers must match. Without the `bluetooth` option
`cero.nearby` throws `INVALID`.

An invite works offline too. The host holds its rendezvous while the QR code is on screen, and the
joiner, radio on, runs the same `cero.open(me.room, invite)` as online:

```js
const invite = await cero.invite(room, { ttl: '1h' })
await cero.nearby(me, invite) // until the next call or the invite expires
await cero.nearby(me, true) // the QR code closed: back to the mesh
```

While a device holds an invite, and on the joiner during its `cero.open`, its other Bluetooth links
drop until it lets go of the invite and the joiner's link closes.

## Mixed app versions

```js
// showUpdatePrompt is your UI
for await (const { data } of cero.watch(room.status)) if (data.behind) showUpdatePrompt()
```

Every write carries your app's contract version, stamped by `build`. Peers on different versions keep
working together: writes from a newer version are skipped, not errors, and `status.behind` holds the
highest version seen. Once the app upgrades, the next open catches up on them. `status.behind` is per
context, so watch `room.status` for each open room as well as `me.status`.

## Next

- [Apps](apps.md) to run Cero in a worker behind an Electron or Expo UI.
- [Your devices](identity.md) for recovery, which needs the same channel and mirrors.
- [How it works](how-it-works.md) for what a mirror holds and why it reads nothing.
