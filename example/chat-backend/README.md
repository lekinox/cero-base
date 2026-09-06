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

`serve` boots cero with the chat schema and wires the HRPC server to the given duplex stream (`ipc`). Returns the HRPC server instance (`cero/server`'s `Server`), not a handle — the root cero is created lazily inside it on the client's first `init` and stays server-side.

### Seed lifecycle

`serve` forwards any extra options straight to `cero()`; cero — not `serve` — owns the identity, persisting it in the on-disk `local` store under `${storage}`:

- First launch: cero generates a fresh identity and stores its seed in the local `master` row.
- Subsequent launches: re-opening the same `${storage}` dir loads that stored identity back — no phrase needed.
- Override / recovery: pass `phrase: '<words>'` (or `seed: <bytes>`) through `serve(...)`; cero seeds the identity from it and persists it to the local store. There is no `${storage}/seed` file.

## Connect a client

```js
import { connect } from 'chat-backend/client'

const me = await connect(ipc) // returns a client-side root handle
const room = await open(me.room, { name: 'general' })
await put(room.messages, { text: 'hello' })
const inv = await room.invite()
```

The client handle exposes the same operator surface (`put`, `set`, `get`, `watch`, `del`, `count`, `call`, `open`) plus handle methods (`invite`, `revoke`, `close`, `leave`). `tx` is core-only — it takes a function, so it has no RPC route and is not available on a client handle.

## Tests

```sh
npm test
```
