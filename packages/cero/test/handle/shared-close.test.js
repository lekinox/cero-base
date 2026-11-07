import test from 'brittle'

import { open, invite } from '../../src/lib/operators.js'
import { makeTestnet, openHandle, waitUntil } from '../helpers/index.js'

test.configure({ timeout: 90000 })

// One device, one room, two holders (a screen and a background task). cero hands both the same handle; when one
// is done and closes it, the other must keep working
test('a room opened twice and closed once still works for the other holder', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'owner-root' })
  const made = await open(a.me.team, { name: 'clinic' })
  const id = made.id
  await made.close()

  const screen = await open(a.me.team, { id })
  const task = await open(a.me.team, { id })
  t.teardown(() => screen.close().catch(() => {}))
  await task.close()

  try {
    t.ok(await invite(screen, {}), 'the screen still makes a code')
  } catch (err) {
    t.fail(`the screen's room was closed under it: ${err.code}: ${err.message}`)
  }
})

// the last close lets the room linger, a quick reopen gets it still open, and it closes once nobody opened it again
test('a room its last holder closed lingers for a quick reopen, then closes', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet, opts: { linger: 500 } })
  const room = await open(a.me.team, { name: 'clinic' })
  await room.close()
  t.absent(room.closing, 'still open right after its last close')
  const again = await open(a.me.team, { id: room.id })
  t.is(again, room, 'a reopen gets the same room, never rebuilt')
  await new Promise((r) => setTimeout(r, 1000))
  t.absent(room.closing, 'reopened: no close comes')
  await again.close()
  await waitUntil(() => room.closed, 5000)
  t.ok(room.closed, 'closed once it lingered with nobody holding it')
})

test('linger 0 closes with the last holder at once', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet, opts: { linger: 0 } })
  const room = await open(a.me.team, { name: 'clinic' })
  await room.close()
  t.ok(room.closed)
})

// an owner with a room and its code, and a second device to join it (linger 0: a let-go room closes at once)
async function joining(t) {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'owner-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  const code = await invite(room, { reuse: true })
  const b = await openHandle(t, { testnet, opts: { linger: 0 } })
  return { b, code }
}

test('two joins of one code at once each hold the room: one closing leaves it to the other', async (t) => {
  const { b, code } = await joining(t)
  const [first, second] = await Promise.all([
    open(b.me.team, { invite: code }),
    open(b.me.team, { invite: code })
  ])
  t.is(first, second, 'the same room')
  await first.close()
  t.absent(second.closing, 'still open for the other')
  t.ok(await invite(second, {}), 'and it works')
  await second.close()
  t.ok(second.closed, 'the last close closes it')
})

test('joining a room this device already holds adds a hold', async (t) => {
  const { b, code } = await joining(t)
  const first = await open(b.me.team, { invite: code })
  const again = await open(b.me.team, { invite: code })
  t.is(again, first)
  await again.close()
  t.absent(first.closing, 'the first join still holds it')
  await first.close()
  t.ok(first.closed)
})

test('leaving a room that lingers closes it at once', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet, opts: { linger: 60000 } })
  await a.me.store.bootstrap({ name: 'owner-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  const other = await open(a.me.team, { name: 'other' })
  await other.close()
  t.absent(other.closing, 'lingering')
  await a.me.close()
  t.ok(other.closed, 'closing the device closes a lingering room with it')
  t.ok(room.closed)
})
