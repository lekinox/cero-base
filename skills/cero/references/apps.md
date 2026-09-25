# Apps

Run Cero in a worker that owns the storage and the network, and drive it from an Electron or Expo UI with the same verbs.

```js
// the worker: storage and network live here
import { serve } from '@cero-base/cero/server'
import { spec } from './spec/index.js' // the quickstart's spec, the same on both sides

await serve(ipc, spec, { storage: './data' }) // ipc: a duplex stream to the UI

// the UI: the screen lives here
import { cero } from '@cero-base/cero/client'

const me = await cero(ipc, spec) // the same stream, from the UI's end
await cero.put(me.notes, { title: 'from the UI' })
```

## Why two processes

Cero needs native modules and a storage directory, which a renderer or a React Native bundle does not have. So a worker opens Cero, in a Node process or a Bare worker or worklet, and serves it over one duplex stream; the UI holds a client with the same refs and `cero.` verbs. The client never reaches a native module, so Vite and Metro bundle it: UI code imports `@cero-base/cero/client`, never `@cero-base/cero`.

## Try it in one file

Any duplex works, so two streams that push into each other put both halves in one Node file.

```js
import { Duplex } from 'streamx'
import { serve } from '@cero-base/cero/server'
import { cero } from '@cero-base/cero/client'
import { spec } from './spec/index.js' // the quickstart's spec

const worker = new Duplex({
  write(data, cb) {
    ui.push(data)
    cb()
  }
})
const ui = new Duplex({
  write(data, cb) {
    worker.push(data)
    cb()
  }
})

const server = await serve(worker, spec, { storage: './data' })
const me = await cero(ui, spec)

await cero.put(me.notes, { title: 'from the UI' })
console.log((await cero.get(me.notes)).data)

await cero.close(me)
await server.close()
```

## Run the worker

```js
const server = await serve(ipc, spec, {
  storage: './data', // required: the worker owns the directory
  name: 'laptop', // this device's name
  onerror: (err) => console.error('worker', err.code) // while no UI is connected
})
```

Every other option goes to `cero()` as is: `channel`, `mirrors`, `bluetooth`, `storageKey`, `extensions`. Background errors reach `onerror` while no UI is connected, and the UI's `onerror` once one is.

`serve` resolves before Cero opens, so the network comes up while the UI still loads. A failure opening Cero, `CHANNEL_MISMATCH` for one, rejects the UI's connect with its code. What throws before the server exists needs the worker's own `try`:

```js
// workers/main.js in example/chat-desktop, a Bare worker
/* global Bare */
import goodbye from 'graceful-goodbye'
import { serve } from 'chat-backend/server'

let server
try {
  server = await serve(Bare.IPC, { storage: Bare.argv[2] })
} catch (err) {
  console.error(`__BOOT_ERROR__${err.message}`)
  Bare.exit(1)
}

goodbye(() => server.close())
```

The UI side turns that stderr line into the stream's error, so its connect rejects instead of hanging.

## Connect the UI

```js
import { cero } from '@cero-base/cero/client'

const me = await cero(ipc, spec, { onerror: (err) => console.error(err.code) })
const room = await cero.open(me.room, { name: 'team' })
cero.watch(room.notes).on('data', ({ data }) => render(data)) // render: your UI's
```

`cero.connect(ipc, spec)` is the same function. The client carries the worker root's refs: your schema's, the builtins, and `me.local.<ref>` for local refs, which stay on this device and never sync. Every verb but `before`, `after` and `tx` crosses, `rotate` included.

Each watch item is a full result, and with `changes: true` the client diffs them itself, so a slow link skips items, never changes. A reloaded UI is a new client on the same worker: its old streams end.

## Wire it into Electron

`example/chat-desktop` runs the worker above through four files:

- `electron/main.js` spawns `workers/main.js` with `pear-runtime`, passing its storage directory, and relays the worker's IPC, stdout and stderr to the window over `ipcMain` channels.
- `electron/preload.js` exposes that relay as `window.bridge`.
- `src/lib/ipc.js` wraps the bridge in a duplex and turns a `__BOOT_ERROR__` line into the stream's error.
- `src/hooks/use-chat.js` connects: `await connect(getIPC('/workers/main.js'), opts)`.

```js
// src/lib/ipc.js, trimmed
import { Duplex } from 'streamx'

export function getIPC(path) {
  window.bridge.startWorker(path)
  const stream = new Duplex({
    write(data, cb) {
      window.bridge.writeWorkerIPC(path, data)
      cb()
    }
  })
  window.bridge.onWorkerIPC(path, (data) => stream.push(data))
  return stream
}
```

## Wire it into Expo

