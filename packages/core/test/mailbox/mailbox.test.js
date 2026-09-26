import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { Network } from '../../src/network/index.js'
import { Mailbox } from '../../src/mailbox/index.js'
import { Inbox } from '../../src/mailbox/inbox.js'
import { Post } from '../../src/mailbox/post.js'
import { makeStore, makeTestnet, makeNet, makeMirror, waitFor } from '../helpers/index.js'

test.configure({ timeout: 90000 })

async function peer(t, testnet, opts) {
  const { store } = await makeStore(t)
  return makeNet(t, testnet, { store, ...opts })
}

async function mailbox(t, testnet, opts) {
  const box = new Mailbox(await peer(t, testnet), opts)
  t.teardown(() => box.close())
  await box.ready()
  return box
}

// a box that outlives the mailbox using it, like one in a local store
function kept() {
  const mail = new Map()
  return {
    mail,
    list: async () => [...mail.values()],
    put: async (m) => mail.set(m.id, m),
    del: async (id) => mail.delete(id)
  }
}

test('Mailbox.getAddress: one secret, one address', (t) => {
  const secret = crypto.randomBytes(32)
  t.alike(Mailbox.getAddress(secret), Mailbox.getAddress(secret))
  t.is(Mailbox.getAddress(secret).byteLength, 32)
  t.absent(b4a.equals(Mailbox.getAddress(crypto.randomBytes(32)), Mailbox.getAddress(secret)))
})

test('Mailbox: requires a store', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await makeNet(t, testnet)
  t.exception(() => new Mailbox(net), /store/)
})

test('Mailbox: send to an address another mailbox receives at', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)

  const got = []
  b.receive(secret, (message) => got.push(b4a.toString(message)))
  await a.send(address, b4a.from('hi'))

  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, ['hi'])
  await waitFor(async () => (await a.outbox.list()).length === 0)
  t.pass('dropped from the outbox once read')
  await waitFor(async () => (await b.inbox.list()).length === 0)
  t.pass('dropped from the inbox once handled')
})

test('Mailbox: what the outbox kept is sent again after a restart', async (t) => {
  const testnet = await makeTestnet(t)
  const outbox = kept()
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)

  // sent while nobody receives, then the sender restarts
  const before = await mailbox(t, testnet, { outbox })
  await before.send(address, b4a.from('kept'))
  await before.close()
  t.is(outbox.mail.size, 1, 'kept while unread')

  const owner = await mailbox(t, testnet)
  const got = []
  owner.receive(secret, (message) => got.push(b4a.toString(message)))
  await mailbox(t, testnet, { outbox })

  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, ['kept'])
  await waitFor(() => outbox.mail.size === 0)
  t.pass('dropped once read')
})

test('Mailbox: what the inbox kept is handed over again after a restart', async (t) => {
  const testnet = await makeTestnet(t)
  const inbox = kept()
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)
  const sender = await mailbox(t, testnet)

  // received, but the device stops before it is handled
  const before = await mailbox(t, testnet, { inbox })
  const arrived = new Promise((resolve) => {
    before.receive(secret, () => {
      resolve()
      return new Promise(() => {}) // never finishes handling
    })
  })
  await sender.send(address, b4a.from('unhandled'))
  await arrived
  await before.close()
  t.is(inbox.mail.size, 1, 'kept while unhandled')

  const after = await mailbox(t, testnet, { inbox })
  const got = await new Promise((resolve) => after.receive(secret, resolve))
  t.alike(b4a.toString(got), 'unhandled')
  await waitFor(() => inbox.mail.size === 0)
  t.pass('dropped once handled')
})

test('Post → Inbox: delivered direct, opened once', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await peer(t, testnet)
  const b = await peer(t, testnet)
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)

  const got = []
  const inbox = new Inbox(b, secret, {
    box: kept(),
    onmessage: (message) => got.push(message),
    onerror: () => {}
  })
  t.teardown(() => inbox.close())
  await inbox.ready()
  const post = new Post(a, address, b4a.from('hello'))
  t.teardown(() => post.close())
  await post.ready()

  await post.delivered
  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, [b4a.from('hello')])
})

