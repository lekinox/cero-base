# Tools

[Docs](README.md) · Previous: [Encryption](encryption.md)

```sh
npm install @cero-base/tools
```

```js
import { cero } from '@cero-base/cero'
import { devtools, loopback } from '@cero-base/tools'

cero.use(devtools({ transport: loopback({ port: 9111 }) }))
const me = await cero('./data', spec)
```

`@cero-base/tools` taps a running instance from another process: its rows, its ops as they apply, and its network and replication stats. The tap uses a local pipe, never the app's swarm, so what you measure is what the app does without it.

## Attach

```js
cero.use(
  devtools({
    transport: loopback({ port: 9111 }),
    redact: { fields: ['profile.apiKey'] }
  })
)
```

`devtools(opts)` is an extension. Register it before `cero()` and it follows the root handle and every child.

| Option           | Default | Meaning                                                                    |
| ---------------- | ------- | -------------------------------------------------------------------------- |
| `transport`      | -       | Where consumers connect. `loopback({ port })` listens on localhost.        |
| `token`          | random  | Every connection must present it. Printed in the banner. `false` disables. |
| `redact`         | -       | Masks fields in rows and events. `{}` masks seed, secret, token and alike. |
| `bufferSize`     | `1000`  | Events kept for a late consumer.                                           |
| `sampleInterval` | `1000`  | Stats sampling, in ms.                                                     |

Keep it out of production builds. It is read-only, and identity secrets are not reachable through it, but it is a development tool.

## Connect

```sh
cero-tools 9111 --token <token> messages members
```

The CLI prints the handle tree and the state of each ref, then tails events and stats. The same from code:

```js
import { connect, dial } from '@cero-base/tools'

const session = await connect(dial({ port: 9111 }))
await session.handles() // [{ id, type }]
await session.get('messages') // { data, total, size }
session.events() // Readable of { op, name, row, writerKey, seq }, local and remote
session.stats() // Readable of { network, bee, cores }
session.close()
```

## Next

- [Data](data.md) for the operators the session reuses.
- [Docs index](README.md) to start over from the top.
