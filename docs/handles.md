# Sharing

[Docs](README.md) · Previous: [Data](data.md) · Next: [Your devices](identity.md)

Open handles, invite people into them, confirm who joins, give them roles and remove them.

```js
// me from the quickstart; the schema declares room: { messages: t.collection({ text: t.string }) }
const room = await cero.open(me.room, { name: 'general' })
const invite = await cero.invite(room) // a string: send it any way you like

// on a friend's device, with their own me
const joined = await cero.open(me.room, invite)
await cero.put(joined.messages, { text: 'hi, I am in' })
```

A handle is a space you share: its own data, its own members (the people in it) and its own key.
`me.room` exists because the schema declares a `room` type as a nested object; call it a team, a
project or a chat. `me` and every handle are contexts you pass to `cero.*`: they have no methods, and
refs such as `room.messages` hang off them.

## Open a handle

```js
const room = await cero.open(me.room, { name: 'general' }) // create it: you are its owner
const again = await cero.open(me.room, { id: room.id }) // reopen one from your list
const joined = await cero.open(me.room, { invite }) // join: invite is a string someone sent you
```

`{ name }`, or nothing, creates a handle. `{ id }` reopens one: an id not in your list throws
`UNKNOWN`, the id of another type's handle `INVALID`. An invite string, bare or as `{ invite }`, joins.
Anything else, such as a misspelt key or `{ id: undefined }`, is `INVALID`, never a new handle.
Handles are isolated: `me.messages` and `room.messages` are different collections, and one handle's key
never opens another.

## Invite someone

An invite is a string that lets its holder join one handle.

```js
const invite = await cero.invite(room, { role: 'reader', ttl: '1d' })
```

| option    | default    | meaning                                                             |
| --------- | ---------- | ------------------------------------------------------------------- |
| `role`    | `'member'` | The role the joiner gets, at most your own.                         |
| `ttl`     | never      | How long it is valid: ms, or `'12h'`, `'2d'`.                       |
| `reuse`   | single use | `true` admits more than one joiner, at most as `member`.            |
| `confirm` | `false`    | `true` makes each join wait for a member to accept it.              |
| `data`    | `null`     | Bytes the joiner reads before joining. Unsigned: a hint, not proof. |

A role that is not a rank, a `ttl` that is not a duration, or `reuse` above `member` throws
`INVALID`; a role above your own throws `DENIED`. Only handles have invites: `cero.invite(me)` throws
`INVALID`.

```js
import b4a from 'b4a'
import { Invite } from '@cero-base/core/invite' // add @cero-base/core to your dependencies

const code = await cero.invite(room, { data: b4a.from('from ana') })
Invite.parse(code).data // on the joiner's side, before joining
```

Any device whose member can invite (member, admin, owner, never a reader) answers joins while online,
not only the one that minted the invite. Cero reopens handles with live invites at boot, so the app
need not have the handle open.

## Revoke an invite

```js
await cero.revoke(room, code) // true the first time, false afterwards
await cero.revoke(room, row.id) // or the id of its row in room.invites
```

Revoking needs the remove permission (admin or owner), `DENIED` otherwise, and turns away the joins
still waiting on a `confirm` invite. An invite outlives its minter: it works until revoked, expired
or spent.

## Join a handle

```js
try {
  const room = await cero.open(me.room, invite)
  await cero.put(room.messages, { text: 'hi, I am in' })
} catch (err) {
  // tell is your UI
  if (err.code === 'TIMEOUT') tell('no member online yet, the room arrives once one answers')
}
```

`cero.open` waits a fixed 30 s, then rejects `TIMEOUT`. The join goes on, across restarts: once a
member answers, the handle appears in `me.room`, so watch that list. An expired invite rejects
`EXPIRED` at once, a string that is not an invite `INVALID_INVITE`. The latest ask stands: a join
with another invite on another device of yours asks again, and the device that asked first takes
its request back once it is online, its waiting `open` rejecting `CANCELLED`. A cancel, or a row
the app deletes, takes the request back the same way.

