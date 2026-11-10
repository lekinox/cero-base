import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hypercore from 'hypercore'

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
    pending: () => [...mail.values()].filter((m) => !m.handled).length,
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

test('Mailbox.keyPair opens what was encrypted to the address', (t) => {
  const secret = crypto.randomBytes(32)
  const pair = Mailbox.keyPair(secret)
  t.alike(pair.publicKey, Mailbox.getAddress(secret))
  const sealed = crypto.encrypt(b4a.from('who'), Mailbox.getAddress(secret))
  t.alike(crypto.decrypt(sealed, pair), b4a.from('who'))
  t.is(crypto.decrypt(sealed, Mailbox.keyPair(crypto.randomBytes(32))), null)
})

test('Mailbox: requires a network', (t) => {
  t.exception(() => new Mailbox(), /network is required/)
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
  await waitFor(async () => (await b.inbox.list()).every((m) => m.handled))
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
  const net = await peer(t, testnet)
  const before = new Mailbox(net, { inbox })
  const arrived = new Promise((resolve) => {
    before.receive(secret, () => {
      resolve()
      return new Promise(() => {}) // never finishes handling
    })
  })
  await sender.send(address, b4a.from('unhandled'))
  await arrived
  await before.close()
  await sender.close()
  t.is(inbox.mail.size, 1, 'kept while unhandled')

  const after = new Mailbox(net, { inbox })
  t.teardown(() => after.close())
  const got = await new Promise((resolve) => after.receive(secret, resolve))
  t.alike(b4a.toString(got), 'unhandled')
  await waitFor(() => inbox.pending() === 0)
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
  await waitFor(() => inbox.pending() === 0)
})

test('Mailbox: the inbox hands over only the kept mail for its own address', async (t) => {
  const testnet = await makeTestnet(t)
  const inbox = kept()
  const [one, two] = [crypto.randomBytes(32), crypto.randomBytes(32)]
  const sender = await mailbox(t, testnet)
  const net = await peer(t, testnet)

  // received at both, handled at neither before the device stops
  const before = new Mailbox(net, { inbox })
  const never = () => new Promise(() => {})
  before.receive(one, never)
  before.receive(two, never)
  await sender.send(Mailbox.getAddress(one), b4a.from('for one'))
  await sender.send(Mailbox.getAddress(two), b4a.from('for two'))
  await waitFor(() => inbox.pending() === 2, { timeout: 30000 })
  await before.close()

  const owner = new Mailbox(net, { inbox })
  t.teardown(() => owner.close())
  const got = []
  owner.receive(one, (message) => got.push(b4a.toString(message)))
  await waitFor(() => inbox.pending() === 1)
  t.alike(got, ['for one'])
  const [left] = [...inbox.mail.values()].filter((m) => !m.handled)
  t.alike(left.address, Mailbox.getAddress(two), 'the other address keeps its mail')
})

test('Mailbox: an outbox row that does not say it is sealed is sealed before it goes out', async (t) => {
  const testnet = await makeTestnet(t)
  const outbox = kept()
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)
  const name = b4a.toHex(crypto.randomBytes(32))
  await outbox.put({ id: 'old', name, address, message: b4a.from('in the clear'), keep: true })

  const owner = await mailbox(t, testnet)
  const got = []
  owner.receive(secret, (message) => got.push(b4a.toString(message)))
  const sender = await mailbox(t, testnet, { outbox })
  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, ['in the clear'])
  const core = sender.network.store.get({ name })
  t.teardown(() => core.close())
  t.is(b4a.indexOf(await core.get(0), b4a.from('in the clear')), -1, 'not in the clear')
})

