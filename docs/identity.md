# Identity

[Docs](README.md) · Previous: [Handles](handles.md) · Next: [Apps](apps.md)

```js
// first device
const me = await cero('./data', spec)
const phrase = me.identity.toPhrase() // show it once, then forget it

// second device, nothing but the phrase
const me = await cero('./data', spec, { phrase })
```

You are your phrase. Every device of yours derives the same identity from it.

## The phrase

```js
me.identity.toPhrase() // 'apple brave cider ...'
const me = await cero('./data', spec, { words: 24 }) // a longer phrase for a new identity
```

An identity is 16 or 32 bytes of entropy, written as a BIP-39 mnemonic of 12 or
24 words. From that entropy cero derives a signing keypair, an encryption key,
the canonical id `me.id` and the swarm topic the identity announces on.
Derivation is deterministic, so the same phrase always gives the same identity.
Pass `{ words: 24 }` to `cero()` to generate a longer one.

## The first device

```js
import { cero, peek } from '@cero-base/cero'

if (!(await peek('./data', spec))) {
  const me = await cero('./data', spec, { name: 'laptop' })
  showOnce(me.identity.toPhrase())
}
```

`cero(dir, spec)` with no identity option generates a fresh identity and stores
its seed in the local, per-device store. That is the only way an identity is
created.

Show `me.identity.toPhrase()` once, when the user first opens the app, and make
it their job to keep it. cero never sends it anywhere. Over RPC it is not part
of `init` either: the client fetches it on demand with
`await me.identity.toPhrase()`, so an app that never shows it never pulls it
into UI memory.

## A second device

A device of yours joins by phrase. Invites are for rooms and other people, never
for your own devices.

```js
const phone = await cero('./phone-data', spec, { phrase, name: 'phone' })

phone.id === laptop.id // same identity
phone.store.key.equals(laptop.store.key) // same database
phone.store.writerKey.equals(laptop.store.writerKey) // false, its own writer core
```

What happens underneath:

1. The phrase derives the identity, so the device knows the identity keypair.
2. The device that created the identity wrote one block into a small pointer
   core, signed by the identity key, holding the root database key.
3. The new device derives that pointer core's key from the phrase and reads the
   block from whichever device is reachable.
4. It opens that database and mints its own writer core. A device is the only
   author of its own writer core, ever.
5. It admits itself with an `add-writer` signed by the identity, which only the
   phrase can produce.

Nothing here needs a flag. A supplied phrase or seed on a device with no stored
writer means recover. A supplied phrase never creates an identity.

Afterwards there is one member row for the identity and one device row per
machine, and writes converge in both directions. Rooms follow through the root:
each room's row replicates in `handles`, so the new device opens it by id, mints
a per-room keypair, claims writer capability and reads every era.

## When no device is reachable

```js
try {
  await cero('./data', spec, { phrase, recoveryTimeout: 10_000 })
} catch (err) {
  if (err.code === 'TIMED_OUT') tell('none of your devices is online')
}
```

Recovery needs another device of the identity to be online, or a
[mirror](network.md) holding the data. `recoveryTimeout` bounds the wait for the
pointer, the backfill and the writer admission, and defaults to 30000 ms. When
nothing answers, the open rejects with `TIMED_OUT`.

A failed open closes everything it had opened, so the storage lock is not leaked
and a retry on the same directory works.

## `restore(me, phrase)`

`restore` swaps a running instance to a different identity. It closes the
instance, deletes the `main/` tree under its directory and reopens with the
phrase, which recovers.

```js
import { cero, restore } from '@cero-base/cero'

let me = await cero('./data', spec)
me = await restore(me, phrase)
```

Prior data in that directory is gone. Every other option carries forward,
`channel` above all: without it the recovered instance would announce on the
global topic and never meet its peers. A phrase that is already the running
identity makes `restore` a no-op.

## `peek(dir, spec)`

`peek` reports whether a directory already holds an identity, without opening
the instance. Use it to tell a first run from a returning one before you boot.

```js
import { peek } from '@cero-base/cero'

await peek('./data', spec) // false on a fresh dir, true once cero() has run
```

## `storageKey`

```js
const storageKey = await keychain.get('cero') // 32 bytes you keep
const me = await cero('./data', spec, { storageKey })
```

The seed and the device keypairs live in the local store under `dir/main`, which
cero chmods to `0700` on open. Pass a 32-byte `storageKey` to `cero()` to
encrypt that key material at rest. cero never stores the key: source it from the
OS keychain, and pass the same one to reopen.

## Next

- [Apps](apps.md) to run cero in a worker and keep the phrase out of the UI.
- [Handles](handles.md) for the other kind of joining, by invite.
- [Network](network.md) for mirrors, which keep recovery working when no device is online.