```js
const { data: waiting } = await cero.get(me.room, { state: 'asking' }) // still waiting for an answer
await cero.cancel(me, invite) // give up for good: true when it cancelled one
const { data: row } = await cero.get(me.room, id) // state: 'asking', 'joining', 'in', or how it ended
```

A join the handle turns away rejects `DENIED` once a member who can invite is online, with
`err.reason` saying why: `'revoked'`, `'spent'` for a single-use invite someone already used, or
`'removed'` for an invite minted before your removal or spent by one. An invite to a handle you already have returns
that handle; a newer invite to the same handle takes over. Once nobody waits on a join, a denial or
expiry reaches `onerror`.

## Confirm joins

A plain invite lets the joiner in by itself: the invite is the approval. To approve each join
yourself, mint the invite with `confirm: true`. Its joins wait in `room.requests`: every member sees
them, and members who can invite answer them.

```js
// the host; approve is your app's prompt
const invite = await cero.invite(room, { confirm: true })

for await (const { data: requests } of cero.watch(room.requests, { admitted: false })) {
  for (const request of requests) {
    // request.identity: the joiner's key, as bytes. request.role: the invite's role
    if (await approve(request)) await cero.accept(room, request)
    else await cero.deny(room, request, 'not now')
  }
}
```

```js
// the joiner; tell is your UI
try {
  const room = await cero.open(me.room, invite) // resolves once a member accepts
  await cero.put(room.messages, { text: 'thanks' })
} catch (err) {
  if (err.code === 'DENIED') tell(err.reason || 'the room said no')
  if (err.code === 'TIMEOUT') tell('waiting for a member to accept')
}
```

- `hid.encode(request.identity)`, from `hypercore-id-encoding`, is the id their member row will have.
  `room.requests` also holds admitted joins until their keys are delivered (`admitted: true`), hence
  the `{ admitted: false }` filter.
- `cero.accept(room, request)` admits at the invite's role, `{ role: 'reader' }` at a lower one.
  `cero.deny(room, request, reason)` turns the joiner away. The first answer settles the request for
  everyone, and it survives restarts.
- Both reject `UNKNOWN` once the request is settled, here or by another member, and a reader's
  `NOT_WRITABLE`.
  `accept` also rejects `EXPIRED` past the invite's ttl, `INVALID` for a role above the invite's and
  `REFUSED` for one above your own.
- On the joiner's side an answer after 30 s arrives as `TIMEOUT` first: an accept adds the handle to
  `me.room`, a later `DENIED` reaches `onerror`. Either way the reason is `err.reason`, in the
  worker and in a UI.

## Set roles

```js
// memberId: a member's id, which is me.id on their device
await cero.set(room.members, { id: memberId, role: 'admin' })
```

| role     | write | invite | assign | remove |
| -------- | ----- | ------ | ------ | ------ |
| `owner`  | yes   | yes    | yes    | yes    |
| `admin`  | yes   | yes    | yes    | yes    |
| `member` | yes   | yes    | no     | no     |
| `reader` | no    | no     | no     | no     |

The ranks run owner, admin, member, reader. Changing a role needs assign, a new role within your own
and a rank above the member's current one, `REFUSED` otherwise. `can(role, 'invite')` from
`@cero-base/core/utils` checks a rank in your UI; it knows the four names in the table, and any
other is `INVALID`. Every member sets the `name` and `avatar` of her own row in `room.members`, a
reader too, which is how `profileSync` shows her profile; a reader sets nothing else of it.

## Remove a member

```js
await cero.del(room.members, memberId) // the member and every device of theirs
await cero.del(room.devices, deviceId) // one device, the member stays: an id from room.devices
```

Removing needs the remove permission and a higher rank: removing an equal or higher rank rejects
`REFUSED`. Anyone may remove themselves, a reader too, except the last owner of a handle others are
in: `INVALID`. The removed member's `room.status` shows `role: null`, and
they come back only through an invite minted after the removal: an older one rejects `DENIED` with
`err.reason` `'removed'`. A removal by an admin or the owner, of a member, of a device, or of someone
who already left, also spends the invites that let people in without `confirm`, since the one
removed may hold one: a join with one rejects `DENIED` with `err.reason` `'removed'`, and a join one
had let in that has not taken its seat yet ends the same, unless a member accepted it. Invites with
`confirm` stay. Mint a new
invite for anyone still expected.

