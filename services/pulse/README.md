# pulse

A service for cero apps: a device tells it when it writes in a room, and it tells the room's other devices, so each brings the room up to
date even while the app keeps it closed. It keeps one time per room, under a key the room's
members derive from the room's newest key, so a member removed before a rotation loses it. It never sees a room, its data, its topic or its
members.

This is a deploy artifact, not a package: `pulse.js` is a few lines over `hyperdht` and the
[`hypertracker`](https://github.com/holepunchto/hypertracker) module, pinned in `package.json`. It's
not an npm workspace.

Deploy it, copy the public key it logs, and give that key to your apps' `pulse` extension:

```js
import { profileSync, handleSync, pulse } from '@cero-base/cero/extensions'

export const extensions = [profileSync(), handleSync(), pulse('<public-key-from-logs>')]
```

The app side is in `docs/network.md`, under "Bring closed handles up to date".

## Run locally

```sh
cd services/pulse && npm install
STORAGE=./data PORT=49739 node pulse.js
# → logs: "Listening at <z32-public-key>"   ← that's your pulse key
node test.mjs   # times pass between devices through it; key and times survive a restart
```

## Deploy on Coolify

1. In Coolify: **+ New → Resource → Docker Compose** (or **Private Repository**,
   build pack _Docker Compose_). Point it at this repo; set the base directory to
   `/services/pulse`.
2. **No domain.** Publish the UDP port: keep the `ports` mapping `49739:49739/udp` from
   `docker-compose.yml` (Coolify: _Ports Mappings_ `49739:49739/udp`).
3. Open it in the host firewall: `ufw allow 49739/udp`. An unfirewalled service means
   devices reach it directly instead of holepunching.
4. Keep the `pulse-data` volume **persistent**. It holds the key and the times; wiping it
   changes the public key (and every app's `pulse` key).
5. Deploy, open **Logs**, copy `Listening at <z32-public-key>` into your apps' `pulse(key)`.

## Config

Env vars, set in the `Dockerfile`:

- `STORAGE` (`/data`) where the key and the times live
- `PORT` (`49739`) its UDP port
- `BOOTSTRAP` (unset) `host:port` DHT nodes, comma separated, in place of the public ones; the test
  points it at a local testnet

## Stopping

SIGTERM or SIGINT writes the times out and exits; `docker stop` sends SIGTERM. A kill or a crash
loses the times told in the last two minutes. A device that missed one of those while offline
hears of the room's next write instead.

## Sizing

Each room a connected device follows costs it a few hundred bytes of memory: 10,000 followed from
one device took ~4 MB of heap (~65 MB of RSS) in a test. The times it keeps are on disk, one small
record per room told. Its bandwidth is one small message per write and per device following that
room. A box with ~1 GB RAM, low CPU and a few GB disk is plenty.

## Down

A device's writes, opens and closes never wait for the service. While it is down, devices keep
syncing the rooms they have open; once it is back they reconnect on their own and catch up.
