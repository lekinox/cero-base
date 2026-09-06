# Apps

[Docs](README.md) · Previous: [Identity](identity.md) · Next: [Extensions](extensions.md)

```js
// backend process
import { serve } from '@cero-base/cero/server'
await serve(ipc, spec, { storage: './data' })

// UI process
import { cero } from '@cero-base/cero/client'
const me = await cero(ipc, spec)
await cero.put(me.todos, { text: 'from the UI' })
```

One process owns the data, one owns the screen, one duplex stream between them.
The UI code is the same code.

## On this page

- [Why two processes](#why-two-processes)
- [The backend package](#the-backend-package)
- [serve(ipc, spec, opts)](#serveipc-spec-opts)
- [connect(ipc, spec)](#connectipc-spec)
- [What crosses the wire](#what-crosses-the-wire)
- [use and define on both sides](#use-and-define-on-both-sides)
- [A duplex pair, for tests](#a-duplex-pair-for-tests)
- [Electron and a Bare worker](#electron-and-a-bare-worker)
- [Expo and a Bare worklet](#expo-and-a-bare-worklet)

## Why two processes

```js
import * as cero from '@cero-base/cero/client' // UI code, never '@cero-base/cero'
```

The backend runs the real cero instance. It owns the storage directory, the
swarm, the databases and the blob cores. It needs native modules, so it runs
where native modules can run: a Node process, a Bare worker, or a Bare worklet.

The UI owns no data. It holds a client that mirrors the same API over a duplex
byte stream and forwards every operation to the backend.
`@cero-base/cero/client` never reaches a native addon, which is what makes it
bundleable by Metro for React Native. The rule for UI code follows: import
`@cero-base/cero/client`, never `@cero-base/cero`. A CLI or a test needs no RPC
at all, and `example/chat-terminal` opens cero in-process instead.

## The backend package

Both halves must agree on the built spec, so the schema, the build script and
two thin wrappers live in one package both sides depend on.
`example/chat-backend` is that package.

```text
chat-backend/
  schema.js    cero.schema({ ... })
  build.js     build('./spec', schema), run it after every schema change
  spec/        generated, commit it
  server.js    wraps serve()
  client.js    wraps connect()
```

Both wrappers are three lines each. `server.js` calls
`serve(ipc, spec, { storage, ...opts })`, `client.js` calls
`cero.connect(ipc, spec)`, and each one closes over the same built spec so
neither caller has to import it.

## `serve(ipc, spec, opts)`

```js
import { serve } from '@cero-base/cero/server'

const server = await serve(ipc, spec, {
  storage: './data',
  name: 'laptop',
  channel: 'my-app',
  mirrors: [mirrorKey]
})
server.me // the root handle, once a client has connected
await server.close()
```

Constructs a `Server`, waits for it to be ready and returns it. The root cero
instance is not created here. It is created lazily, inside the server, on the
client's first `init`.

| option      | type                    | default  | meaning                                           |
| ----------- | ----------------------- | -------- | ------------------------------------------------- |
| `storage`   | `string`                | required | Directory passed to `cero()` for the local store. |
| `name`      | `string`                | none     | Display name forwarded to `cero()`.               |
| `bootstrap` | `Array<{ host, port }>` | none     | Custom DHT bootstrap.                             |
| `isMobile`  | `boolean`               | `false`  | Marks this device as mobile.                      |
| `onerror`   | `(err) => void`         | none     | Background-task error handler.                    |

Every other key is forwarded to `cero()` untouched, so `mirrors`, `channel`,
`storageKey`, `phrase`, `seed`, `extensions` and `bluetooth` all work through
`serve`. The identity options belong here, because the backend owns storage.

The `Server` exposes `me` (the real root handle, `null` until `init`), `id`,
`identity`, `handles` and `close()`.

## `connect(ipc, spec)`

```js
import { connect } from '@cero-base/cero/client'

const me = await connect(ipc, spec)
me.id
await me.identity.toPhrase() // async over the wire
await cero.put(me.todos, { text: 'from the UI' })
await me.close()
```

Constructs a `Client`, runs `init` and returns it. The client entry also exports
`cero`, so `cero(ipc, spec)` is `connect(ipc, spec)` and UI code reads like the
in-process code.

It carries `id` (matching `server.id`), `deviceId`, an async
`identity.toPhrase()` that fetches the phrase on demand and never on `init`, one
`Ref` per schema ref, `local.<ref>` for each app-declared local ref, the raw
`rpc` binding as an escape hatch, and `close()`. The refs are real `Ref`
objects, so `cero.open`, `cero.get`, `cero.watch` and the rest work unchanged.

## What crosses the wire

```js
const room = await cero.open(me.room, { invite }) // yes
cero.watch(room.messages).on('data', render) // yes
await room.invite() // yes

cero.before(me.todos, fn) // no: hooks run where the data lives
await cero.open(me.room, { routes }) // no: functions do not serialize
```

`open(ref, arg)` becomes one of three commands and returns a stub the client
wraps in a handle: create, join by invite, or reopen by id. The server keeps the
live handle in its map, and every later call carries its id. Nesting is refused,
only the root may be a parent. A client handle carries the same operator surface
plus `invite()`, `revoke()`, `rotate()`, `close()` and `leave()`, and both
`close` and `leave` end every stream bound to that handle.

`watch` and `changes` arrive as plain streamx readables. Snapshots are
idempotent, so a slow wire keeps only the newest. Deltas are not, so the server
holds the iteration instead and loses nothing.

Three things do not cross. `before`, `after` and `peek` hook the local write
path or probe a local directory, and a proxy has neither. `routes`, and any
other function passed as an option, cannot be serialized: register those on the
backend. Error classes stay put too, only codes cross on the rejection message,
so match on the code and not on `instanceof`.

## `use` and `define` on both sides

An extension's schema is folded in at build time and its `setup` runs inside
`cero()`, so `cero.use` belongs in `build.js` and in the backend entry. The UI
process registers nothing: the client has no `use`.

`define` is different. A custom operator is a plain function composed from the
operators, and its body runs in the process that calls it, so register the same
map in both processes and either side can call them.

```js
cero.define({
  user: { rename: (h, name) => cero.set(h.profile, { name }) },
  room: { note: { add: (h, text) => cero.put(h.notes, { text }) } }
})

await me.user.rename('Remote') // works on a client and on a local handle
```

## A duplex pair, for tests

Any duplex works. The tests wire the two halves in memory.

```js
import { Duplex } from 'streamx'

let a, b
a = new Duplex({
  write(data, cb) {
    b.push(data)
    cb(null)
  }
})
b = new Duplex({
  write(data, cb) {
    a.push(data)
    cb(null)
  }
})

const server = await serve(a, spec, { storage: dir })
const client = await connect(b, spec)
```

## Electron and a Bare worker

`example/chat-desktop`. The chain is worker, Electron main, preload, renderer.
Electron main spawns the worker through `pear-runtime` and proxies its duplex to
the renderer over `ipcMain` channels, the preload exposes that bridge on
`window.bridge`, and the renderer wraps the bridge back into a duplex.

```js
/* global Bare */
import goodbye from 'graceful-goodbye'
import { serve } from 'chat-backend/server'

const server = await serve(Bare.IPC, { storage: Bare.argv[2] })
goodbye(() => server.close())
```

Wrap that in a `try` that prints a boot marker to stderr and exits. The
renderer's stderr listener turns the marker into a stream error, so `connect()`
rejects with a reason instead of hanging.

## Expo and a Bare worklet

`example/chat-mobile`. Same server, one hop less, because the worklet's IPC is
already a duplex reachable from the JS thread.

```js
import { Worklet } from 'react-native-bare-kit'
import bundle from '../../worklets/app.bundle.mjs'

const worklet = new Worklet()
worklet.start('/app.bundle', bundle, [storage])
const me = await connect(worklet.IPC) // worklet.IPC is already a duplex
```

The worklet itself is `await serve(BareKit.IPC, { storage })`. It must be
pre-bundled with `bare-pack` before Metro runs, and rebuilt after every worklet
or backend change.

## Next

- [Extensions](extensions.md) for what `cero.use` and `cero.define` register.
- [Files](files.md) for uploads, which cross the wire as one message.
- [Examples](examples.md) for the four apps these snippets come from.
