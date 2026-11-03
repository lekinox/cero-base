# relay

A [blind-relay](https://github.com/holepunchto/blind-relay) for cero apps — an always-on
node that tunnels already-encrypted UDX streams between peers that can't holepunch
(strict NATs, mobile networks). It never sees your data.

This is a deploy artifact, not a package: `relay.js` is a few lines over `hyperdht` and
`blind-relay` (there is no CLI), pinned in `package.json`. It's not an npm workspace.

Deploy it, copy the public key it logs, and pass that to your apps' relay list
(`RELAYS` / `EXPO_PUBLIC_RELAYS`, i.e. `relayThrough`).

## Run locally

```sh
cd services/relay && npm install
KEY_FILE=./key PORT=49738 node relay.js
# → logs: "Listening at <z32-public-key>"   ← that's your relay key
node test.mjs   # peers forced through a local relay connect; abuse caps hold
```

## Deploy on Coolify

1. In Coolify: **+ New → Resource → Docker Compose** (or **Private Repository**,
   build pack _Docker Compose_). Point it at this repo; set the base directory to
   `/services/relay`.
2. **No domain.** Publish the UDP port: keep the `ports` mapping `49738:49738/udp` from
   `docker-compose.yml` (Coolify: _Ports Mappings_ `49738:49738/udp`).
3. Open it in the host firewall: `ufw allow 49738/udp`. An unfirewalled relay means
   peers reach it directly instead of holepunching.
4. Keep the `blind-relay-data` volume **persistent**. It holds only the keypair seed;
   wiping it changes the public key (and every app's relay entry).
5. Deploy, open **Logs**, copy `Listening at <z32-public-key>` into your apps'
   `RELAYS` / `EXPO_PUBLIC_RELAYS`.

## Config

The relay is open to any key (each device has its own), so abuse is bounded. Env vars,
set in the `Dockerfile` (positive integers; anything else refuses to start):

- `MAX_PER_KEY` (8) open sessions per remote public key
- `MAX_PER_IP` (256) per remote IP, since keys are free to mint; high because phones that need a relay sit behind carrier-grade NAT, where many users share one IP; tune per host
- `MAX_SESSIONS` (2000) in total
- `PAIR_TIMEOUT` (10000 ms) a session that hasn't paired by then is dropped

A connection over a cap is closed at once; counts drop on close.

## Sizing

A box with ~1 GB RAM, low CPU, a few GB disk is plenty; it holds no data. Bandwidth is
what scales with use.

## Redundancy

Run a second relay on a **separate** machine and list both keys in your apps. Copies on
one server share a failure domain and add nothing.
