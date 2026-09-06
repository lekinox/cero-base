# Examples

[Docs](README.md) · Previous: [Network](network.md) · Next: [API reference](api.md)

Four apps live under `example/`. They share one chat model, so the same schema is
readable through four different front ends.

```text
chat-backend        schema + spec + serve/connect, no UI
  |
  +-- chat-terminal   cero in process, readline UI
  +-- chat-desktop    Electron, cero in a Bare worker
  +-- chat-mobile     Expo, cero in a Bare worklet
```

They are npm workspaces of the repo root. Run `npm install` there, then
`npm run build -w chat-backend` to compile the spec.

## chat-backend

```js
// server.js
export function serve(ipc, opts) {
  return rpcServe(ipc, spec, { name: os.hostname(), ...opts })
}
// client.js
export function connect(ipc) {
  return cero.connect(ipc, spec)
}
```

The shared piece. `schema.js` declares a root `profile`, a `room` child handle
with its own `profile` and `messages`, and a `local` settings collection.
`build.js` compiles that into `spec/`. `server.js` wraps `serve(ipc, spec, opts)`
and `client.js` wraps `connect(ipc, spec)`, so the three front ends differ only in
which stream they hand over. It also exports `isInitialized(storage)`, a
`cero.peek` probe that tells a launcher whether this device already has an
identity. Rebuild the spec after every schema change.

Pairs with [Schema](schema.md) and [Apps](apps.md).

## chat-terminal

One file, 148 lines, no transport and no UI framework. It opens cero in process,
creates or joins a room, prints an invite, and renders `cero.watch(room.messages)`
to stdout. The best place to read the API in use. It prints the identity phrase on
the first run, and `--phrase` makes a second machine your device.

```sh
cd example/chat-terminal
node index.js --name alice                # prints an invite
node index.js --join <invite> --name bob
```

`--storage <dir>` keeps the identity across runs. Without it every run gets a
fresh temporary directory.

Pairs with [Quickstart](quickstart.md) and [Identity](identity.md).

## chat-desktop

```js
// workers/main.js, in Bare
const server = await serve(Bare.IPC, { storage })
// renderer
const me = await connect(bridgeStream)
```

Electron. The cero instance lives in a Bare worker (`workers/main.js`) that calls
`serve()` on `Bare.IPC`; the React renderer calls `connect()` over a duplex stream
that piggybacks on the Electron preload bridge. Nothing p2p runs in the renderer.
Start it with `npm run dev --workspace chat-desktop`.

Pairs with [Apps](apps.md).

## chat-mobile

Expo and React Native. The Bare worklet (`worklets/main.js`) owns storage, the
swarm and the autobees; the JS thread calls `connect()` over `BareKit.IPC`.
`src/hooks/use-query.js` turns `cero.watch(ref)` into a React hook.

```sh
cd example/chat-mobile
npm run build        # bundle the worklet, repeat after worklet changes
npm run start
npm run ios          # or: npm run android
```

Pairs with [Apps](apps.md).

## Next

- [API reference](api.md), for every export the examples use.
- [Apps](apps.md), for the two-process layout three of them share.