`example/chat-mobile` has one hop less: a Bare worklet's IPC is a duplex on the JS thread.

```js
// src/lib/ipc.js and src/hooks/use-chat.js, in short
import { Worklet } from 'react-native-bare-kit'
import bundle from '../../worklets/app.bundle.mjs'

const worklet = new Worklet()
worklet.start('/app.bundle', bundle, [storage]) // storage: a folder in the app's documents
const me = await connect(worklet.IPC) // connect from chat-backend/client
```

The worklet, `worklets/main.js`, is `await serve(BareKit.IPC, { storage: Bare.argv[0] })`. `bare-pack` bundles it into `worklets/app.bundle.mjs` before Metro runs: rebuild after every worklet or backend change.

## Pause in the background

The app's lifecycle belongs to the UI, so the UI tells the worker.

```js
import { AppState } from 'react-native'
// me from the UI's cero(ipc, spec)

AppState.addEventListener('change', (state) => {
  if (state === 'background') cero.suspend(me)
  if (state === 'active') cero.resume(me)
})

// in an Electron window
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cero.suspend(me)
  else cero.resume(me)
})
```

[Network](network.md) covers what pauses.

## What runs in the worker

- `before`, `after` and `tx` take functions, so they run in the worker and the client has none. Register hooks in an extension's `setup`, which runs there.
- `peek` reads a local directory, so it runs in a process that has one: chat-desktop's Electron main calls it, through `isInitialized`, before it starts the worker.
- `restore(me, phrase)` on a client takes the phrase; the worker turns it into the seed.
- Errors cross as `code` and `message` only, so match `err.code`. A hook that refuses a UI's write arrives as `REFUSED`.
- A denied join reaches a UI as `DENIED` with no reason.

## Ship one spec to both sides

Both halves must run the same built spec, so the schema, the build and two thin wrappers live in one package both depend on. Keep its `spec/` in git: each build reads the last one to number new fields and raise the app version, so a shipped app must keep it. The examples have no users to stay compatible with, so they leave it out of git and rebuild it from scratch.

```js
// example/chat-backend/server.js
import os from 'os'
import { serve as rpcServe } from '@cero-base/cero/server'

import { spec } from './spec/index.js'

export async function serve(ipc, { storage, name = os.hostname(), ...opts } = {}) {
  if (!ipc) throw new Error('ipc is required')
  return rpcServe(ipc, spec, { storage, name, ...opts })
}
```

```js
// example/chat-backend/client.js
import { cero } from '@cero-base/cero/client'
import { spec } from './spec/index.js'

export const restore = cero.restore

export async function connect(ipc, { name, phrase } = {}) {
  const me = await cero(ipc, spec)
  if (phrase) await cero.restore(me, phrase)
  if (name) await cero.set(me.profile, { name })
  return me
}
```

`connect(ipc, { phrase })` is how the desktop setup screen recovers, and `{ name }` how it creates.

## Run the examples

Four npm workspaces under `example/` share one chat schema. Run `npm install` at the repository root, then `npm run build -w chat-backend` builds the spec; the dev scripts below run it for you.

**chat-backend** is the shared package: `schema.js`, `build.js`, `spec/`, the two wrappers above, and `isInitialized(storage)`. `npm test -w chat-backend` runs its tests.

**chat-terminal** opens Cero in process, no worker, in one file. The first run prints an invite and your phrase.

```sh
cd example/chat-terminal
node index.js --name alice                        # prints an invite
node index.js --join <invite> --name bob          # in a second terminal
node index.js --phrase "<words>" --storage ./me   # another machine, the first still running
```

Without `--storage` every run is a fresh identity in a temporary directory. `/invite` prints a fresh invite, `/quit` exits.

**chat-desktop** is Electron with the worker above.

```sh
npm run dev:desktop -- --no-updates           # from the root: builds the spec, starts Vite and Electron
npm run dev -w chat-desktop -- --no-updates   # the same, once the spec is built
```

`--no-updates` keeps the example's over-the-air updates off, so Electron runs the worker on disk.

**chat-mobile** is Expo with the worklet above, on iOS.

```sh
npm run dev:mobile                           # from the root: builds the spec and the simulator bundle, runs it
npm run build:device -w chat-mobile          # an iPhone bundle instead
npm run ios -w chat-mobile -- --device       # then run it on the iPhone
```

There is no Android bundle script, so the example runs on iOS only.

## Next

- [Extensions](extensions.md) to put hooks in a `setup` that runs in the worker.
- [Network](network.md) for mirrors, Bluetooth and what backgrounding pauses.
- [How it works](how-it-works.md) for what happens between the two devices.