### Removed

```js
await cero.removed(room, memberId) // 'removed', 'left' or null
```

Whether a member is out for good, from the record the handle keeps of it: `'removed'` when another
member took her out, `'left'` when she left. It is `null` while she is a member, once she is let in
again, for someone who never was one, and while her going has not reached this device. A missing
`members` row is not that record: on a device still catching up it only means not yet. Read it to
end what the handle gave her elsewhere, a seat in another handle say.

## Remove and rotate the key

```js
await cero.del(room.members, memberId) // removed, and the room has a new key
await cero.rotate(room) // { epoch }: a new key at any other time
```

A removal by an admin or the owner rotates the handle's key in the same step: when `cero.del`
resolves the key is in place, and the removed member reads nothing written after it. `cero.rotate`
rotates it at any other time. It needs the remove permission, `REFUSED` otherwise, and cannot run
inside a transaction: `cero.rotate(tx)` throws `INVALID`. [How it works](how-it-works.md) has the
mechanism.

## Leave a handle

```js
await cero.leave(room) // its row reads leaving, then is gone on every device
```

`cero.leave` writes `leaving` on the handle's row. Every device of yours seated in the handle
carries it: it takes you out of the handle's members, at any role, waits until another device or a
mirror holds that, then deletes the row, keeps none of the handle's keys and closes it. An app
closed on the way goes on at its next launch. Removed by someone else, the row reads `removed`, with
the remover's id in `by`. A removal, and a join that ended `denied` or `expired`, stays 30 days so
the app can show why, then goes at a launch; a cancelled join goes at a launch of the device that asked once the room holds the cancel, 30 days at most, and a leave
leaves no row. The app deletes an ended row whenever it likes, with `cero.del(me.room, id)`, and a
new code joins again; a row still `in`, `leaving`, `asking` or `joining` is `REFUSED`. The last
owner of a handle others are in gets `INVALID` from `cero.leave`, and nothing is written: make
another member an owner first, with `cero.set(room.members, { id, role: 'owner' })`. Leaving is yours, not a removal: a code minted
after you left brings you back; an older one, or the handle's reusable one, puts you in
`room.requests` until a member accepts or denies you, so leaving first never dodges a removal. The
handle still rotates its key, sealing you out. Removed by someone else, only a code minted after the removal does.

`cero.close(room)` lets go of a handle on this device and keeps it in your list, to reopen by id.
A device opens a handle once and counts who holds it: every `open`
(by id, name or code) holds it once and every `cero.close` lets go once. The last close ends every
`watch` its holders started, and it stays open, so a reopen gets it as it is. A watch a `'handle'`
listener starts as it runs, as an extension's does, follows the handle for as long as it is open. A
device keeps `keepOpen` of them, 16 by default; one more closes the least recently used. Leaving, a
removal and `cero.close(me)` close it at once. Over RPC, the page's holds end when it reloads.

## List your handles

```js
const { data: rooms } = await cero.get(me.room) // the rooms you are in
// [{ id, type: 'room', name, key, encryptionKey, state: 'in', createdAt, updatedAt }]
const { data: denied } = await cero.get(me.room, { state: 'denied' }) // joins turned away
const { data: row } = await cero.get(me.room, id) // one room, whatever its state

await cero.activate(room) // the room on screen syncs first
```

A list of rooms is the rooms you are in. Name a `state` to list the others: `asking` and `joining`
for joins on their way, `leaving`, `removed`, `denied` or `expired`. A room read by its id comes
whatever its state.
`encryptionKey` is the handle's secret: never log it or send it anywhere. `cero.watch(me.room)`
follows the list, a joined handle once you are in. [Network](network.md) covers `cero.activate`.

## Next

- [Your devices](identity.md) to be the same member on every device.
- [Network](network.md) to sync through mirrors, over Bluetooth, and across many handles.
- [How it works](how-it-works.md) for what happens on join, removal and rotation.