test('Mailbox: neither box keeps a message as it was sent', async (t) => {
  const testnet = await makeTestnet(t)
  const outbox = kept()
  const a = await mailbox(t, testnet, { outbox })
  const inbox = kept()
  const b = await mailbox(t, testnet, { inbox })
  const secret = crypto.randomBytes(32)
  const sent = []
  const put = outbox.put
  outbox.put = async (m) => sent.push(m) && put(m)
  const received = []
  const take = inbox.put
  inbox.put = async (m) => received.push(m) && take(m)

  const got = []
  b.receive(secret, (message) => got.push(b4a.toString(message)))
  await a.send(Mailbox.getAddress(secret), b4a.from('secret words'))
  await waitFor(() => got.length > 0, { timeout: 30000 })

  const text = b4a.from('secret words')
  t.ok(received.length > 0)
  for (const m of [...sent, ...received]) t.is(b4a.indexOf(m.message, text), -1, 'not in a row')
  t.alike(crypto.decrypt(sent[0].message, Mailbox.keyPair(secret)), text, 'sent sealed')
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
  t.is(box.mail.size, 1, 'nothing kept but that the real one was handled')
  await forged.close()
})

function holds(net, key) {
  return net.store.storage.hasCore(crypto.discoveryKey(key))
}

// the message itself, not only the core it came in
async function readable(net, key) {
  if (!(await holds(net, key))) return false
  const core = net.store.get({ key })
  try {
    return await core.has(0)
  } finally {
    await core.close()
  }
}

// a kept box that also lists the cores its mail arrived in
function watched() {
  const box = kept()
  box.keys = []
  const put = box.put
  box.put = async (m) => {
    if (!m.handled) box.keys.push(b4a.from(m.id, 'hex'))
    return put(m)
  }
  return box
}

// the key of the core a mail travels in, without opening it: an open session would stop the erase
async function sentKey(net, mail) {
  const { publicKey } = await net.store.createKeyPair(mail.name)
  return Hypercore.key({ version: net.store.manifestVersion, signers: [{ publicKey }] })
}

test('Mailbox: keep false erases a message on both ends once read', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const inbox = watched()
  const b = await mailbox(t, testnet, { inbox })
  const secret = crypto.randomBytes(32)

  b.receive(secret, () => {}, { keep: false })
  await a.send(Mailbox.getAddress(secret), b4a.from('gone'), { keep: false })

  await waitFor(() => inbox.keys.length > 0, { timeout: 30000 })
  const [key] = inbox.keys
  await waitFor(async () => !(await holds(b.network, key)))
  t.pass('erased by the receiver once handled')
  await waitFor(async () => !(await holds(a.network, key)))
  t.pass('erased by the sender once read')
})

test('Mailbox: a message is kept on both ends by default', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const inbox = watched()
  const b = await mailbox(t, testnet, { inbox })
  const secret = crypto.randomBytes(32)

  b.receive(secret, () => {})
  await a.send(Mailbox.getAddress(secret), b4a.from('kept'))

  await waitFor(() => inbox.keys.length > 0 && inbox.pending() === 0, { timeout: 30000 })
  await waitFor(async () => (await a.outbox.list()).length === 0)
  const [key] = inbox.keys
  t.ok(await holds(b.network, key), 'the receiver keeps it')
  t.ok(await holds(a.network, key), 'the sender keeps it')
})

test('Mailbox: a restart sends again on the same core, written once', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await peer(t, testnet)
  const outbox = kept()
  const secret = crypto.randomBytes(32)

  const before = new Mailbox(net, { outbox })
  await before.send(Mailbox.getAddress(secret), b4a.from('once'))
  await before.close()
  const [mail] = outbox.mail.values()

  const inbox = watched()
  const owner = await mailbox(t, testnet, { inbox })
  owner.receive(secret, () => {})
  const after = new Mailbox(net, { outbox })
  t.teardown(() => after.close())
  await after.ready()
  await waitFor(() => inbox.keys.length > 0 && outbox.mail.size === 0, { timeout: 30000 })

  const core = net.store.get({ name: mail.name })
  await core.ready()
  t.teardown(() => core.close())
  t.alike(inbox.keys, [core.key], 'the same core, not a second one')
  t.is(core.length, 1, 'written once, not again on the restart')
})

