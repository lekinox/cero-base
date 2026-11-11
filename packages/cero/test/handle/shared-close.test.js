import test from 'brittle'

import { open, invite } from '../../src/lib/operators.js'
import { makeTestnet, openHandle } from '../helpers/index.js'

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

// a device that keeps `keepOpen` rooms nobody holds, with `count` rooms it made and still holds
async function rooms(t, keepOpen, count) {
  const { me } = await openHandle(t, { opts: { keepOpen } })
  const made = []
  for (let i = 0; i < count; i++) made.push(await open(me.team, { name: `room ${i}` }))
  return { me, made }
}

test('past keepOpen, the room let go longest ago closes and the others stay open', async (t) => {
  const { made } = await rooms(t, 2, 4)
  const [first, second, third, fourth] = made
  await first.close()
  await second.close()
  t.absent(first.closing, 'two rooms nobody holds stay open')
  await second.close()
  t.absent(second.closing, 'a close nobody held it for changes nothing')
  await third.close()
  t.ok(first.closed, 'the third one closed the least recently used')
  t.absent(second.closing, 'the second stays open')
  t.absent(third.closing, 'and the third')
  await fourth.close()
  t.ok(second.closed, 'the fourth one closed the next')
  t.absent(third.closing)
  t.absent(fourth.closing)
})

test('an idle room opened again is the same room, and the most recently used', async (t) => {
  const { me, made } = await rooms(t, 2, 3)
  const [first, second, third] = made
  await first.close()
  await second.close()
  const again = await open(me.team, { id: first.id })
  t.is(again, first, 'a reopen gets the same room, never rebuilt')
  await again.close()
  await third.close()
  t.ok(second.closed, 'the one let go before it closed')
  t.absent(first.closing, 'the reopened one stays open')
  t.absent(third.closing)
})

test('a room somebody holds is never closed by the count', async (t) => {
  const { me, made } = await rooms(t, 1, 3)
  const [held, second, third] = made
  const also = await open(me.team, { id: held.id })
  await also.close()
  await second.close()
  await third.close()
  t.ok(second.closed, 'the idle one made room')
  t.absent(held.closing, 'the held one stays, however long ago it was opened')
  t.ok(await invite(held, {}), 'and it works')
})

test('keepOpen 0 closes with the last holder at once', async (t) => {
  const { made } = await rooms(t, 0, 2)
  const [room, broken] = made
  await room.close()
  t.ok(room.closed)
  // its own close, so its failure is the caller's
  const close = broken.store.close.bind(broken.store)
  broken.store.close = async () => {
    await close()
    throw new Error('disk full')
  }
  const err = await broken.close().catch((e) => e)
  t.is(err?.message, 'disk full')
})

// an owner with a room and its code, and a second device to join it (keepOpen 0: a let-go room closes at once)
async function joining(t) {
  const testnet = await makeTestnet(t)
  const a = await openHandle(t, { testnet })
  await a.me.store.bootstrap({ name: 'owner-root' })
  const room = await open(a.me.team, { name: 'clinic' })
  const code = await invite(room, { reuse: true })
  const b = await openHandle(t, { testnet, opts: { keepOpen: 0 } })
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

test('closing the device closes its idle rooms with it', async (t) => {
  const { me, made } = await rooms(t, 2, 3)
  const [held, first, second] = made
  await first.close()
  await second.close()
  t.absent(first.closing, 'idle')
  t.absent(second.closing, 'idle')
  await me.close()
  t.ok(first.closed, 'the idle rooms closed with the device')
  t.ok(second.closed)
  t.ok(held.closed, 'and the held one')
})
