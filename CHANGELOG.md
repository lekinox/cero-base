# Changelog

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