test('Mailbox: keep false still reaches an offline owner through a mirror', async (t) => {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const secret = crypto.randomBytes(32)

  const sender = new Mailbox(await peer(t, testnet, { mirrors: [mirror] }))
  await sender.send(Mailbox.getAddress(secret), b4a.from('held'), { keep: false })
  const [mail] = await sender.outbox.list()
  await waitFor(async () => (await sender.outbox.list()).length === 0, { timeout: 30000 })
  const key = await sentKey(sender.network, mail)
  await waitFor(async () => !(await holds(sender.network, key)))
  t.pass('erased by the sender once the mirror read it')
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
  const got = await new Promise((resolve) => owner.receive(secret, resolve, { keep: false }))
  t.alike(b4a.toString(got), 'held')
  await waitFor(async () => !(await holds(net, key)))
  t.pass('erased by the owner once handled')
})

test('Mailbox: keep false on the sender alone leaves the receiver its copy', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const inbox = watched()
  const b = await mailbox(t, testnet, { inbox })
  const secret = crypto.randomBytes(32)

  b.receive(secret, () => {})
  await a.send(Mailbox.getAddress(secret), b4a.from('mine'), { keep: false })

  await waitFor(() => inbox.keys.length > 0 && inbox.pending() === 0, { timeout: 30000 })
  const [key] = inbox.keys
  await waitFor(async () => !(await holds(a.network, key)))
  t.pass('the sender erased it')
  t.ok(await holds(b.network, key), 'the receiver keeps it')
})

test('Mailbox: keep false on the receiver alone leaves the sender its copy', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const inbox = watched()
  const b = await mailbox(t, testnet, { inbox })
  const secret = crypto.randomBytes(32)

  b.receive(secret, () => {}, { keep: false })
  await a.send(Mailbox.getAddress(secret), b4a.from('yours'))

  await waitFor(() => inbox.keys.length > 0, { timeout: 30000 })
  const [key] = inbox.keys
  await waitFor(async () => !(await holds(b.network, key)))
  t.pass('the receiver erased it')
  await waitFor(async () => (await a.outbox.list()).length === 0)
  t.ok(await holds(a.network, key), 'the sender keeps it')
})

test('Mailbox: keep false erases nothing before someone read it', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)

  await a.send(Mailbox.getAddress(secret), b4a.from('waiting'), { keep: false })
  const [mail] = await a.outbox.list()
  const key = await sentKey(a.network, mail)
  await waitFor(async () => await holds(a.network, key))

  t.ok(await holds(a.network, key), 'still held while nobody read it')
  t.is((await a.outbox.list()).length, 1, 'still in the outbox')
  t.is(mail.keep, false, 'the outbox remembers to erase it')
})

test('Mailbox: keep false erases nothing an onmessage throws on', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const inbox = watched()
  const errors = []
  const b = await mailbox(t, testnet, { inbox, onerror: (err) => errors.push(err) })
  const secret = crypto.randomBytes(32)

  b.receive(
    secret,
    () => {
      throw new Error('not now')
    },
    { keep: false }
  )
  await a.send(Mailbox.getAddress(secret), b4a.from('retry me'))

  await waitFor(() => errors.length > 0, { timeout: 30000 })
  const [key] = inbox.keys
  t.ok(await holds(b.network, key), 'the core stays for the next try')
  t.is(inbox.mail.size, 1, 'and so does the mail')
})

test('Mailbox: keep false erases every one of several messages', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const inbox = watched()
  const b = await mailbox(t, testnet, { inbox })
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)

  const got = []
  b.receive(secret, (message) => got.push(b4a.toString(message)), { keep: false })
  for (const word of ['one', 'two', 'three']) {
    await a.send(address, b4a.from(word), { keep: false })
  }

  await waitFor(() => got.length === 3, { timeout: 30000 })
  t.alike(got.sort(), ['one', 'three', 'two'])
  t.is(new Set(inbox.keys.map((k) => b4a.toHex(k))).size, 3, 'one core each')
  for (const key of inbox.keys) {
    await waitFor(async () => !(await holds(a.network, key)) && !(await holds(b.network, key)))
  }
  t.pass('all erased on both ends')
})

