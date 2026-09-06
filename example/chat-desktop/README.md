# chat-desktop

Electron reference app for cero2. A tiny chat client that runs `cero` in a
node `worker_threads` worker and talks to the React renderer over a JSON-RPC
bridge.

## Layout

```text
electron/        electron main + preload (CommonJS preload for sandboxed renderer)
workers/main.js  Bare worker — owns the cero instance, exposes chat ops via HRPC
src/             react renderer
  hooks/use-chat.js   connects to the worker over the preload bridge via @cero-base/cero/client
  lib/ipc.js          duplex stream over the Electron preload bridge
```

## Run

```bash
npm install                 # from the cero2 monorepo root
npm run dev --workspace chat-desktop
```

`dev` boots Vite at `localhost:5173` and launches Electron pointing at it.
Hot module reload works for the renderer; the worker restarts when Electron
restarts.

## Build a production bundle

```bash
npm run build --workspace chat-desktop   # bundles renderer to dist/
npm start --workspace chat-desktop       # builds + launches Electron
```

## How it works

- `cero` instance lives in `workers/main.js`. It boots the chat backend
  via `chat-backend/server`'s `serve()`, which wires cero's HRPC server
  to `Bare.IPC`.
- `electron/main.js` spawns the worker via Pear's `pear:startWorker` and
  proxies messages between it and the renderer over Electron IPC.
- The renderer connects via `@cero-base/cero/client`'s `connect()` over a duplex
  stream that piggybacks on the Electron preload bridge.
