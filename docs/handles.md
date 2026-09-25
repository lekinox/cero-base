# Sharing

[Docs](README.md) · Previous: [Data](data.md) · Next: [Your devices](identity.md)

Open rooms, invite people into them, confirm who joins, give them roles and remove them.

```js
// me from the quickstart; the schema declares room: { messages: t.collection({ text: t.string }) }
const room = await cero.open(me.room, { name: 'general' })
const invite = await cero.invite(room) // a string: send it any way you like

// on a friend's device, with their own me
const joined = await cero.open(me.room, invite)
await cero.put(joined.messages, { text: 'hi, I am in' })
```

A room is a space you share: its own data, its own members (the people in it) and its own key.
`me.room` exists because the schema declares a `room` type as a nested object; call it a team, a
project or a chat. `me` and every room are contexts you pass to `cero.*`: they have no methods, and
refs such as `room.messages` hang off them.

## Open a room

```js
const room = await cero.open(me.room, { name: 'general' }) // create it: you are its owner
const again = await cero.open(me.room, { id: room.id }) // reopen one from your list
const joined = await cero.open(me.room, { invite }) // join: invite is a string someone sent you
```

`{ name }`, or nothing, creates a room. `{ id }` reopens one: an id not in your list throws
`UNKNOWN`, the id of another type's room `INVALID`. An invite string, bare or as `{ invite }`, joins.
Rooms are isolated: `me.messages` and `room.messages` are different collections, and one room's key
never opens another.

## Invite someone

An invite is a string that lets its holder join one room.

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
`INVALID`; a role above your own throws `DENIED`. Only rooms have invites: `cero.invite(me)` throws
`INVALID`.

```js
import b4a from 'b4a'
import { Invite } from '@cero-base/core/invite' // add @cero-base/core to your dependencies

const code = await cero.invite(room, { data: b4a.from('from ana') })
Invite.parse(code).data // on the joiner's side, before joining
```

Any device whose member can invite (member, admin, owner, never a reader) answers joins while online,
not only the one that minted the invite. Cero reopens rooms with live invites at boot, so the app
need not have the room open.

## Revoke an invite

```js
await cero.revoke(room, code) // true the first time, false afterwards
```

Keep the invite string: `cero.revoke` takes it, and the rows in `room.invites` keep only a hex id.
Revoking needs the remove permission (admin or owner), `DENIED` otherwise, and drops the joins still
waiting on a `confirm` invite. An invite outlives its minter: it works until revoked, expired or
spent.

## Join a room

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
member answers, the room appears in `me.room`, so watch that list. An expired invite rejects
`EXPIRED` at once, a string that is not an invite `INVALID_INVITE`.

```js
const { data: joins } = await cero.get(me.joins) // [{ id, type, invite }], still waiting
await cero.cancel(me, invite) // give up for good: true when it cancelled one
```

A join on a revoked or spent invite gets no answer: it waits until the invite's ttl, or for good
without one, so cancel it. A second joiner on a single-use invite is ignored. An invite to a room you
already have returns that room; a newer invite to the same room takes over. Once nobody waits on a
join, a denial or expiry reaches `onerror`.

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
  if (err.code === 'DENIED') tell('the room said no')
  if (err.code === 'TIMEOUT') tell('waiting for a member to accept')
}
```

- `hid.encode(request.identity)`, from `hypercore-id-encoding`, is the id their member row will have.
  `room.requests` also holds admitted joins until their keys are delivered (`admitted: true`), hence
  the `{ admitted: false }` filter.
- `cero.accept(room, request)` admits at the invite's role, `{ role: 'reader' }` at a lower one.
  `cero.deny(room, request, reason)` turns the joiner away. The first answer settles the request for
  everyone, and it survives restarts.
- Both reject `UNKNOWN` when another member settled the request, or this device cannot invite.
  `accept` also rejects `EXPIRED` past the invite's ttl, `INVALID` for a role above the invite's and
  `REFUSED` for one above your own.
- On the joiner's side an answer after 30 s arrives as `TIMEOUT` first: an accept adds the room to
  `me.room`, a later `DENIED` reaches `onerror`. The reason reaches an in-process joiner as
  `err.reason`; over RPC only `code` and `message` cross, so a UI gets `DENIED` with no reason.

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
`@cero-base/core/utils` checks a rank in your UI.

## Remove a member

```js
await cero.del(room.members, memberId) // the member and every device of theirs
await cero.del(room.devices, deviceId) // one device, the member stays: an id from room.devices
```

Removing needs the remove permission and a higher rank: removing an equal or higher rank rejects
`REFUSED`. Anyone may remove themselves. The removed member's `room.status` shows `role: null`, and
they come back only through an invite minted after the removal.

## Remove and re-key

```js
await cero.del(room.members, memberId)
await cero.rotate(room) // { epoch }: the room has a new key
```

A removal re-keys the room shortly after on its own, on a device that can remove, so the removed
member reads nothing written after it. `cero.rotate` re-keys at once: await it before writing
something they must not see. It needs the remove permission, `REFUSED` otherwise, and cannot run
inside a transaction: `cero.rotate(tx)` throws `INVALID`. [How it works](how-it-works.md) has the
mechanism.

## Leave a room

```js
await cero.del(room.members, me.id) // leave for everyone: you leave the member list
await cero.leave(room) // gone from your list on every device of yours, and closed here
```

`cero.leave` alone keeps you a member: the room leaves your list, not the room's. `cero.close(room)`
stops it on this device and keeps it in your list, to reopen by id. `cero.close(me)` closes
everything.

## List your rooms

```js
const { data: rooms } = await cero.get(me.room)
// [{ id, type: 'room', name, key, encryptionKey, createdAt, updatedAt }]

await cero.activate(room) // the room on screen syncs first
```

`encryptionKey` is the room's secret: never log it or send it anywhere. `cero.watch(me.room)` follows
the list, joined rooms included. [Network](network.md) covers `cero.activate`.

## Next

- [Your devices](identity.md) to be the same member on every device.
- [Network](network.md) to sync through mirrors, over Bluetooth, and across many rooms.
- [How it works](how-it-works.md) for what happens on join, removal and re-key.