test('Mailbox: keep false outlives a sender restart', async (t) => {
  const testnet = await makeTestnet(t)
  const net = await peer(t, testnet)
  const outbox = kept()
  const secret = crypto.randomBytes(32)

  const before = new Mailbox(net, { outbox })
  await before.send(Mailbox.getAddress(secret), b4a.from('later'), { keep: false })
  await before.close()
  const [mail] = outbox.mail.values()
  const key = await sentKey(net, mail)

  const owner = await mailbox(t, testnet)
  const got = []
  owner.receive(secret, (message) => got.push(b4a.toString(message)))
  const after = new Mailbox(net, { outbox })
  t.teardown(() => after.close())
  await after.ready()

  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, ['later'])
  await waitFor(async () => !(await holds(net, key)))
  t.pass('erased once read after the restart')
})

test('Mailbox: keep false erases mail handed over again after a receiver restart', async (t) => {
  const testnet = await makeTestnet(t)
  const inbox = watched()
  const secret = crypto.randomBytes(32)
  const sender = await mailbox(t, testnet)
  const net = await peer(t, testnet)

  const before = new Mailbox(net, { inbox })
  const arrived = new Promise((resolve) => {
    before.receive(secret, () => {
      resolve()
      return new Promise(() => {}) // stops before it is handled
    })
  })
  await sender.send(Mailbox.getAddress(secret), b4a.from('again'))
  await arrived
  await before.close()
  const [key] = inbox.keys
  t.ok(await holds(net, key), 'held while unhandled')

  const after = new Mailbox(net, { inbox })
  t.teardown(() => after.close())
  const got = await new Promise((resolve) => after.receive(secret, resolve, { keep: false }))
  t.alike(b4a.toString(got), 'again')
  await waitFor(async () => !(await holds(net, key)))
  t.pass('erased once handled')
})

test('Post: given a name, it travels in the store core of that name', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await peer(t, testnet)
  const name = b4a.toHex(crypto.randomBytes(32))
  const address = Mailbox.getAddress(crypto.randomBytes(32))

  const post = new Post(a, address, b4a.from('named'), { name })
  await post.ready()
  t.alike(post.key, await sentKey(a, { name }))
  await post.close()

  const again = new Post(a, address, b4a.from('named'), { name })
  await again.ready()
  t.alike(again.key, post.key, 'the same core again')
  const core = a.store.get({ key: again.key })
  await core.ready()
  t.is(core.length, 1, 'the message is not written twice')
  await core.close()
  await again.close()
})

test('Post: key is null until opened', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await peer(t, testnet)
  const post = new Post(a, Mailbox.getAddress(crypto.randomBytes(32)), b4a.from('x'))
  t.is(post.key, null)
  await post.ready()
  t.is(post.key.byteLength, 32)
  await post.close()
})

test('Inbox: a message that does not open leaves no core behind', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await peer(t, testnet)
  const box = kept()
  const b = await mailbox(t, testnet, { inbox: box })
  const secret = crypto.randomBytes(32)
  const got = []
  b.receive(secret, (m) => got.push(m))

  // announced at our address, sealed to someone else's
  const forged = a.store.get({ name: 'forged' })
  await forged.ready()
  await forged.append(
    crypto.encrypt(b4a.from('not yours'), Mailbox.getAddress(crypto.randomBytes(32)))
  )
  const post = new Post(a, Mailbox.getAddress(secret), null, { core: forged })
  t.teardown(() => post.close())
  await post.ready()
  await post.delivered

  await waitFor(async () => !(await holds(b.network, forged.key)))
  t.pass('the core it came in is gone')
  t.is(got.length, 0, 'nothing handed over')
  t.is(box.mail.size, 0, 'nothing kept')
})

// announce keys at an address from a peer of its own, as anyone who knows the address can
function announce(t, net, address, keys) {
  const entries = keys.map((key) => ({ key, length: 1 }))
  const session = net.wakeup.session(address, {
    discoveryKey: crypto.discoveryKey(address),
    onpeeractive: (peer) => session.announce(peer, entries)
  })
  for (const peer of session.peers) if (peer.active) session.announce(peer, entries)
  const discovery = net.join(crypto.discoveryKey(address))
  t.teardown(() => {
    session.destroy()
    return discovery.destroy()
  })
}

