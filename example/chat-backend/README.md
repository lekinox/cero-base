# chat-backend

Shared cero schema + `serve` / `connect` helpers used by every chat example (`chat-terminal`, `chat-desktop`, `chat-mobile`).

## Schema

```js
import { schema, t } from '@cero-base/cero'

export default schema({
  profile: t.single({ name: t.string }),

  room: {
    profile: t.single({ name: t.string }),
    messages: t.collection({ text: t.string })
  }
})
```

`room` is a child handle (its own autobee). Members + invites come from cero's builtins (`room.members`, `room.invites`). `text` is the only user field — the apply layer stamps `memberId` automatically.

## Build the compiled spec

```sh
npm run build
```

Generates `./spec/` (hyperschema, hyperdb, hyperdispatch, hrpc). Re-run whenever the schema changes.

## Boot a backend

```js
import { serve } from 'chat-backend/server'

const me = await serve(ipc, { storage: './data', name: 'alice' })
```

`serve` boots cero with the chat schema as soon as it is called and serves it over the given duplex stream (`ipc`). It returns the server; the root lives in the worker.

### Seed lifecycle

`serve` forwards any extra options straight to `cero()`; cero — not `serve` — owns the identity, persisting it in the on-disk `local` store under `${storage}`:

- First launch: cero generates a fresh identity and stores its seed in the local `master` row.
- Subsequent launches: re-opening the same `${storage}` dir loads that stored identity back — no phrase needed.
- Recovery: the UI's `connect(ipc, { phrase })` restores from a phrase; the worker turns it into the seed. In process, `cero(dir, spec, { seed: cero.toSeed(phrase) })`.

## Connect a client

```js
import { cero } from '@cero-base/cero/client'
import { connect } from 'chat-backend/client'

const me = await connect(ipc) // the UI's root, the same shape as the worker's
const room = await cero.open(me.room, { name: 'general' })
await cero.put(room.messages, { text: 'hello' })
const inv = await cero.invite(room)
```

Every verb works on the client as it does in the worker. `before`, `after` and `tx` take functions, so they stay in the worker.

## Tests

```sh
npm test
```