test('Post → Inbox: a second post on an already joined address still arrives', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await peer(t, testnet)
  const b = await peer(t, testnet)
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)

  const got = []
  const onmessage = (message) => got.push(b4a.toString(message))
  const inbox = new Inbox(b, secret, { box: kept(), onmessage, onerror: () => {} })
  t.teardown(() => inbox.close())
  await inbox.ready()
  for (const text of ['one', 'two']) {
    const post = new Post(a, address, b4a.from(text))
    t.teardown(() => post.close())
    await post.ready()
    await waitFor(() => got.includes(text), { timeout: 30000 })
  }
  t.alike(got, ['one', 'two'])
})

test('Post → Inbox: through a mirror while the owner is offline', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)

  // the sender has no mirror config: the mirror comes with the post
  const a = await peer(t, testnet)
  const post = new Post(a, address, b4a.from('while you were out'), {
    mirrors: [mirror]
  })
  await post.ready()
  await post.delivered
  await post.close()
  await a.close()

  // the owner comes online only now, the sender is gone; a room it mirrors keeps it on the mirror
  const b = await peer(t, testnet, { mirrors: [mirror] })
  const room = b.store.get({ name: 'room' })
  await room.ready()
  await room.append(b4a.from('x'))
  b.attach(room)
  const got = []
  const inbox = new Inbox(b, secret, {
    box: kept(),
    onmessage: (message) => got.push(message),
    onerror: () => {}
  })
  t.teardown(() => inbox.close())
  await inbox.ready()

  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, [b4a.from('while you were out')])
  await room.close()
})

test('Mailbox: sends before it was opened', async (t) => {
  const testnet = await makeTestnet(t)
  const { store } = await makeStore(t)
  const net = new Network({ bootstrap: testnet.bootstrap, store })
  t.teardown(() => net.close())
  const a = new Mailbox(net)
  t.teardown(() => a.close())
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)

  const got = new Promise((resolve) => b.receive(secret, resolve))
  await a.send(Mailbox.getAddress(secret), b4a.from('early'))
  t.alike(b4a.toString(await got), 'early')
})

test('Mailbox: a message onmessage throws on is kept and reported', async (t) => {
  const testnet = await makeTestnet(t)
  const inbox = kept()
  const errors = []
  const sender = await mailbox(t, testnet)
  const owner = await mailbox(t, testnet, { inbox, onerror: (err) => errors.push(err) })
  const secret = crypto.randomBytes(32)

  owner.receive(secret, () => {
    throw new Error('not now')
  })
  await sender.send(Mailbox.getAddress(secret), b4a.from('retry me'))
  await waitFor(() => errors.length > 0, { timeout: 30000 })
  t.is(errors[0].message, 'not now')
  t.is(inbox.mail.size, 1, 'still in the inbox')

  const got = await new Promise((resolve) => owner.receive(secret, resolve))
  t.alike(b4a.toString(got), 'retry me', 'handed over again the next time the address is received')
  await waitFor(() => inbox.mail.size === 0)
})

test('Mailbox: the inbox hands over only the kept mail for its own address', async (t) => {
  const testnet = await makeTestnet(t)
  const inbox = kept()
  const [one, two] = [crypto.randomBytes(32), crypto.randomBytes(32)]
  await inbox.put({ id: 'a', address: Mailbox.getAddress(one), message: b4a.from('for one') })
  await inbox.put({ id: 'b', address: Mailbox.getAddress(two), message: b4a.from('for two') })

  const owner = await mailbox(t, testnet, { inbox })
  const got = []
  owner.receive(one, (message) => got.push(b4a.toString(message)))
  await waitFor(() => inbox.mail.size === 1)
  t.alike(got, ['for one'])
  t.ok(inbox.mail.has('b'), 'the other address keeps its mail')
})

