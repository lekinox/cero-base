# cero

Local-first, peer-to-peer data for apps: describe a schema, cero stores it on the device, syncs it between a user's devices and shares it with the people they invite. No server.

Read `docs/README.md` first, then `skills/cero/SKILL.md` for the short version of the API. The source wins over both.

## Layout

```text
packages/core    @cero-base/core   primitives: identity, database, network, pairing, storage, blobs, rpc
packages/cero    @cero-base/cero   the SDK: cero(), operators, handles, extensions, serve/connect
packages/tools   @cero-base/tools  devtools tap, not documented yet
example/         chat-backend (shared spec), chat-terminal, chat-desktop (Electron), chat-mobile (Expo)
docs/            the guides, one flat folder
skills/cero      self-contained agent skill, copy it into a .claude folder
services/mirror  a blind-peer mirror to self-host
```

ESM everywhere. The three packages publish at one version, in lockstep.

## Commands

```sh
npm install
npm test                  # the three packages in parallel under Bare, one file per process
npm run test:node         # the same under Node
npm run test:core         # one package
npm run lint              # prettier + lunte
npm run build:types --workspaces --if-present   # regenerate types/ from JSDoc, commit the result
npm run release <patch|minor|major>             # tests, smoke, tag, publish, push
```

A single file: `cd packages/core && npx brittle-bare test/database/database.test.js`, or `brittle-node` for Node.

## Rules

- Runs on Node and Bare. Import built-ins plainly, never with a `node:` prefix. Bare has no Node globals: import `process` (the imports map picks bare-process), `AbortController` from bare-abort-controller, and `fetch` from the test helpers.
- Use the `cero.` facade in app code and examples: `cero.put`, `cero.get`, `cero.open`. No aliased named imports.
- Short names: `writer`, not `writerPubkey`. Function declarations for module helpers, no underscore prefix on them. Class privates keep `_`.
- Comments only where the why is not obvious, one line, no narration of what the code does, no version numbers, no history of past bugs, no section labels.
- No compatibility or legacy code. There is no production app yet; fix the root cause and delete the old path.
- Nothing in this repo mentions keet. The `keet-identity-key` dependency name is the one exception.
- Tests live under `test/<module>/` mirroring `src/`, one file per module with unit and RPC cases together. Helpers in `test/helpers/index.js`, fixtures in `test/fixtures/`.
- Wait on conditions with `waitFor` / `waitUntil`, never a bare sleep. Every peer gets `bootstrap: testnet.bootstrap`, never the live DHT.
- Red-check every guard you add: delete it, watch its test fail, restore it.
- The `types/` folders are generated. Never edit them by hand; CI diffs them.
- Release order is commit, bump, publish. Never publish uncommitted source. No co-author trailers in commits.
- Example apps' dependencies are hands-off: report drift, do not upgrade them.
- Notes, plans and evaluations go in `.claude/` (ignored), never in `docs/`.
