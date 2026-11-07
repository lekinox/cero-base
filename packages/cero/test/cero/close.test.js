// Work that races a device's close fails as closing, never as a half-closed storage
import test from 'brittle'
import { Identity } from '@cero-base/core/identity'
import { cero, put, send } from '../../src/index.js'
import { spec } from '../fixtures/spec/index.js'
import { makeTestnet, waitUntil } from '../helpers/index.js'

test.configure({ timeout: 90000 })

async function device(t, opts = {}) {
  const testnet = await makeTestnet(t)
  const errors = []
  const me = await cero(await t.tmp(), spec, {
    bootstrap: testnet.bootstrap,
    onerror: (e) => errors.push(e),
    ...opts
  })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return { me, testnet, errors }
}

test('close: a close under writes reports nothing', async (t) => {
  const { me, errors } = await device(t)
  const room = await cero.open(me.team, { name: 'clinic' })
  const writing = (async () => {
    for (let i = 0; i < 50; i++) await put(room.messages, { text: `m${i}` }).catch(() => {})
  })()
  await new Promise((r) => setTimeout(r, 20))
  await me.close()
  await writing
  t.alike(
    errors.map((e) => e.message),
    [],
    'no closed-storage error reaches onerror'
  )
})

test('close: a send racing the close fails as closing, never as closed storage', async (t) => {
  const { me } = await device(t)
  const closing = me.close()
  const err = await send(me, cero.address(Identity.randomBytes(32)), 'x').catch((e) => e)
  await closing
  t.is(err?.code, 'CLOSED', 'CLOSED')
  t.absent(/Storage/.test(err?.message), `about the mailbox, not storage: ${err?.message}`)
})

test('close: a send after the close fails as closing', async (t) => {
  const { me } = await device(t)
  await me.close()
  const err = await send(me, cero.address(Identity.randomBytes(32)), 'x').catch((e) => e)
  t.is(err?.code, 'CLOSED')
  t.absent(/Storage/.test(err?.message), err?.message)
})

test('close: it still opens again on the same storage', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  await put(me.messages, { text: 'kept' })
  await me.close()
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}))
  await waitUntil(async () => (await cero.get(again.messages)).data.length === 1)
  t.pass('reopened with its data')
})
