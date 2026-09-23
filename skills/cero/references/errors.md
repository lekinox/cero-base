# Errors

```js
try {
  await cero.put(me.todos, { nope: 1 })
} catch (err) {
  err.code // 'INVALID'
}
```

Every error cero throws is a `CeroError`. Match on `err.code`, never on the message.

The code is stable and prefixed to `err.message`, so a log line identifies itself.
`err.isCeroError` is always `true` and `CeroError.isCeroError(err)` is the same
check as a static guard. Use either instead of `instanceof`, which does not
survive a realm boundary. `err.name` is `'CeroError'`. The class is exported from
`@cero-base/core/errors`.

| Code               | You see it when                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `REQUIRED`         | A required argument is missing: `dir`, `spec`, `store`, `identity`, `network`, `mailbox`.                                          |
| `INVALID`          | An argument or state failed validation. The message names the rule.                                                                |
| `CLOSED`           | An operation ran on a closed resource: a `Database`, `Storage`, `Network`, `Pairing` or `Blobs`.                                   |
| `CHANNEL_MISMATCH` | A channel-stamped storage was reopened under a different channel, including none. The stored channel is not named.                 |
| `NOT_READY`        | An operation ran before `await resource.ready()`.                                                                                  |
| `CONFLICT`         | The operation raced an existing state.                                                                                             |
| `DESTROYED`        | An operation ran on a destroyed `Discovery`. Join again for a new one.                                                             |
| `UNKNOWN`          | A typed lookup failed: an unknown ref name, handle type or collection. Check it against the built spec.                            |
| `NOT_WRITABLE`     | A write, or `cero.rotate`, ran where this device is not a writer yet.                                                              |
| `TIMEOUT`          | A bounded wait elapsed: `whenWritable`, a phrase recovery with no reachable device, or a join no member answered yet (it goes on). |
| `UNSUPPORTED`      | The feature is not implemented yet. Nothing to do.                                                                                 |
| `INVALID_INVITE`   | An invite failed to parse: bad z32, bad envelope, unknown version. Ask for a fresh one.                                            |
| `EXPIRED`          | An invite is past its `ttl`, on either side of the handshake.                                                                      |
| `DENIED`           | The host refused the join, or the call needs a permission you lack. `err.reason` holds the host's reason, or `null`.               |
| `REFUSED`          | An apply-time rule refused the op. `err.rule` names it, for example `'write'`, `'own'` or `'rotate'`.                              |
| `NETWORK_ERROR`    | A swarm or transport failure. Retry. It is not a host decision, so do not report it as a denial.                                   |
| `UNKNOWN_EPOCH`    | A block references a rotation epoch this peer has not learned. It clears when the announcement syncs in.                           |

```js
try {
  await cero.open(me.room, { invite })
} catch (err) {
  switch (err.code) {
    case 'INVALID_INVITE':
      return toast('Bad invite')
    case 'EXPIRED':
      return toast('This invite has expired')
    case 'DENIED':
      return toast(err.reason || 'Denied')
    case 'TIMEOUT':
      return toast('Waiting for a member to answer') // the join goes on
    default:
      throw err
  }
}
```

A `REFUSED` aborts the writer's whole batch, which is what makes `tx` atomic.

## Background errors

Calls you make reject to you. Work cero does on its own, replication, pairing,
mirroring, a suspend step, a join nobody waits on any more, reports through one
handler instead.

```js
const me = await cero(dir, spec, { onerror: (err) => toast(err.message) })
```

Without `onerror`, the root emits `error`, and prints when nobody listens either.

```js
me.on('error', (err) => {
  if (err.code === 'CONFLICT') return showBanner('A device diverged, resyncing')
  toast(err.message)
})
```

A split app is the same: the worker forwards its background errors to every
connected client, and the client emits `error` with the message, code and stack.
The worker's own `onerror` only runs while no client is connected.

`close()` still rejects when a step fails, but every step has run first, so the
storage lock is never left held.

## Next

- Core primitives, for the layer most of these codes come from.
- [Data](data.md), for the writes that raise `INVALID` and `REFUSED`.