async function counted(net, keys) {
  let n = 0
  for (const key of keys) if (await holds(net, key)) n++
  return n
}

test('Inbox: a key nobody serves leaves no core behind once its read times out', async (t) => {
  const testnet = await makeTestnet(t)
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)
  b.receive(secret, () => {})

  const keys = [crypto.randomBytes(32), crypto.randomBytes(32)]
  announce(t, await peer(t, testnet), Mailbox.getAddress(secret), keys)

  await waitFor(async () => (await counted(b.network, keys)) > 0, { timeout: 30000 })
  t.pass('read')
  await waitFor(async () => (await counted(b.network, keys)) === 0, { timeout: 45000 })
  t.pass('nothing stored once the reads gave up')
})

test('Inbox: a flood of announced keys holds a few cores open, and mail from another peer arrives', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)
  const got = []
  const inbox = b.receive(secret, (message) => got.push(b4a.toString(message)))

  const keys = Array.from({ length: 200 }, () => crypto.randomBytes(32))
  const flood = await peer(t, testnet)
  announce(t, flood, Mailbox.getAddress(secret), keys)
  await waitFor(async () => (await counted(b.network, keys)) > 0, { timeout: 30000 })

  // before any of the flood's reads gives up
  await a.send(Mailbox.getAddress(secret), b4a.from('real'))
  await waitFor(() => got.length > 0, { timeout: 20000 })
  t.alike(got, ['real'])
  t.ok((await counted(b.network, keys)) <= 4, 'a few of the flood open at a time')
  t.ok(inbox._mail.size <= 33, 'a few of the flood queued, and the real one')

  await flood.close()
  await waitFor(() => inbox._mail.size <= 5)
  t.pass('a peer gone takes its queue along')
})

test('Inbox: many peers flooding together hold a bounded number of cores open', async (t) => {
  const testnet = await makeTestnet(t)
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)
  const inbox = b.receive(secret, () => {})

  const all = []
  for (let i = 0; i < 5; i++) {
    const keys = Array.from({ length: 8 }, () => crypto.randomBytes(32))
    all.push(...keys)
    announce(t, await peer(t, testnet), Mailbox.getAddress(secret), keys)
  }
  await waitFor(() => inbox._mail.size === all.length, { timeout: 30000 })
  t.is(inbox._reading, 16, 'sixteen read at once')
})

test('Inbox: messages being handled count against the sixteen read at once', async (t) => {
  const testnet = await makeTestnet(t)
  const b = await mailbox(t, testnet, { inbox: kept() })
  const secret = crypto.randomBytes(32)
  let calls = 0
  const inbox = b.receive(secret, () => {
    calls++
    return new Promise(() => {})
  })

  for (let i = 0; i < 5; i++) {
    const sender = await mailbox(t, testnet)
    for (let j = 0; j < 5; j++) await sender.send(Mailbox.getAddress(secret), b4a.from('slow'))
  }
  await waitFor(() => inbox._mail.size === 25 && calls === 16, { timeout: 30000 })
  t.is(inbox._reading, 16)
  t.is(calls, 16, 'sixteen in the app at most')
})

test('Inbox: a message handled past the read timeout gives its slot back and stays in the box', async (t) => {
  const testnet = await makeTestnet(t)
  const box = kept()
  const b = await mailbox(t, testnet, { inbox: box })
  const secret = crypto.randomBytes(32)
  let calls = 0
  b.receive(secret, () => {
    calls++
    return new Promise(() => {})
  })

  for (let i = 0; i < 4; i++) {
    const sender = await mailbox(t, testnet)
    for (let j = 0; j < 4; j++) await sender.send(Mailbox.getAddress(secret), b4a.from('slow'))
  }
  await waitFor(() => calls === 16, { timeout: 30000 })
  const late = await mailbox(t, testnet)
  await late.send(Mailbox.getAddress(secret), b4a.from('next'))
  await waitFor(() => calls === 17, { timeout: 45000 })
  t.is(box.pending(), 17, 'none of them marked handled')
})

