# Handles

```js
const room = await cero.open(me.room, { name: 'general' })
const invite = await room.invite({ role: 'member' })

// on a friend's device
const room = await cero.open(me.room, { invite })
```

Everything is a handle. `me` is the root handle, the user. A child handle is a
space the user opens from `me` and shares with other people: opened with a name,
shared as a string, joined with the same string.

`me.room` exists because the schema declared a `room` handle type, a nested
object. Child handles share the root's identity, network and storage, and each
one is its own database with its own encryption key. The examples call theirs
rooms; a team, a project or a chat is the same thing.

## On this page

- [Opening a handle](#opening-a-handle)
- [Invites](#invites)
- [Joining](#joining)
- [Roles](#roles)
- [Members and devices](#members-and-devices)
- [Accepting joiners](#accepting-joiners)
- [Listing your handles](#listing-your-handles)
- [Leave, close, reopen](#leave-close-reopen)
- [Events](#events)

## Opening a handle

```js
const room = await cero.open(me.room, { name: 'general' }) // create
const joined = await cero.open(me.room, { invite }) // join
const again = await cero.open(me.room, { id: room.id }) // reopen
```

`cero.open` on a handle-kind ref creates, joins or reopens one.

| call                             | what it does                       |
| -------------------------------- | ---------------------------------- |
| `cero.open(me.room, { name })`   | Creates one. You become its owner. |
| `cero.open(me.room, invite)`     | Joins by invite string.            |
| `cero.open(me.room, { invite })` | Same, in object form.              |
| `cero.open(me.room, { id })`     | Reopens one already in your list.  |
| `cero.open(me.room)`             | Creates an unnamed one.            |

Create options are `{ name, routes }`. An unknown handle type
throws `UNKNOWN`. `room.id` is the z32 database key. Handles are isolated:
`me.messages` and `room.messages` are different collections, and one room's key
never opens another.

## Invites

`room.invite(opts)` mints a z32 string. It is a child-handle method. Calling it
on the root throws `INVALID`.

| option    | type               | default | meaning                                                                                                      |
| --------- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------------ |
| `role`    | `string`           | `''`    | Role granted. Must be a rank, and cannot exceed your own.                                                    |
| `ttl`     | `number \| string` | `0`     | How long it is valid: ms, or `'12h'`, `'2d'`. `0` never expires.                                             |
| `reuse`   | `boolean`          | `false` | Admit more than one joiner, at most `member`. Otherwise single use.                                          |
| `confirm` | `boolean`          | `false` | Its joins wait for a member to accept them. See [Accepting joiners](#accepting-joiners).                     |
| `data`    | `Uint8Array`       | `null`  | A payload for the joiner, read with `Invite.parse(invite).data` before joining. Unsigned: a hint, not proof. |

```js
const invite = await room.invite({ role: 'member', ttl: '1d' })
```

Every minted invite is also a row in the room's `invites` collection. The row
replicates, so any member's device answers a join after the minting device goes
offline, and the invite survives a close and reopen. A device answers its rooms'
joins whenever it is online, not only while the app has the room open: at boot
cero reopens every room that still has invites. A single-use row disappears
everywhere once a join spends it. A `reuse` row stays.

## Joining

```js
const room = await cero.open(me.room, { invite })
await cero.put(room.messages, { text: 'hi, I am in' })

await room.revoke(invite) // on the host: it admits nobody from now on
```

`cero.open(me.room, invite)` on the joiner's side pairs and returns the room. It
shows up in their `handles` collection under the same id the host has. Joining is
coalesced by room, not by invite string: two joins in flight for the same room
resolve to one handle, and joining a room you already have open returns that
handle instead of pairing again.

`cero.open` waits up to the join timeout, 30000 ms by default, then rejects with
`TIMEOUT`. The join itself goes on: it is saved on the device, survives a restart,
and once a member answers, even if every member was offline when you joined, the
room is added to `me.handles`. Watch it to see the room arrive, the same way over
`connect()`; in the same process the `handle` event also fires. It ends admitted,
denied, expired or cancelled, and once nobody waits on it, a denial or expiry
reaches `onerror`. A fresh invite for the same room takes over from the old one.

An admin or owner invite hands its rank out once. A reusable invite admits at most
`member`, and the first join to land spends a single-use invite, so one racing it
admits nobody.

```js
const pending = await me.joining() // the invites still waiting for an answer
await me.cancel(invite) // stop for good, it is not resumed on the next boot
```

`room.revoke(invite)` returns `true` the first time and `false` afterwards. It
needs the remove permission, and refuses a plain member before anything reaches
the log. It also drops the joins still waiting on a `confirm` invite. An invite
belongs to the room, not to whoever minted it: it keeps working after its minter
leaves or is removed, until it is revoked. A removed member comes back only
through an invite minted after its removal, never one it held or saw before.

## Roles

```js
const invite = await room.invite({ role: 'reader' }) // read only
await cero.set(room.members, { id: memberId, role: 'admin' }) // promote, needs assign
await cero.del(room.members, memberId) // remove, needs remove

import { can } from '@cero-base/core/utils'
can('member', 'invite') // true
can('reader', 'write') // false
```

There are four ranks. A role that is not one of them grants nothing and is
rejected wherever a role is accepted.

| role     | rank | write | invite | assign | remove |
| -------- | ---- | ----- | ------ | ------ | ------ |
| `owner`  | 3    | yes   | yes    | yes    | yes    |
| `admin`  | 2    | yes   | yes    | yes    | yes    |
| `member` | 1    | yes   | yes    | no     | no     |
| `reader` | 0    | no    | no     | no     | no     |

Minting an invite is capped against your own rank. Changing a role needs the
assign permission, and the assigner must be allowed to hand out the new role and
outrank the current one. Removing a member needs the remove permission and must
outrank the target. A member may always remove themselves. A demotion that takes
write away takes the writer seat with it.

`can`, `grants`, `outranks` and `isRank` are exported from
`@cero-base/core/utils` if you want to check a rank yourself.

## Members and devices

Every handle carries `members` and `devices`. A member row is
`{ id, key, role, name, createdAt, updatedAt }` plus anything added with
`t.extend`. A device row is `{ id, memberId, name, isMobile, ... }`, where
`memberId` links a writer key back to its member. One member can have many
devices.

```js
const { data: members } = await cero.get(room.members)

await cero.del(room.members, memberId) // remove a member and all their devices
await cero.del(room.devices, deviceId) // revoke one device, the member stays
```

Removal is observable: other members see an ordinary delete in a `changes`
stream, and the removed member sees their own removal, because the delete is
appended under an epoch they can still read.

## Accepting joiners

The room admits a join itself: the joiner writes it into its own core, signed
with the invite, and any member device with the room open applies it. Nobody has
to accept.

To approve joins yourself, mint the invite with `confirm: true`. Its joins wait
as candidates on every member device that can invite.

```js
const invite = await room.invite({ role: 'member', confirm: true })

const review = async (cand) => {
  if (await approve(cand)) await room.accept(cand)
  else await cand.deny('not now')
}
// requests still waiting, some from before a restart, then the new ones
for (const cand of room.pair.pending) review(cand)
room.pair.on('candidate', review)
```

`room.accept(candidate, { role })` admits it. `role` defaults to the invite's
role and cannot exceed it, nor your own rank. `accept` refuses when the invite
has expired or the role is not a rank. A request stays pending until a member
accepts or denies it, across restarts: it lives in the room. The joiner may be
long gone; the keys wait on the mirrors, or are offered again whenever a member
is online, until it comes back. Another member
settling it takes it out of `room.pair.pending` here too.

## Listing your handles

Reading a handle ref lists your child handles of that type out of `handles`, and
`cero.watch(me.room)` streams the same list live.

```js
const { data: rooms } = await cero.get(me.room)
// [{ id, type: 'room', name: 'general', createdAt, updatedAt }, ...]
```

## Leave, close, reopen

```js
await room.close() // stop syncing, keep it in my list
const again = await cero.open(me.room, { id: room.id })
await again.leave() // gone from my list
```

`room.leave()` removes the room from `handles` and closes the session.
`room.close()` closes the session but keeps the row, so `cero.open(me.room,
{ id })` brings it back. Both are no-ops on the root.

Rejoining works after leaving, after being removed, and after a device was
revoked. A revoked device rejoins on a fresh writer, its old core being frozen
for good.

## Events

The root emits `handle` every time a child is created, joined or reopened, once
per open. `room.store` emits `writable` and `unwritable`, and `unwritable` is the
explicit signal that you were removed.

```js
me.on('handle', (room, opts) => {}, { signal: me.signal })
room.store.on('unwritable', () => {})
```

`room.store.on('apply', fn)` also sees replicated ops, so an observer learns about a
removal it did not perform. `me.signal` is an `AbortSignal` that fires when the
handle closes: pass it to `on`, `watch`, `before` or `after` to drop a
subscription automatically. Closing the root closes every open child with it.

## Next

- [Identity](identity.md) for the phrase behind every member row.
- [Extensions](extensions.md) to put your name and avatar in every room you join.
- [Files](files.md) for attachments that replicate with a room.
