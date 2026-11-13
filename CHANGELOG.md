# Changelog

## 3.1.0 (2026-11-13)

### Features

- cero.seat (#77)

### Bug Fixes

- keep the writer a join came in on (#81)
- one seat at a time (#80)
- seat follow-ups (#79)
- a seat's pass lives in a collection named seats, so an app keeps passes as its own noun (#78)

### Other

- 🚀 test: avatar e2e (#76)

## 3.0.1 (2026-11-13)

### Bug Fixes

- an invite asked while a join of the same room enters waits on that join, and a removal heard at close reports nothing (#74)

### Documentation

- the cero skill says what 3.0.0 does: room lists, cancel and the latest ask, revoke by row id, recovery waits and peek, naming and removing devices (#73)

### Other

- 🚀 test: compat tests the release below this one, so main is green after a release and 3.0.1 can ship (#75)

## 3.0.0 (2026-11-12)

### Features

- end-to-end tests of the chat examples, and the fixes they found: rooms you are in, ended rows, cancelled joins, device removal, renames (#71)
- handles nobody holds stay open up to a count, keepOpen, and one more closes the least recently used (#62)
- a database keeps its version in its log, so no member's update blocks the others, and t.later holds a thing back (#57)

### Bug Fixes

- a removal reaches every room, the latest ask stands, and an upgrade keeps its rooms and joins (#72)
- joins, invites, keys and devices in the log, joins on the row, a lock around link and restore; deps (#69)
- a write cut by its database's close rejects CLOSED before its seed is hashed, where Bare 1.37 ended the process (#68)
- a message an inbox was reading as it closed is handed to the inbox still open at its address, where it was lost when its block landed after the close (#67)
- closing the root stops a link or a restore that still waits, and waits for one already taking its place (#61)
- a message stored as the app is killed is handed over at the next start (#59)
- the write key is the newest landed rotation whose secret meets its commitment (#53)
- a block that is not encrypted carries only a join, a message is delivered once stored, a join rejects made-up keys, and a link killed at the end resumes (#52)
- a write through a finished tx is refused, me.topics and me.joins read by id, a file is keyed by its row, and holds nobody takes are given back (#51)
- the release script finishes a partial publish and stages by path; the examples run only their own worker and keep keys out of backups and off the command line (#50)
- devtools: the tap masks single rows, watch changes and epochs, drops a large frame before its token, and stats lists the open cores (#49)
- build: a collection, a single or an action removed from a shipped schema is refused (#48)
- build: a route added to a shipped spec takes a free id, and a required field added to a shipped type is refused (#46)
- what a database skipped is read before its first boot, a rebuild closes the log before it wipes its record, and the view's marker is written after (#45)
- a key rotation its close cut short is done at the next open, and a handle's background errors reach onerror (#44)
- a batch that changes no row wakes no watcher, what a hook wrote in a refused batch neither, and an op that landed still ranks its database (#43)
- a closing inbox hands nothing over, inboxes at one address take turns as one closes, and no room opens on a closing root (#42)
- a push only from who may write, and an inbox that keeps only what it validated (#41)
- apply: what a refused batch taught, file ids, hook ids and times, a view rebuilt under new rules (contract 3) (#40)
- the build refuses what corrupts stored rows or shadows Cero; every app's contract rises once (#39)
- device link expiry, the version gate, RPC handler errors and close while suspended, with no wire or stored change (#38)

### Performance

- a change of who may write to a handle wakes no topics watch, which shows no writers (#64)
- a push is verified from its own handle's topics row, a topic read by its id reads one row, and the topics watch wakes only when a topics row changed (#63)
- an invite to a room this device is in opens it from its one row, where a join read every handle (#60)
- a launch reads only the handles that changed since the last one, and a handle's change writes its own topics row (#58)
- a full list scans and sorts, a page's total counts the collection, and a search filters before it sorts (#54)

### Documentation

- a key change is called a rotation everywhere: guides, comments and test names (#47)

### Chores

- npm run outdated lists what is behind its latest release, by folder (#55)

### Other

- 🚀 test: what a device does with one handle costs the same however many it holds, by count in the suite and by the clock in npm run test:capacity (#66)
- 🚀 test: the RPC verbs test builds its stray invite at an address that can be sealed to (#65)
- 🚀 deps: bare 1.37, hypercore, compact-encoding, protomux, blind-peering and blind-push on their latest releases (#56)

## 2.12.0 (2026-11-09)

### Features

- cero.removed(room, id) says whether a member was taken out or left, from the record the handle keeps

### Bug Fixes

- a pairing closed while it syncs arms no expiry timer, so nothing keeps the process alive
- a member's own writes never carry its view of its rank, and the same profile mirrors no op

## 2.11.0 (2026-11-08)

### Bug Fixes

- mirroring stops before any database closes, so blind peering never reads a closed storage
- restore and link build the new identity beside the old and swap only once it opens; a killed swap settles on the next launch
- leaving first does not dodge a removal
- handles are held, not owned; leaving is not a removal; a send racing close fails as closing

### Other

- 🧪 test: the packages test one at a time and core's network timings run alone, so load never fails a timing
- 🚀 deps: autobee 2.13.3; a failed background remap reaches onerror
- 🚀 deps: every package, example and service on the latest releases
- relay: refuse self-pairing; idle timer follows real link traffic
- relay: per-IP unpaired cap, /64 grouping, link cap and idle timeout
- relay: raise MAX_PER_IP default to 256 for carrier-grade NAT
- services: add blind-relay with abuse caps; publish UDP ports for mirror and relay

## 2.10.0 (2026-11-02)

### Features

- the address key pair
- blind relays only when needed

## 2.9.0 (2026-10-30)

### Other

- 🚀 mail: cero.send and cero.inbox, a value signed for an address; keep false erases a message on both ends once it is done with (#36)
- 🚀 deps: every package and example on the latest releases (#35)

## 2.8.0 (2026-10-29)

### Documentation

- the show handler, who sends a push and who runs what (#23)

### Other

- 🚀 network: a connection is silent when nothing arrived since it was added, not since zero (#34)
- 🚀 database: a device behind a newer app reads but does not write, so a stale set never overwrites what it never saw (#27)
- 🚀 build: a release that changes what a write means raises the app's contract on its next build (#25)
- 🚀 invite: an address nothing can be sealed to is refused at create and parse, before any join is written (#33)
- query: search never looks at ids (#32)
- 🚀 handle: cero.invite resolves once the row that reopens the handle at boot is written (#31)
- 🚀 test: chat-terminal pairs over a 4-node testnet, the size hyperdht's NAT check needs (#30)
- 🚀 test: this release opens a store the previous published one wrote and shares a room with it (#26)
- 🚀 database: a view whose definition grew since it was built fills from the log on open (#24)
- 🚀 database: writable flips once the view holds this device, not inside the apply that admits it (#29)
- 🚀 push: the worklet opens the block a push carries and hands show the row (#22)
- 🚀 chat-mobile: a device invite from a link fills the field; linking replaces the identity, so the user taps for it (#21)
- 🚀 test: the removal's own re-key is epoch 1; a rotation of ours raced it on slow runners (#20)

## 2.7.0 (2026-10-27)

### Other

- 🚀 identity: cero.link(me, invite), a device links from an app already open; the examples offer it (#19)
- 🚀 deps: the examples on current releases (#16)
- 🚀 build: a field keeps the slot its spec gave it, so a new one never shifts an extension's (#17)

## 2.6.0 (2026-10-27)

### Bug Fixes

- a silent peer is one that sent no data, so an ack alone does not keep its connection (#11)

### Other

- 🚀 identity: link a device by invite, no phrase; a removed device key stays out (#15)
- identity: device keys (#12)
- database: an app's rule may decide who removes a member or changes her rank (#14)
- 🚀 push: a flag on the ref; the app's worklet says what to show (#10)

## 2.5.0 (2026-10-25)

### Bug Fixes

- a held writer wakes the room: the hold puts other devices' writers in the bee's wakeup group

### Other

- 🚀 test: the frozen peer says nothing, so the drop test asserts what it claims
- 🚀 push: blind push notifications
- 🚀 deps: the Holepunch stack to latest
- build(deps): bump actions/setup-node from 7.0.0 to 7.1.0

## 2.4.1 (2026-10-04)

### Bug Fixes

- one contract for the app, stamped by every database, raised only by stored data

### Documentation

- operators are where business logic goes; profileSync copies only name and its fields

### Other

- 🚀 test: the expired-accept case waits for the clock, not the joiner's timer

## 2.4.0 (2026-10-01)

### Features

- Bluetooth is only a transport: always there, the app turns the radio on

### Bug Fixes

- the audit's bugs, phrase recovery, explicit keys, specs back to contract 1

### Refactoring

- one RPC command for every verb
- one replication path: every connection replicates the network's store
- join requests are their rows, answered by id
- one way to seat a device; the root requires its device store

### Documentation

- the testing reference recovers with { phrase }
- singles and collections explained side by side; quickstarts that run as written
- the word is handle, not room; me and every handle are contexts

### Other

- 🚀 deps: bare-bluetooth 0.5.1, bare-bluetooth-android 0.9.2, blind-peering 2.10, hyperdb 6.10, brittle 4.3

## 2.3.4 (2026-09-29)

### Other

- 🚀 deps: bare 1.34 and the latest Bare modules; chat-mobile builds on React Native 0.86.3
- 🚀 deps: autobee 2.12.1, ble-swarm 2.3.4 with bare-bluetooth 0.5, corestore 7.13
- 🚀 test: one testnet per test in Core's pairing, network and blobs tests

## 2.3.3 (2026-09-27)

### Bug Fixes

- a local write caught by a close lands or rejects CLOSED
- epochs delivered at a join are kept, so a readmitted member reopens its room
- a join the room turns away is answered DENIED with why: removed, revoked or spent
- closing ends every watch cleanly, and an open in flight rejects CLOSED; an interrupted join resumes

### Other

- 🚀 test: the outage test waits longer for its setup under load

## 2.3.2 (2026-09-26)

### Chores

- bare-fs 4.8.2, react-native-bare-kit 0.15.6
- autobee 2.12.0

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