test('Inbox: a peer reconnecting in a loop holds no more cores open than once', async (t) => {
  const testnet = await makeTestnet(t)
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)
  const inbox = b.receive(secret, () => {})

  const flood = await peer(t, testnet)
  const keys = Array.from({ length: 200 }, () => crypto.randomBytes(32))
  announce(t, flood, Mailbox.getAddress(secret), keys)
  await waitFor(() => inbox._reading > 0, { timeout: 30000 })
  for (let i = 0; i < 4; i++) {
    const before = [...inbox._turns.keys()]
    for (const conn of flood.connections) conn.destroy()
    const back = () => [...inbox._turns.keys()].some((peer) => !before.includes(peer))
    await waitFor(() => back() && before.every((peer) => !inbox._turns.has(peer)), {
      timeout: 20000
    })
  }
  t.is(inbox._reading, 4, 'four at once, however often it came back')
})

test('Inbox: mail a silent peer announced first still arrives through the peer that serves it', async (t) => {
  const testnet = await makeTestnet(t)
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)
  const got = []
  b.receive(secret, (message) => got.push(b4a.toString(message)))

  const honest = await peer(t, testnet)
  const core = honest.store.get({ name: 'mail' })
  await core.ready()
  await core.append(crypto.encrypt(b4a.from('real'), address))

  let heard = 0
  const spy = b.network.wakeup.session(address, {
    discoveryKey: crypto.discoveryKey(address),
    onannounce: (entries) => {
      if (entries.some((entry) => b4a.equals(entry.key, core.key))) heard++
    }
  })
  t.teardown(() => spy.destroy())

  // its reads all taken by keys nobody serves, the real key queued behind them
  const silent = await peer(t, testnet)
  const junk = Array.from({ length: 4 }, () => crypto.randomBytes(32))
  announce(t, silent, address, [...junk, core.key])
  await waitFor(() => heard === 1, { timeout: 30000 })

  const post = new Post(honest, address, null, { core })
  t.teardown(() => post.close())
  await post.ready()
  await waitFor(() => heard === 2, { timeout: 30000 })
  await silent.close()
  await waitFor(() => got.length > 0, { timeout: 20000 })
  t.alike(got, ['real'])
})

test('Inbox: a key whose read gave up is read again through another peer that announced it', async (t) => {
  const testnet = await makeTestnet(t)
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)
  const got = []
  const inbox = b.receive(secret, (message) => got.push(b4a.toString(message)))
  let reads = 0
  const read = inbox._read
  inbox._read = (...args) => {
    reads++
    return read.apply(inbox, args)
  }

  // the core is empty until the first read gave up
  const honest = await peer(t, testnet)
  const writer = crypto.keyPair()
  const core = honest.store.get({
    keyPair: writer,
    manifest: { version: honest.store.manifestVersion, signers: [{ publicKey: writer.publicKey }] }
  })
  t.teardown(() => core.close())
  await core.ready()

  announce(t, await peer(t, testnet), address, [core.key])
  await waitFor(() => reads === 1, { timeout: 30000 })
  announce(t, honest, address, [core.key])
  await waitFor(() => reads === 2, { timeout: 45000 })
  await core.append(crypto.encrypt(b4a.from('real'), address))
  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, ['real'])
})

// handled rows for an address, as the inbox keeps them
async function fill(box, address, n, handled = Date.now()) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const id = b4a.toHex(crypto.randomBytes(32))
    ids.push(id)
    await box.put({ id, address, message: b4a.alloc(0), handled })
  }
  return ids
}

test('Inbox: a handled id is forgotten after 30 days', async (t) => {
  const testnet = await makeTestnet(t)
  const box = kept()
  const secret = crypto.randomBytes(32)
  const [aged] = await fill(box, Mailbox.getAddress(secret), 1, Date.now() - 31 * 864e5)
  const [fresh] = await fill(box, Mailbox.getAddress(secret), 1)
  const b = await mailbox(t, testnet, { inbox: box })
  b.receive(secret, () => {})
  await waitFor(() => !box.mail.has(aged))
  t.ok(box.mail.has(fresh), 'one handled since is kept')
})

