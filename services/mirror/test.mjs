// Verify a blind-peer mirror actually relays: one instance writes and goes
// fully offline, another pulls it back through the mirror only.
//
//   node services/mirror/test.mjs <mirror-public-key>
//
// Exits 0 and prints ✅ if the row syncs through the mirror; non-zero otherwise.
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'

import { Database } from '@cero-base/core/database'
import { Network } from '@cero-base/core/network'
import { Identity } from '@cero-base/core/identity'
import { spec } from '../../packages/core/test/fixtures/spec/index.js'

const MIRROR = process.argv[2]
if (!MIRROR) {
  console.error('usage: node services/mirror/test.mjs <mirror-public-key>')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = () => mkdtempSync(join(tmpdir(), 'mirror-test-'))

async function store() {
  const root = new HypercoreStorage(tmp(), { columnFamilies: ['cero/local'] })
  await root.ready()
  const s = new Corestore(root, { manifestVersion: 2 })
  await s.ready()
  return s
}

async function main() {
  const identity = await Identity.generate()

  const aStore = await store()
  const aNet = new Network({ store: aStore, mirrors: [MIRROR] }) // no bootstrap = real DHT
  await aNet.ready()
  const a = new Database({ store: aStore, identity, network: aNet, spec, mirrors: [MIRROR] })
  await a.ready()
  await a.bootstrap({ name: 'a' })
  const { data: row } = await a.put('messages', { text: 'mirror ok' })
  console.log('wrote a row, flushing to the mirror...')
  await sleep(8000)
  await a.close()
  await aNet.close()
  console.log('writer offline; opening a reader with the mirror as the only path...')

  const bStore = await store()
  const bNet = new Network({ store: bStore, mirrors: [MIRROR] })
  await bNet.ready()
  const b = new Database({
    store: bStore,
    identity: await Identity.generate(),
    network: bNet,
    spec,
    key: a.key,
    encryptionKey: a.encryptionKey,
    mirrors: [MIRROR]
  })
  await b.ready()

  let ok = false
  for (let i = 0; i < 60; i++) {
    await b.bee.update()
    if ((await b.get('messages', row.id)).data) {
      ok = true
      break
    }
    await sleep(1000)
  }

  console.log(
    ok
      ? '\n✅ mirror relays — offline sync works'
      : '\n❌ no sync in 60s (unreachable / still flushing / NAT)'
  )
  await b.close().catch(() => {})
  await bNet.close().catch(() => {})
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('error:', e.message)
  process.exit(2)
})
