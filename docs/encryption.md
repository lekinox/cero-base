# Encryption

[Docs](README.md) · Previous: [Core primitives](core.md) · Next: [Tools](tools.md)

```js
await cero.del(room.members, memberId) // they can no longer write
await cero.rotate(room) // they can no longer read what follows
```

Every handle is encrypted with its own key, handed to members when they join. Removing a member takes their pen away. Rotating takes the key.

## Why rotate

```js
const { epoch } = await cero.rotate(room) // admin or owner
```

A handle is an append-only log that mirrors and peers ship around as ciphertext. Whoever holds the key reads it. Removing a member revokes their writer, but the key they received at join time stays in their pocket, so without rotation they keep reading everything written after their removal.

`cero.rotate(room)` mints a fresh secret, seals one copy to every current member and announces it through the log. Everything after the announcement, rows and files, is written under the new key. The removed member reads up to the cut and nothing after. Members who stay, and members who join later, read one continuous history.

## Epochs

```js
room.store.on('update', () => {}) // a new epoch applies like any other op
```

Each rotation starts an epoch. A block header carries the epoch it was written under, so a reader picks the right key per block and linearization can reorder freely. Members learn a new epoch from the announcement, in which their copy of the secret is sealed to their identity key, and store it locally. A block whose epoch a peer has not learned yet raises `UNKNOWN_EPOCH` until the announcement syncs in.

`rotate` needs the remove permission, so admins and owners. It returns `{ epoch }`.

## Self-healing

```js
await cero.rotate(room) // once
await cero.del(room.members, memberId) // from now on this re-keys by itself
```

Rotation is opt-in per handle. Once a handle has rotated at least once, later removals re-key on their own: any online admin device notices the current epoch's recipients differ from the member list and rotates. A `del` alone is enough from then on. Rotating without a removal is valid too, as periodic key hygiene.

## What a removed member sees

```js
room.store.on('unwritable', () => showRemoved()) // fires on the removed device
```

The removal lands before the new key, so a removed member always receives it: their store emits `unwritable`, reads freeze at that point and writes reject with `NOT_WRITABLE`. Their streams stay open and go silent.

## Next

- [Tools](tools.md) to watch epochs and replication from another process.
- [Handles](handles.md) for the removal itself.