test('Inbox: a handled that is no time counts as handled now', async (t) => {
  const testnet = await makeTestnet(t)
  const box = kept()
  const secret = crypto.randomBytes(32)
  const [counted] = await fill(box, Mailbox.getAddress(secret), 1, 7)
  const b = await mailbox(t, testnet, { inbox: box })
  const before = Date.now()
  const inbox = b.receive(secret, () => {})
  await inbox.ready()
  await waitFor(() => box.mail.get(counted)?.handled >= before)
  t.pass('kept, from now on')
})

test('Inbox: at its ceiling of 65536 handled ids the inbox still reads, and the oldest goes', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const box = kept()
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)
  const [oldest] = await fill(box, address, 1, Date.now() - 864e5)
  await fill(box, address, 65535)
  const b = await mailbox(t, testnet, { inbox: box })
  const got = []
  b.receive(secret, (message) => got.push(b4a.toString(message)))
  await a.send(address, b4a.from('real'))

  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, ['real'])
  await waitFor(() => !box.mail.has(oldest))
  t.is(box.mail.size, 65536)
})

test('Inbox: a message onmessage turns away leaves no core behind', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const inbox = watched()
  const b = await mailbox(t, testnet, { inbox })
  const secret = crypto.randomBytes(32)
  const got = []
  b.receive(secret, (message) => {
    got.push(message)
    return false
  })
  await a.send(Mailbox.getAddress(secret), b4a.from('junk'))

  await waitFor(() => got.length > 0, { timeout: 30000 })
  const [key] = inbox.keys
  await waitFor(async () => !(await holds(b.network, key)))
  t.pass('the core it came in is gone')
  t.is(inbox.mail.size, 0, 'nothing kept')
})

test('Inbox: keep false reports a message it could not erase', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await mailbox(t, testnet)
  const box = kept()
  const errors = []
  const b = await mailbox(t, testnet, { inbox: box, onerror: (err) => errors.push(err) })
  const secret = crypto.randomBytes(32)

  // the app holds a session on the core the message came in
  const held = []
  const put = box.put
  box.put = async (m) => {
    const core = b.network.store.get({ key: b4a.from(m.id, 'hex') })
    await core.ready()
    held.push(core)
    return put(m)
  }
  t.teardown(() => Promise.all(held.map((core) => core.close())))

  b.receive(secret, () => {}, { keep: false })
  await a.send(Mailbox.getAddress(secret), b4a.from('held open'))

  await waitFor(() => errors.length > 0, { timeout: 30000 })
  t.is(errors[0].code, 'CONFLICT')
  t.ok(await holds(b.network, held[0].key), 'still held')
})

// a message the owner handles while the sender is gone and a mirror holds it, then the owner's
// inbox starts again: the mirror announces the message once more
async function handledThenRestarted(t, keep, { flood = 0, newer = 0 } = {}) {
  const testnet = await makeTestnet(t)
  const mirror = await makeMirror(t, testnet)
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)
  const a = await peer(t, testnet)
  const post = new Post(a, address, b4a.from('once'), { mirrors: [mirror] })
  await post.ready()
  await post.delivered
  await post.close()
  await a.close()

  const b = await peer(t, testnet, { mirrors: [mirror] })
  const room = b.store.get({ name: 'room' })
  await room.ready()
  await room.append(b4a.from('x'))
  b.attach(room)
  t.teardown(() => room.close())
  const box = kept()
  let calls = 0
  const start = () =>
    new Inbox(b, secret, { box, onmessage: () => calls++, onerror: () => {}, keep })
  const first = start()
  await first.ready()
  await waitFor(() => calls === 1 && box.pending() === 0, { timeout: 30000 })
  if (flood) {
    const sender = new Mailbox(await peer(t, testnet))
    t.teardown(() => sender.close())
    for (let i = 0; i < flood; i++) await sender.send(address, b4a.from('fresh'))
    await waitFor(() => calls === 1 + flood && box.pending() === 0, { timeout: 60000 })
    calls = 1
  }
  await fill(box, address, newer)
  await first.close()

  const again = start()
  t.teardown(() => again.close())
  await again.ready()
  await new Promise((resolve) => {
    const session = b.wakeup.session(address, {
      discoveryKey: crypto.discoveryKey(address),
      onannounce: (entries) => {
        if (!entries.some((entry) => b4a.equals(entry.key, post.key))) return
        session.destroy()
        resolve()
      }
    })
  })
  const id = b4a.toHex(post.key)
  await waitFor(() => calls > 1 || !again._mail.has(id))
  t.is(calls, 1, 'handed over once')
  return { b, key: post.key }
}

