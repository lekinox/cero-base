# mirror

A [blind-peer](https://github.com/holepunchto/blind-peer) mirror for cero apps — an
always-on relay that holds rooms' **encrypted** blocks so members sync even when never
online at the same time. It never sees your data.

This is a deploy artifact, not a package: it wraps [`blind-peer-cli`](https://github.com/holepunchto/blind-peer-cli)
in a container. There's no `package.json`, so it's not an npm workspace and adds nothing
to the monorepo install.

Deploy it, copy the public key it logs, and pass that to your apps:

```js
await cero(dir, spec, { mirrors: ['<public-key-from-logs>'] })
```

## Run locally

```sh
npx blind-peer-cli --storage ./data --max-storage 20000
# → logs: "Listening at <z32-public-key>"   ← that's your mirror key
```

## Deploy on Coolify

1. In Coolify: **+ New → Resource → Docker Compose** (or **Private Repository**,
   build pack _Docker Compose_). Point it at this repo; set the base directory to
   `services/mirror` if deploying the whole monorepo.
2. **No domain, no exposed port** — HyperDHT hole-punches through NAT. Leave ports unset.
3. Keep the `blind-peer-data` volume **persistent**. The mirror's public key is derived
   from data there — wiping it changes the key (and every app's `mirrors` entry).
4. Deploy, open **Logs**, copy `Listening at <z32-public-key>`. That's your mirror key.

## Config

`MAX_STORAGE` (MB, in `docker-compose.yml`) caps disk; least-recently-used blocks are GC'd
past it, shared across every app the mirror holds. Default 20 GB.

## One mirror per box

For redundancy run this on a **separate** machine and pass both keys to your apps. Don't
run multiple copies on one server — they share a failure domain, so it adds no redundancy.