test('Mailbox: a closed inbox receives nothing, the outbox keeps the message for the next one', async (t) => {
  const testnet = await makeTestnet(t)
  const sender = await mailbox(t, testnet)
  const owner = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)

  const early = []
  const closed = owner.receive(secret, (message) => early.push(message))
  await closed.close()
  await sender.send(Mailbox.getAddress(secret), b4a.from('later'))
  t.is((await sender.outbox.list()).length, 1)

  const got = await new Promise((resolve) => owner.receive(secret, resolve))
  t.alike(b4a.toString(got), 'later')
  t.is(early.length, 0, 'the closed inbox never saw it')
})

test('Mailbox: close closes its inboxes and posts', async (t) => {
  const testnet = await makeTestnet(t)
  const box = await mailbox(t, testnet)
  const inbox = box.receive(crypto.randomBytes(32), () => {})
  await box.send(Mailbox.getAddress(crypto.randomBytes(32)), b4a.from('nobody reads this'))
  await box.close()
  t.ok(inbox.closed)
  t.is(box._resources.size, 0)
  t.is((await box.outbox.list()).length, 1, 'unread mail stays in the outbox')
})

test('Mailbox: close does not wait on a DHT that went away', async (t) => {
  const testnet = await makeTestnet(t)
  const box = await mailbox(t, testnet)
  await box.receive(crypto.randomBytes(32), () => {}).ready()
  await box.send(Mailbox.getAddress(crypto.randomBytes(32)), b4a.from('nobody reads this'))
  await waitFor(() => [...box.network.swarm.topics()].length === 2)
  await box.network.flush({ timeout: 10000 })
  await testnet.destroy()

  let start = Date.now()
  await box.close()
  // a single unannounce to a dead node costs at least one 150 ms request timeout
  t.ok(Date.now() - start < 150, `mailbox closed in ${Date.now() - start} ms`)
  start = Date.now()
  await box.network.close()
  t.ok(Date.now() - start < 1500, `network closed in ${Date.now() - start} ms`)
})

test('Mailbox: sends through the network mirrors while the owner is offline', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const secret = crypto.randomBytes(32)

  const sender = new Mailbox(await peer(t, testnet, { mirrors: [mirror] }))
  await sender.send(Mailbox.getAddress(secret), b4a.from('held'))
  t.alike((await sender.outbox.list())[0].mirrors, [mirror], 'kept with its mirrors')
  await waitFor(async () => (await sender.outbox.list()).length === 0, { timeout: 30000 })
  await sender.close()
  await sender.network.close()

  const net = await peer(t, testnet, { mirrors: [mirror] })
  const room = net.store.get({ name: 'room' })
  await room.ready()
  await room.append(b4a.from('x'))
  net.attach(room)
  t.teardown(() => room.close())
  const owner = new Mailbox(net)
  t.teardown(() => owner.close())
  const got = await new Promise((resolve) => owner.receive(secret, resolve))
  t.alike(b4a.toString(got), 'held')
})

test('Inbox: a message sealed to another address is dropped', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await peer(t, testnet)
  const b = await peer(t, testnet)
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)

  const box = kept()
  const got = []
  const inbox = new Inbox(b, secret, { box, onmessage: (m) => got.push(m), onerror: () => {} })
  t.teardown(() => inbox.close())
  await inbox.ready()

  // announced at our address, sealed to someone else's
  const forged = a.store.get({ name: 'forged' })
  await forged.ready()
  await forged.append(
    crypto.encrypt(b4a.from('not yours'), Mailbox.getAddress(crypto.randomBytes(32)))
  )
  const session = a.wakeup.session(address, {
    discoveryKey: crypto.discoveryKey(address),
    onpeeractive: (peer) => session.announce(peer, [{ key: forged.key, length: 1 }])
  })
  t.teardown(() => session.destroy())
  const discovery = a.join(crypto.discoveryKey(address))
  t.teardown(() => discovery.destroy())
  const read = new Promise((resolve) => forged.once('upload', resolve))
  await read

  // a real one after it, so we know the forged one was processed first
  const post = new Post(a, address, b4a.from('yours'))
  t.teardown(() => post.close())
  await post.ready()
  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, [b4a.from('yours')])
  t.is(box.mail.size, 0, 'nothing kept')
  await forged.close()
})
