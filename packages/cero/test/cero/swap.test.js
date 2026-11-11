// Another identity comes in beside this one (keet-core's restore and pairing): until it has opened, this one stays open
// with its data, and a launch after a failed or killed swap opens it again
import test from 'brittle'
import fs from 'fs'
import { cero, put, get, restore } from '../../src/index.js'
import { spec } from '../fixtures/spec/index.js'
import { makeTestnet, waitUntil, ceroOpen } from '../helpers/index.js'

test.configure({ timeout: 90000 })

const asked = (me) =>
  waitUntil(async () => (await get(me.requests)).data.find((r) => !r.admitted) || null)

// this device with something written, and the phrase of an identity nobody here can recover: no device holds it
async function mine(t, opts = {}) {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap, recoveryTimeout: 1000, ...opts })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  await put(me.messages, { text: 'mine' })
  const other = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  const phrase = await cero.phrase(other)
  await other.close()
  return { me, dir, testnet, phrase }
}

async function kept(t, me, id) {
  t.is(me.id, id, 'the same identity')
  t.absent(me.closing, 'still open')
  t.is((await get(me.messages)).data[0]?.text, 'mine', 'its data there')
  await put(me.messages, { text: 'and writable' })
}

test('restore: a phrase no device answers for keeps this identity open, with its data', async (t) => {
  const { me, phrase } = await mine(t)
  const id = me.id
  await t.exception(restore(me, phrase), /TIMEOUT/)
  await kept(t, me, id)
})

test('restore: the launch after a failed recovery opens this identity, nothing left to retry', async (t) => {
  const { me, dir, testnet, phrase } = await mine(t)
  const id = me.id
  await t.exception(restore(me, phrase), /TIMEOUT/)
  await me.close()
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap, recoveryTimeout: 1000 })
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  await kept(t, again, id)
  t.absent(fs.existsSync(`${dir}/main.next`), 'no half-made identity on disk')
})

test('restore: a bad phrase changes nothing', async (t) => {
  const { me } = await mine(t)
  const id = me.id
  await t.exception(restore(me, 'not a phrase at all'), /BIP-39/)
  await kept(t, me, id)
})

test('restore: a phrase a device answers for swaps, and the old data goes', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => a.close().catch(() => {}), { order: 5 })
  const { me } = await mine(t, { bootstrap: testnet.bootstrap })
  const restored = await restore(me, await cero.phrase(a))
  t.teardown(() => restored.close().catch(() => {}), { order: 4 })
  t.is(restored.id, a.id, 'the phrase’s identity')
  t.ok(me.closed, 'the old one closed')
  t.is((await get(restored.messages)).data.length, 0, 'none of the old data')
  t.absent(fs.existsSync(`${restored._dir}/main.next`), 'nothing left beside it')
})

test('link: a mistyped code changes nothing', async (t) => {
  const { me } = await mine(t)
  const id = me.id
  await t.exception(cero.link(me, 'nothing like a code'), /INVALID_INVITE/)
  await kept(t, me, id)
})

test('link: a code that is no device invite changes nothing', async (t) => {
  const { me } = await mine(t)
  const id = me.id
  const room = await cero.open(me.team, { name: 'clinic' })
  const roomCode = await cero.invite(room)
  await t.exception(cero.link(me, roomCode), /INVALID_INVITE/)
  await kept(t, me, id)
})