test('Inbox: a handled message a mirror announces again is not handed over after a restart', async (t) => {
  const { b, key } = await handledThenRestarted(t, true)
  t.ok(await readable(b, key), 'kept')
})

test('Inbox: a handled message is not handed over again after a flood of fresh ones and a restart', async (t) => {
  await handledThenRestarted(t, true, { flood: 80 })
})

test('Inbox: a handled message is not handed over again after a restart, many newer ones handled', async (t) => {
  await handledThenRestarted(t, true, { newer: 2000 })
})

test('Inbox: keep false, a handled message a mirror announces again is not handed over after a restart', async (t) => {
  const { b, key } = await handledThenRestarted(t, false)
  t.absent(await holds(b, key), 'erased')
})

test('Mailbox: keep false reports a message it could not erase once read', async (t) => {
  const testnet = await makeTestnet(t)
  const errors = []
  const a = await mailbox(t, testnet, { onerror: (err) => errors.push(err) })
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)

  await a.send(Mailbox.getAddress(secret), b4a.from('held open'), { keep: false })
  const [mail] = await a.outbox.list()
  const key = await sentKey(a.network, mail)
  // the app holds a session on the core the message travels in
  const open = a.network.store.get({ name: mail.name })
  await open.ready()
  t.teardown(() => open.close())

  b.receive(secret, () => {})
  await waitFor(() => errors.length > 0, { timeout: 30000 })
  t.is(errors[0].code, 'CONFLICT')
  t.ok(await holds(a.network, key), 'still held')
})

test('Inbox: a core this device already holds is not erased when it does not open', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await peer(t, testnet)
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)
  const got = []
  b.receive(secret, (m) => got.push(b4a.toString(m)))

  // a core of b's own, announced at b's address by someone who knows its key
  const own = b.network.store.get({ name: 'own' })
  await own.ready()
  await own.append(b4a.from('precious'))
  const key = own.key
  await own.close()
  const post = new Post(a, address, null, { core: a.store.get({ key }) })
  t.teardown(() => post.close())
  await post.ready()

  // a real one after it, so we know the announced one was processed first
  const sender = new Mailbox(a)
  t.teardown(() => sender.close())
  await sender.send(address, b4a.from('real'))
  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, ['real'])
  t.ok(await holds(b.network, key), 'still held')
})

test('Inbox: keep false erases only what the inbox fetched', async (t) => {
  const testnet = await makeTestnet(t)
  const a = await peer(t, testnet)
  const b = await mailbox(t, testnet)
  const secret = crypto.randomBytes(32)
  const address = Mailbox.getAddress(secret)

  // a core of b's own whose first block happens to open as mail for b
  const own = b.network.store.get({ name: 'own' })
  await own.ready()
  await own.append(crypto.encrypt(b4a.from('looks like mail'), address))
  const key = own.key
  await own.close()

  const got = []
  b.receive(secret, (m) => got.push(b4a.toString(m)), { keep: false })
  const post = new Post(a, address, null, { core: a.store.get({ key }) })
  t.teardown(() => post.close())
  await post.ready()

  await waitFor(() => got.length > 0, { timeout: 30000 })
  t.alike(got, ['looks like mail'])
  await waitFor(async () => (await b.inbox.list()).every((m) => m.handled))
  t.ok(await holds(b.network, key), 'handled, not erased')
})
