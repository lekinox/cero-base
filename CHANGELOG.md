# Changelog

## 2.3.1 (2026-09-26)

### Bug Fixes

- both cero facades type their verbs, and the verbs take a UI's contexts
- the hook guard covers only a hook's own run, so work beside a waiting hook is not refused

## 2.3.0 (2026-09-26)

### Features

- every act is a cero verb, joins confirmed through request.accept, docs rewritten
- a join rides in the joiner's own core, apply admits it
- a rank above member is handed out once
- a device serves its rooms' invites whenever it is online
- invites carry no mirrors, each side uses the app's own
- mailbox pairing replaces blind-pairing

### Bug Fixes

- a joiner admitted but gone is removed at its invite's expiry, even while a device offers its keys
- the audit's bugs, test first; members hold what they skip, faster reconnects, Bluetooth on device keys
- an invite reaching its expiry on the timer's own millisecond is still dropped
- rotation on autobee 2.11.1, a removed member needs a newer invite
- joins link their invite, members come in only through a join
- invites are sealed for later inviters too
- a sealed-out device re-keys, revoking an invite is rank-capped
- invite secrets sealed to inviters, genesis from autobee
- a device seats only itself
- every record type keeps its rank rule
- roles change by rank only, writers stay with their member
- a knock delivered again admits nobody twice
- reader joins, a closed mailbox stops a join, never-online-together test

### Refactoring

- pairing keeps one map of served invites, each with its inbox

### Performance

- the server boots cero when it opens, not on the first init

### Documentation

- the identity example shows the phrase round trip

### Chores

- autobee 2.11.8
- autobee 2.11.4, ble-swarm 2.3.2, npm 12.1.0, vite 8.3.1, expo 57.0.25
- a comment still named autobee-encryption
- autobee 2.10.1, corestore 7.12.6, hyperswarm 4.17.2, electron 44.4.5

### Other

- 🚀 test: shared helpers — ceroOpen, openHandle, withRole, waitFor; the owner revokes a device once its claim reached it
- 🚀 test: one makePeer helper for a database on its own network, apply() for an op as a given writer
- 🚀 examples: a reloaded desktop window no longer offers setup again
- 🚀 examples: mobile settings reveal the recovery phrase on demand
- 🚀 examples: a join nobody answered yet waits instead of failing

## 2.2.1 (2026-09-18)

### Documentation

- background errors in the errors guide

### Chores

- bare 1.33.5, blind-peering 2.9.5, bare-bluetooth-android 0.6.2, example deps
- autobee 2.10.0

## 2.2.0 (2026-09-18)

### Bug Fixes

- background errors reach the app, close never leaks the lock

### Chores

- latest deps, autobee 2.9.6

## 2.1.8 (2026-09-13)

### Bug Fixes

- pin autobee 2.7.2, 2.7.3 has no tarball

### Performance

- core and cero run four test files at a time

### Chores

- b4a 1.9.0

## 2.1.7 (2026-09-13)

### Bug Fixes

- smoke gate reads npm 12's pack report

### Chores

- autobee 2.7.2

## 2.1.6 (2026-09-11)

### Bug Fixes

- mirror a bee's view cores by hand

### Other

- Bump deps

## 2.1.5 (2026-09-11)

### Chores

- autobee 2.7.0, compact-encoding 3.5.0

## 2.1.4 (2026-09-08)

### Bug Fixes

- a hook on a single ref also guards its del

## 2.1.3 (2026-09-08)

### Chores

- autobee 2.2.2, a writer swap and a racing add no longer track one core twice

## 2.1.2 (2026-09-07)

### Documentation

- rpc is the seventh core primitive

### Chores

- autobee 2.2.1, ids in their own module, admission tags without a version
- the plugin's per-directory CLAUDE.md stubs stay out of git and npm

## 2.1.1 (2026-09-07)

### Bug Fixes

- a write waits for the drain that admitted it
- a reloaded UI re-attaches to its worker

### Chores

- release pushes its own tag only

## 2.1.0 (2026-09-07)

### Features

- extensions and operators named once at build
- rank swarm presence by last update
- hooks and routes run at apply on every peer

### Refactoring

- update and apply events, total replaces count

### Chores

- smoke skips emitted imports, changelog reads past the emoji
- autobee 2.1.1