test('link: a denied link keeps this identity open, and the next launch opens it', async (t) => {
  const a = await ceroOpen(t)
  const { me, dir } = await mine(t, { bootstrap: a.testnet.bootstrap })
  const id = me.id
  const linking = cero.link(me, await cero.invite(a.me))
  linking.catch(() => {})
  await cero.deny(a.me, await asked(a.me), 'not mine')
  await t.exception(linking, /DENIED/)
  await kept(t, me, id)
  await me.close()
  const again = await cero(dir, spec, { bootstrap: a.testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  t.is(again.id, id, 'this identity, not the one it asked for')
})

test('link: a second link while one waits replaces it, and the second goes through', async (t) => {
  const a = await ceroOpen(t)
  const { me } = await mine(t, { bootstrap: a.testnet.bootstrap })
  const first = cero.link(me, await cero.invite(a.me))
  first.catch(() => {})
  await asked(a.me)
  let id = null
  const second = cero.link(me, await cero.invite(a.me), { onrequest: (r) => (id = r) })
  second.catch(() => {})
  await t.exception(first, /CLOSED/, 'the first ends')
  // the one the second link shows; the first's request stays listed there until it expires
  await cero.accept(
    a.me,
    await waitUntil(async () =>
      (await get(a.me.requests)).data.find((r) => !r.admitted && r.id === id)
    )
  )
  const linked = await second
  t.teardown(() => linked.close().catch(() => {}), { order: 4 })
  t.is(linked.id, a.me.id, 'linked')
})

test('link: a close while it waits ends it CLOSED, and the next launch opens this identity', async (t) => {
  const a = await ceroOpen(t)
  const { me, dir } = await mine(t, { bootstrap: a.testnet.bootstrap })
  const id = me.id
  let request = null
  const linking = cero.link(me, await cero.invite(a.me), { onrequest: (r) => (request = r) })
  linking.catch(() => {})
  await waitUntil(() => request)
  await me.close()
  await t.exception(linking, /CLOSED/)
  t.absent(fs.existsSync(`${dir}/main.next`), 'nothing left beside it')
  const again = await cero(dir, spec, { bootstrap: a.testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  await kept(t, again, id)
})

test('restore: a close while it looks for a device ends it CLOSED, and the next launch opens this identity', async (t) => {
  // no timeout: only the close ends the wait
  const { me, dir, testnet, phrase } = await mine(t, { recoveryTimeout: 0 })
  const id = me.id
  const restoring = restore(me, phrase)
  restoring.catch(() => {})
  await waitUntil(() => fs.existsSync(`${dir}/main.next/main`))
  await me.close()
  await t.exception(restoring, /CLOSED/)
  t.absent(fs.existsSync(`${dir}/main.next`), 'nothing left beside it')
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  await kept(t, again, id)
})

test('link: a close as the incoming identity closes ends it CLOSED, and this identity stays', async (t) => {
  const a = await ceroOpen(t)
  let closing = null
  // the incoming identity starting to close: the swap is one step from its commit
  const hook = (root) => {
    root.own({ destroy: () => root !== me && (closing = me.close()) })
  }
  const { me, dir } = await mine(t, { bootstrap: a.testnet.bootstrap, extensions: [hook] })
  const id = me.id
  const linking = cero.link(me, await cero.invite(a.me))
  linking.catch(() => {})
  await cero.accept(a.me, await asked(a.me))
  await t.exception(linking, /CLOSED/)
  await closing
  t.absent(fs.existsSync(`${dir}/main.next`), 'nothing left beside it')
  const again = await cero(dir, spec, { bootstrap: a.testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  await kept(t, again, id)
})

test('link: a close once the swap commits lets it finish, and the next launch opens the new identity', async (t) => {
  const a = await ceroOpen(t)
  let signal = null
  // what stops the incoming identity while it opens
  const hook = (root) => {
    signal = root._opts.signal ?? signal
  }
  const { me, dir } = await mine(t, { bootstrap: a.testnet.bootstrap, extensions: [hook] })
  let closing = null
  // this identity closing under the swap: the commit is under way
  me.own({ destroy: () => (closing = me.close()) })
  const linking = cero.link(me, await cero.invite(a.me))
  await cero.accept(a.me, await asked(a.me))
  const linked = await linking
  t.ok(closing, 'closed under the commit')
  await closing
  t.absent(signal.aborted, 'not stopped')
  t.is(linked.id, a.me.id, 'linked')
  await linked.close()
  const again = await cero(dir, spec, { bootstrap: a.testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  t.is(again.id, a.me.id, 'the new identity')
  t.absent(fs.existsSync(`${dir}/main.next`), 'nothing left beside it')
})

test('swap: a launch after a swap killed while it waited drops the half-made identity', async (t) => {
  const { me, dir, testnet } = await mine(t)
  const id = me.id
  await me.close()
  fs.mkdirSync(`${dir}/main.next/main`, { recursive: true })
  fs.writeFileSync(`${dir}/main.next/main/junk`, 'half made')
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  await kept(t, again, id)
  t.absent(fs.existsSync(`${dir}/main.next`), 'dropped')
})

test('swap: a launch after a swap killed between its two renames finishes it', async (t) => {
  const testnet = await makeTestnet(t)
  const dir = await t.tmp()
  const old = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  await old.close()
  const next = await t.tmp()
  const incoming = await cero(next, spec, { bootstrap: testnet.bootstrap })
  const id = incoming.id
  await incoming.close()
  // killed after main moved aside, before the new one took its place
  fs.renameSync(`${dir}/main`, `${dir}/main.old`)
  fs.mkdirSync(`${dir}/main.next`)
  fs.renameSync(`${next}/main`, `${dir}/main.next/main`)
  const me = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 4 })
  t.is(me.id, id, 'the new identity')
  t.absent(fs.existsSync(`${dir}/main.old`), 'the old one gone')
  t.absent(fs.existsSync(`${dir}/main.next`))
})

test('swap: a launch after a swap killed once main moved aside, nothing beside it, opens the old one', async (t) => {
  const { me, dir, testnet } = await mine(t)
  const id = me.id
  await me.close()
  fs.renameSync(`${dir}/main`, `${dir}/main.old`)
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  await kept(t, again, id)
  t.absent(fs.existsSync(`${dir}/main.old`))
})

test('swap: peek after a swap killed between its renames finds the identity and creates nothing', async (t) => {
  const { me, dir } = await mine(t)
  await me.close()
  fs.renameSync(`${dir}/main`, `${dir}/main.old`)
  t.ok(await cero.peek(dir, spec), 'an identity is there')
  t.absent(fs.existsSync(`${dir}/main`), 'no empty store made where the identity belongs')
})

// a real swap made to fail at one of its renames, then launched again: the identity is the one settle keeps
async function failAt(t, which) {
  const testnet = await makeTestnet(t)
  const a = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => a.close().catch(() => {}), { order: 5 })
  const { me, dir } = await mine(t, { bootstrap: testnet.bootstrap })
  const id = me.id
  const rename = fs.promises.rename
  let n = 0
  fs.promises.rename = async (...args) => {
    if (++n === which) throw new Error('killed')
    return rename(...args)
  }
  t.teardown(() => {
    fs.promises.rename = rename
  })
  await t.exception(restore(me, await cero.phrase(a)), /killed/)
  fs.promises.rename = rename
  const again = await cero(dir, spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => again.close().catch(() => {}), { order: 4 })
  return { again, id, a }
}

test('swap: killed at its first rename, the old identity opens on the next launch', async (t) => {
  const { again, id } = await failAt(t, 1)
  t.is(again.id, id)
  t.is((await get(again.messages)).data[0]?.text, 'mine')
})

test('swap: killed at its second rename, the old identity opens on the next launch', async (t) => {
  // the incoming store was dropped with the failure, so settle brings main.old back
  const { again, id } = await failAt(t, 2)
  t.is(again.id, id)
  t.is((await get(again.messages)).data[0]?.text, 'mine')
})

test('swap: another launch of the dir while a link waits leaves the incoming identity alone', async (t) => {
  const a = await ceroOpen(t)
  const { me, dir } = await mine(t, { bootstrap: a.testnet.bootstrap })
  let id = null
  const linking = cero.link(me, await cero.invite(a.me), { onrequest: (r) => (id = r) })
  linking.catch(() => {})
  await waitUntil(() => id)
  // the dir is in use: it opens nowhere, and the link it would have dropped goes on
  await t.exception(cero(dir, spec, { bootstrap: a.testnet.bootstrap }))
  await cero.accept(
    a.me,
    await waitUntil(async () =>
      (await get(a.me.requests)).data.find((r) => !r.admitted && r.id === id)
    )
  )
  const linked = await linking
  t.teardown(() => linked.close().catch(() => {}), { order: 4 })
  t.is(linked.id, a.me.id, 'linked')
})

test('swap: another process launching the dir while it is open leaves main.next alone', async (t) => {
  const { me, dir, testnet } = await mine(t)
  // what a swap staged in another process: this process's own bookkeeping does not know it
  fs.mkdirSync(`${dir}/main.next/main`, { recursive: true })
  fs.writeFileSync(`${dir}/main.next/main/staged`, 'in use')
  await t.exception(cero(dir, spec, { bootstrap: testnet.bootstrap }))
  t.ok(fs.existsSync(`${dir}/main.next/main/staged`), 'the incoming identity is still there')
  await kept(t, me, me.id)
})
