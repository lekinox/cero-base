import test from 'brittle'
import b4a from 'b4a'

import { Blobs, encodeId } from '../../src/blobs/index.js'
import { FileServer } from '../../src/blobs/server.js'
import { Identity } from '../../src/identity/index.js'
import { makeStore, fetch } from '../helpers/index.js'

async function putBytes(t, bytes) {
  const { store } = await makeStore(t)
  const identity = await Identity.generate()
  const blobs = new Blobs({ store, identity })
  await blobs.ready()
  t.teardown(() => blobs.close().catch(() => {}), { order: 10 })
  const blobId = await blobs.put(bytes)
  return { blobs, store, blobId }
}

test('file-server: GET link(id) returns the exact bytes + content-type', async (t) => {
  const data = b4a.from('hello world')
  const type = 'text/plain'

  const { blobs, store, blobId } = await putBytes(t, data)
  const id = encodeId(blobs.key, blobId, type)

  const resolve = (coreKey) =>
    b4a.equals(coreKey, blobs.key) ? { key: coreKey, encryptionKey: blobs.encryptionKey } : null

  const server = new FileServer({ store, resolve })
  t.teardown(() => server.close(), { order: 1 })
  await server.listen()
  t.ok(server.port > 0, 'listening on a port')

  const res = await fetch(server.getLink(id))
  t.is(res.status, 200)
  t.is(res.headers.get('content-type'), type)

  const body = b4a.from(await res.arrayBuffer())
  t.alike(body, data, 'served bytes match the put bytes')
})

test('file-server: resolve -> null yields 404', async (t) => {
  const data = b4a.from('blocked')

  const { blobs, store, blobId } = await putBytes(t, data)
  const id = encodeId(blobs.key, blobId, 'application/octet-stream')

  const server = new FileServer({ store, resolve: () => null })
  t.teardown(() => server.close(), { order: 1 })
  await server.listen()

  const res = await fetch(server.getLink(id))
  t.is(res.status, 404)
})

test('file-server: close tears down the server', async (t) => {
  const data = b4a.from('bye')

  const { blobs, store, blobId } = await putBytes(t, data)
  const id = encodeId(blobs.key, blobId, 'application/octet-stream')

  const resolve = (coreKey) =>
    b4a.equals(coreKey, blobs.key) ? { key: coreKey, encryptionKey: blobs.encryptionKey } : null

  const server = new FileServer({ store, resolve })
  await server.listen()
  const url = server.getLink(id)

  t.is((await fetch(url)).status, 200, 'serves while open')

  await server.close()
  let threw = false
  try {
    await fetch(url)
  } catch {
    threw = true
  }
  t.ok(threw, 'connection refused after close')
})
