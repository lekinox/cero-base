# Changelog

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
