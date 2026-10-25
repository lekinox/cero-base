# Network

Sync while devices are offline through a mirror, sync nearby over Bluetooth, background the app and
keep many handles cheap.

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

Two devices sync only while both are online. A mirror is an always-on peer that holds your handles'
and files' encrypted blocks, so a device catches up on the writes it missed while offline. It is
blind: it stores ciphertext and reads nothing.

Without mirrors, every member's device holds a handle's full history once caught up, so any member
online serves it, to a joiner too. With mirrors, a device may hold only part of a handle; the mirror
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

They are the app's lifecycle, so they take `me`: on a handle they throw `INVALID`. Between the two,
`status.suspended` is `true` on `me` and on every handle. Both are cheap and safe to repeat.

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

## Push while the app is dead

A member's phone learns of new data while the app is not running, through the platform's push
service, without any server reading the data.

Run a push gateway next to the mirror, with the app's Firebase credentials, and give the mirror its
key: `services/mirror` ships both. Then hand `connect` the platform's messaging service:

```js
import messaging from '@react-native-firebase/messaging'
import { firebase } from '@cero-base/cero/push/firebase'

const me = await connect(ipc, spec, { push: { backend: firebase(messaging()) } })
```

That is the app's whole part while it runs. Cero subscribes the device to one topic per handle it
belongs to, drops the topic when the handle is left, and when a push arrives verifies it and ranks
the handle first, so it syncs now. A write to a ref that declares `push` in the
[schema](schema.md#push-a-notification-on-a-write) pushes once the handle's mirror holds it; a burst
of writes is one push, or two, and one cut off by the app going to the background goes at resume.

For a push that arrives while the app is dead, the OS runs a small worklet instead. Its whole code:

```js
// worklets/push.js, the bare-kit push entry; spec as the worker imports it
import { push } from '@cero-base/cero/push'
import { spec } from './spec.js'

push(spec)
```

It opens the storage read-only, verifies the push and answers with the notification to show,
`{ title: <the handle's name>, body: <the text its ref declares> }`, `'New activity'` when this
device's schema declares none, or nothing for a push that is forged, stale or about no handle on
this device. The request the OS hands it carries `storage`, `payload` and,
when the app encrypts its local store, `storageKey`, in base64.

What each party sees: the mirror builds the proof from blocks it already holds encrypted; the
gateway and the push service see a topic name and ciphertext; only a member device reads it, and
trusts it only after checking it against cores it already has. A device learns of a new member's
writes only once it has synced that member's admission.

The pieces, for a flow of your own: `status.topic` on a handle is the string to subscribe,
`me.topics` lists them all, `cero.receive(me, payload)` verifies bytes into
`{ id, type, name, newer, ref }` or `null`, and `receive(dir, spec, payload)` from `@cero-base/cero/push`
does the same from a closed app's storage. A backend is any object with `subscribe(topic)`,
`unsubscribe(topic)` and `on('push', fn)`.

## Many handles

```js
// room: any room you have open
await cero.activate(room) // the room on screen: ranked first
await cero.deactivate(room) // off the swarm after about 30 s idle, until something lands in it
```

Handles are ranked by their last update, from anyone: the latest 8 search and announce, the next 8
only announce, the rest leave the swarm. A handle moves up the moment something lands in it and down
only after 30 s idle, so handles at the edge do not churn the DHT. Your own data, on `me`, always
searches.

A handle off the swarm still reads, writes and watches. It still syncs over the connections other
handles bring in and through your mirrors. `cero.activate` has nothing to do with `cero.suspend`: a
suspended app keeps its ranks.

```js
const me = await cero('./data', spec, { presence: { active: 8, announced: 8, idle: 30000 } })
```

Those are the defaults. `active` handles search and announce, `announced` handles only announce, and
`idle` is the ms before a handle drops a tier.

## Sync nearby over Bluetooth

```js
const me = await cero('./data', spec, { channel: 'my-app' })

await cero.nearby(me, true) // the app's Bluetooth setting
const { data: status } = await cero.get(me.status)
status.nearby // see the table
const { data: peers } = await cero.get(me.nearby) // [{ id, device, name, isMobile }]
```

Bluetooth is a transport, not another API: the same refs, roles and data ride over it with no
internet, between your own devices too, and a phrase recovers over it. `me.nearby` lists the devices
linked, one row each: `id` is the person (`me.id` on your other devices), `device` tells two devices
of one person apart, strangers on the same channel included; a stranger syncs nothing it has no key for. macOS 13+, iOS and Android are supported.

`name` comes from the peer's `me.profile`, else their member row in a handle you share and have open, else
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

Every `cero()` has Bluetooth, with the radio off. The app turns it on and off from its own setting,
`cero.nearby(me, true)` and `cero.nearby(me, false)`, at every start: Cero stores neither the radio
nor the topic.

The radio links with the devices in range on the same channel and topic. The default topic is the
channel's own; `cero.nearby(me, true, { topic: 'hall-1' })` moves to another, such as one hall of an
event, and a call without a topic goes back to the default. A new topic drops the links on the old
one. The channel still bounds it: the same topic on another channel is another topic, so a preview
build never meets production.

```js
const me = await cero('./data', spec, { channel: 'my-app', bluetooth: { on: true, topic: 'expo' } })
```

`bluetooth` sets the start: `on`, and `topic`, which becomes the default one. A phrase recovers
over Bluetooth only with the radio on at start, since the recovery runs inside `cero()`.
`pipe: 'gatt'` picks the other data pipe, `'l2cap'` by default, and both peers must match;
`maxOutbound` and `maxInbound` cap the links.

An invite works over Bluetooth too, with no internet: the joiner runs the same
`cero.open(me.room, invite)` as online, and the join travels over the link to a member's device in
range.

## Mixed app versions

```js
// showUpdatePrompt is your UI
for await (const { data } of cero.watch(room.status)) if (data.behind) showUpdatePrompt()
```

Every write carries your app's contract version, kept by `build` in `spec/contract.json`
([Schema](schema.md#change-a-schema-that-shipped)). Peers on different versions keep
working together: writes from a newer version are skipped, not errors, and `status.behind` holds the
highest version seen. Once the app upgrades, the next open catches up on them. `status.behind` is per
context, so watch `room.status` for each open handle as well as `me.status`.

## Next

- [Apps](apps.md) to run Cero in a worker behind an Electron or Expo UI.
- [Your devices](identity.md) for recovery, which needs the same channel and mirrors.
- [How it works](how-it-works.md) for what a mirror holds and why it reads nothing.
