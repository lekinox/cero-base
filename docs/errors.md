# Errors

[Docs](README.md) · Previous: [API reference](api.md) · Next: [Core primitives](core.md)

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

| Code               | You see it when                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `REQUIRED`         | A required argument is missing: `dir`, `spec`, `store`, `identity`, `network`, `userData`.                            |
| `INVALID`          | An argument or state failed validation. The message names the rule.                                                   |
| `CLOSED`           | An operation ran on a closed resource: a `Database`, `Storage`, `Network`, `Pairing` or `Blobs`.                      |
| `CHANNEL_MISMATCH` | A channel-stamped storage was reopened under a different channel, including none. The stored channel is not named.    |
| `NOT_READY`        | An operation ran before `await resource.ready()`.                                                                     |
| `CONFLICT`         | The operation raced an existing state, for example an RPC server asked to initialise twice.                           |
| `DESTROYED`        | An operation ran on a destroyed `Discovery`. Join again for a new one.                                                |
| `UNKNOWN`          | A typed lookup failed: an unknown ref name, handle type or collection. Check it against the built spec.               |
| `NOT_WRITABLE`     | A write, or `cero.rotate`, ran where this device is not a writer yet.                                                 |
| `TIMED_OUT`        | A bounded wait elapsed: `whenWritable`, or a phrase recovery that found no reachable device inside `recoveryTimeout`. |
| `UNSUPPORTED`      | The feature is not implemented yet. Nothing to do.                                                                    |
| `INVALID_INVITE`   | An invite failed to parse or verify: bad z32, bad envelope, unknown version, bad signature. Ask for a fresh one.      |
| `EXPIRED`          | An invite is past its `expiresIn`, on either side of the handshake.                                                   |
| `DENIED`           | The host refused the join, or the call needs a permission you lack. `err.reason` holds the host's reason, or `null`.  |
| `REFUSED`          | An apply-time rule refused the op. `err.rule` names it, for example `'write'`, `'own'` or `'rotate'`.                 |
| `TIMEOUT`          | A pairing handshake did not complete in time. Check the host is online, then retry.                                   |
| `NETWORK_ERROR`    | A swarm or transport failure. Retry. It is not a host decision, so do not report it as a denial.                      |
| `UNKNOWN_EPOCH`    | A block references a rotation epoch this peer has not learned. It clears when the announcement syncs in.              |

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
      return retry()
    default:
      throw err
  }
}
```

`TIMED_OUT` and `TIMEOUT` are different codes. `TIMED_OUT` comes from database and
recovery deadlines, `TIMEOUT` from the pairing handshake.

A `REFUSED` aborts the writer's whole batch, which is what makes `tx` atomic.

## Next

- [Core primitives](core.md), for the layer most of these codes come from.
- [Data](data.md), for the writes that raise `INVALID` and `REFUSED`.
