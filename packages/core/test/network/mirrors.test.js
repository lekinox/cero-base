import test from 'brittle'

import { Database } from '../../src/database/index.js'
import { Identity } from '../../src/identity/index.js'
import { Network } from '../../src/network/index.js'
import { makeStore, makeTestnet, makeMirror, waitFor, waitForMirrored } from '../helpers/index.js'
import { spec } from '../fixtures/spec/index.js'

test.configure({ timeout: 90000 })

async function peer(t, testnet, opts = {}) {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = opts.identity || (await Identity.generate())
  const network = new Network({ bootstrap: testnet.bootstrap, store, mirrors: opts.mirrors })
  await network.ready()
  const db = new Database({
    store,
    identity,
    network,
    spec,
    key: opts.key,
    encryptionKey: opts.encryptionKey
  })
  await db.ready()
  const close = async () => {
    await db.close().catch(() => {})
    await network.close().catch(() => {})
  }
  t.teardown(close, { order: 5 })
  return { db, network, identity, close }
}

test('mirrors: B syncs a room the writer only mirrored — writer offline', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)

  // A mirrors its room, writes, then goes fully offline
  const a = await peer(t, testnet, { mirrors: [mirror] })
  await a.db.bootstrap({ name: 'a' })
  const { data: row } = await a.db.put('messages', { text: 'through the mirror' })
  await waitForMirrored(a.db)
  await a.close()

  // B opens the same room with only the mirror as a path to A's data
  const b = await peer(t, testnet, {
    identity: await Identity.generate(),
    key: a.db.key,
    encryptionKey: a.db.encryptionKey,
    mirrors: [mirror]
  })

  const synced = await waitFor(async () => {
    await b.db.bee.update()
    return (await b.db.get('messages', row.id)).data
  })
  t.is(synced.text, 'through the mirror', 'B pulled the row from the mirror with A offline')
})

test('mirrors: a joiner boots from the mirror even when the writer reached it only after bootstrap', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)

  // A's mirror connection lands only after bootstrap swapped the local writer
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const network = new Network({ bootstrap: testnet.bootstrap, store, mirrors: [mirror] })
  await network.ready()
  await network.suspend()
  const a = new Database({ store, identity: await Identity.generate(), network, spec })
  await a.ready()
  t.teardown(
    async () => {
      await a.close().catch(() => {})
      await network.close().catch(() => {})
    },
    { order: 5 }
  )
  await a.bootstrap({ name: 'a' })
  const { data: row } = await a.put('messages', { text: 'late mirror' })
  await network.resume()
  await waitForMirrored(a)
  const { key, encryptionKey } = a
  await a.close()
  await network.close()

  const b = await peer(t, testnet, { key, encryptionKey, mirrors: [mirror] })
  const synced = await waitFor(async () => {
    await b.db.bee.update()
    return (await b.db.get('messages', row.id)).data
  })
  t.is(synced.text, 'late mirror', 'B booted the room from the mirror alone')
})

test('mirrors: absent option leaves blind peering off', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await peer(t, testnet)
  t.is(a.network._blindPeering, null, 'no mirrors → no BlindPeering constructed')
  await a.db.bootstrap({ name: 'a' })
  const { data: row } = await a.db.put('messages', { text: 'local only' })
  t.is((await a.db.get('messages', row.id)).data.text, 'local only', 'unchanged behavior')
})

test('mirrors: string keys decode, suspend/resume cycles cleanly', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const z32 = (await import('hypercore-id-encoding')).encode(mirror)

  const a = await peer(t, testnet, { mirrors: [z32] })
  t.ok(a.network._blindPeering, 'z32 mirror key accepted')
  await a.db.bootstrap({ name: 'a' })
  await a.network.suspend()
  await a.network.resume()
  const { data: row } = await a.db.put('messages', { text: 'after resume' })
  t.is((await a.db.get('messages', row.id)).data.text, 'after resume', 'writes fine after cycle')
})
