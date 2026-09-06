# chat-mobile

React Native / Expo chat reference app built on top of [cero](../../packages/cero).

## Architecture

```text
+---------------------------+        +----------------------------+
|  React Native JS thread   |        |   Bare worklet (BareKit)   |
|                           |        |                            |
|   @cero-base/cero/client.connect()   | <----> |  worklets/main.js          |
|   over BareKit.IPC        |  HRPC  |  serve() from chat-backend |
|   src/components/*        |        |  cero + chat-backend       |
+---------------------------+        +----------------------------+
```

- The Bare worklet owns the real cero instance: storage, hyperswarm, autobees.
- The JS thread connects via `@cero-base/cero/client`'s `connect()` over `BareKit.IPC`.
  Handle methods (`invite`, `tx`, `call`, `close`, `leave`) and operators
  (`put`, `set`, `get`, `watch`, `del`, `count`, `open`) all proxy through HRPC.

## Run

```sh
npm install              # from the monorepo root
cd example/chat-mobile

# build the Bare bundle (once, and after worker changes):
npm run build            # ios-arm64-simulator
# or:
npm run build:device     # ios-arm64

# start Metro / Expo:
npm run start

# launch on iOS or Android:
npm run ios
npm run android
```

## Files

- `index.js` — Expo entry; registers the root component.
- `worklets/main.js` — Bare worklet entry. Boots `chat-backend` and
  attaches `serve()` to `BareKit.IPC`.
- `src/lib/ipc.js` — duplex stream over `BareKit.IPC` consumed by `connect()`.
- `src/hooks/use-chat.js` — boots the worklet, returns the connected handle.
- `src/hooks/use-query.js` — `watch(ref)` as a React hook.
- `src/components/` — UI: router, setup, rooms list, room view, settings.

## Notes

- Uses cero's built-in HRPC via `@cero-base/cero/client` + `@cero-base/cero/server`.
- Plain `StyleSheet` (no tailwind) with a dark theme.
