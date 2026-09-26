# Errors

[Docs](README.md) · Previous: [API reference](api.md) · Next: [Core primitives](core.md)

Every code Cero and Core throw, when you see it, and what to do.

```js
import { cero } from '@cero-base/cero'

// me from cero()
try {
  await cero.put(me.todos, { nope: 1 })
} catch (err) {
  err.code // 'INVALID': todos has no field nope
}
```

## Match on the code

- In process, every error Cero throws is a `CeroError` (from `@cero-base/core/errors`). It carries `err.code`, the same code at the start of `err.message`, and `err.isCeroError`; `CeroError.isCeroError(err)` is a guard that works across realms. `DENIED` adds `err.reason` and `REFUSED` adds `err.rule`.
- Across RPC, in a UI on `@cero-base/cero/client`, an error keeps its `code` and `message`, and a denied join its `reason`. Match `err.code` everywhere: `err.rule` and `isCeroError` are for code in the worker.

## Codes

| Code               | You see it when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Do                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `REQUIRED`         | `spec` is missing in `cero()`, `peek()` or `serve()`, `seed` in `restore()`, `storage` in `serve()`. In Core: a primitive's `store`, `identity`, `network` or `mailbox`.                                                                                                                                                                                                                                                                                                                                                                                                                     | Pass it.                                                       |
| `INVALID`          | An argument or call failed a check, named in the message: a missing `dir`, a field the schema does not declare, a row missing a required field, an action with no `after` hook, `cero.invite` or `cero.leave` on the root, the last owner leaving a room others are in, `suspend` or `resume` on a room, `nearby` without `bluetooth`, a `tx` fn that takes no argument, `rotate` inside `tx`, `cero()` without the extension list the spec was built with, a phrase that is not BIP-39, an invite role that is not a role or a reusable one above member, `accept` above the invite's role. | Fix the call.                                                  |
| `CLOSED`           | A call on a closed context. A join waiting in `cero.open` when you cancel it, or when `me` closes: one you did not cancel resumes on the next open.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Reopen, or wait for the join to land.                          |
| `CHANNEL_MISMATCH` | `dir` keeps the first channel it is opened with, and this open passes another, or none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Open with its channel, or use another `dir`.                   |
| `NOT_READY`        | Core only: a call before `await x.ready()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Await `ready()` first.                                         |
| `CONFLICT`         | A core on this device forked, usually because a data dir was copied to another machine. It reaches `onerror`; nothing resyncs.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Stop using the copy. A second device starts from the phrase.   |
| `DESTROYED`        | Core only: a call on a destroyed `Discovery`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Join the topic again.                                          |
| `UNKNOWN`          | A name the spec does not have (a ref, a handle type, an action), a room id not in your list, a request already settled or not seen yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Check the name against the built spec, or read the list again. |
| `NOT_WRITABLE`     | This device cannot write here: a reader, a removed member, or a join not let in yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Show the room read-only.                                       |
| `TIMEOUT`          | Recovery from the phrase, or `restore`, found no device of yours within `recoveryTimeout`. A join was not answered within 30 s: it goes on. A room opened by id for the first time on this device while none of the room's devices is online.                                                                                                                                                                                                                                                                                                                                                | Retry when another device is online. A join lands on its own.  |
| `UNSUPPORTED`      | Over RPC: opening or joining a room from inside a room.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Open rooms from `me`.                                          |
| `INVALID_INVITE`   | The invite string does not parse: bad z32, a bad envelope, an unknown version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Ask for a fresh one.                                           |
| `EXPIRED`          | The invite is past its `ttl`: joining with it, or `cero.accept` on a request it brought.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Ask for, or mint, a fresh one.                                 |
| `DENIED`           | A member turned your join away, with their `err.reason`. Or your role falls short: an invite above your own role, `revoke` without the remove permission.                                                                                                                                                                                                                                                                                                                                                                                                                                    | Tell the user; nothing to retry.                               |
| `REFUSED`          | A rule refused your write, on every peer, and its whole batch is dropped. `err.rule`, in process: `'write'` your role cannot write, `'own'` another member's row, `'hook'` a hook said no, `'assign'` a role beyond your rank, `'remove'` a member you do not outrank, or `'invite'`, `'rotate'`, `'member'`, `'device'`, `'request'`.                                                                                                                                                                                                                                                       | Show it as not allowed.                                        |
| `NETWORK_ERROR`    | Writing or announcing a join failed. The join has ended.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Call `cero.open` again.                                        |
| `UNKNOWN_EPOCH`    | Handled inside the room. A removed member may see it on `onerror`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Ignore it.                                                     |

## Joining

```js
import { cero } from '@cero-base/cero/client'

// in the UI: me from cero(ipc, spec), invite pasted by the user, toast is yours
try {
  return await cero.open(me.room, { invite })
} catch (err) {
  if (err.code === 'INVALID_INVITE') toast('That is not an invite')
  else if (err.code === 'EXPIRED') toast('This invite has expired, ask for a new one')
  else if (err.code === 'DENIED') toast('You were not let in')
  else if (err.code === 'TIMEOUT')
    toast('Waiting for a member to let you in') // it goes on
  else if (err.code === 'NETWORK_ERROR') toast('Could not send the join, try again')
  else throw err
}
```

A join that timed out lands on its own: the room appears in `cero.watch(me.room)`, and `me.joins` lists it until then.

## Writing

```js
// room from cero.open, text from your form, readOnly and toast are yours
try {
  await cero.put(room.messages, { text })
} catch (err) {
  if (err.code === 'NOT_WRITABLE') return readOnly() // a reader, or removed
  if (err.code === 'REFUSED') return toast('Not allowed here') // err.rule in process only
  throw err
}
```

## Background errors

Your calls reject to you. What Cero does on its own (replication, pairing, mirroring, a suspend step, a join nobody waits on any more) goes to `onerror`, and without one it prints.

```js
// dir and spec as in the Quickstart, toast is yours
const me = await cero(dir, spec, { onerror: (err) => toast(err.message) })
```

A split app is the same: the worker sends its background errors to every connected client, whose `onerror` gets `code`, `message`, `stack` and a denied join's `reason`. The worker's own `onerror` runs only while no client is connected.

```js
import { cero } from '@cero-base/cero/client'

// ipc and spec from your worker setup, see Apps
const me = await cero(ipc, spec, {
  onerror: (err) => {
    if (err.code === 'UNKNOWN_EPOCH') return // safe to ignore
    toast(err.message)
  }
})
```

`cero.close(me)` still rejects when a step fails, but only after every step ran, so the storage lock is never left held.

## Next

- [API reference](api.md): which call throws what.
- [Core primitives](core.md): where most of these codes start.
- [Apps](apps.md): the worker and the UI, where errors cross.
