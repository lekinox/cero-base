# @cero-base/tools

Passive devtools for [cero](https://www.npmjs.com/package/@cero-base/cero) — observe a running instance's **data**, its **event log**, and its **p2p/replication stats** from another process, without ever touching the swarm it measures.

A `devtools()` extension taps the instance over a **local out-of-band pipe** (never the app's hyperswarm), so connection counts, core lengths, and replication numbers stay exactly as they'd be with no devtools attached. Read-only by construction; identity secrets are structurally unreachable.

## Install

```sh
npm install @cero-base/tools
```

## Agent side — attach the tap

```js
import { cero } from '@cero-base/cero'
import { devtools, loopback } from '@cero-base/tools'

const me = await cero('./data', spec, {
  extensions: [...spec.extensions, devtools({ transport: loopback({ port: 9111 }) })]
})
// ...then create your instance as usual; the tap follows it and every child handle.
```

`devtools(opts)`:

| opt              | default | meaning                                                                              |
| ---------------- | ------- | ------------------------------------------------------------------------------------ |
| `transport`      | —       | a `{ accept(handler) }` source of consumer connections (use `loopback({ port })`)    |
| `bufferSize`     | `1000`  | event ring buffer size (drop-oldest)                                                 |
| `sampleInterval` | `1000`  | stats sampling interval (ms)                                                         |
| `redact`         | —       | a `(ref, row) => row` masker, or a config `{ fields, match, deny }` (see Redaction)  |
| `token`          | random  | auth token gating the tap — printed in the startup banner; `false` disables the gate |

Zero footprint when not registered; all cleanup is bound to the root handle's `close`.

Any local process can dial the loopback port, so the tap requires a per-run token: the first
frame of a connection must carry it or the connection is dropped. The banner prints the exact
`cero-tools <port> --token <token>` command. Keep devtools out of production builds regardless —
the tap is a development tool.

## Consumer side — connect

```js
import { connect, dial } from '@cero-base/tools'

const session = await connect(dial({ port: 9111 }))

await session.handles() // [{ id, type }, ...] — root + open children
await session.get('messages') // { data, total, size } — reuses cero's read operators
session.watch('messages') // Readable of live snapshots
session.events() // Readable of { op, name, row, writerKey, seq } — local AND remote
session.stats() // Readable of { network, bee, cores }
session.close()
```

## CLI

```sh
cero-tools <port> --token <token> [refs...]
# prints the handle tree + state for each ref, then tails events + stats until Ctrl-C
```

## Redaction

App rows can hold anything, so `devtools({ redact })` masks matched fields in both snapshots and events — content hidden, shape kept (`‹redacted:bytes(32)›`):

```js
devtools({ redact: {} }) // default denylist: seed/secret/token/private/...
devtools({ redact: { fields: ['profile.apiKey'] } })
devtools({ redact: { match: (key) => key.endsWith('Secret') } })
```

The default is a **denylist by field name** — a secret stored under an off-list name (`otp`,
`recoveryCode`, …) transits unmasked. Add such fields via `fields`/`match`, or pass your own
`(ref, row) => row` masker for allowlist semantics.

Identity credentials (the seed and keypairs) need no redaction: they're `local` builtins and the inspection surface only serves declared `meta.refs`, so they're never reachable.

## API

`devtools(opts)` · `serve(stream, me, opts)` · `connect(stream)` · `stats(handle)` · `redact(config)` · `loopback(opts)` · `dial(opts)`

## Status

MVP: local-pipe transport, `get`/`watch` + events + sampled stats, redaction, a CLI. Deferred to later phases: a whitelisted swarm transport, a read-only replication / time-travel plane, and an MCP/UI consumer.

## License

Apache-2.0
