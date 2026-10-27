import Hypercore from 'hypercore'
import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import safetyCatch from 'safety-catch'
import c from 'compact-encoding'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'
import fs from 'fs'

import { Identity } from '@cero-base/core/identity'
import { Network } from '@cero-base/core/network'
import { Mailbox } from '@cero-base/core/mailbox'
import { Pairing } from '@cero-base/core/pairing'
import { Invite } from '@cero-base/core/invite'
import { epochEntries } from '@cero-base/core/database/encryption'
import { CeroError } from '@cero-base/core/errors'

import { Handle, Ref } from './handle/index.js'
import { Local, box } from './local/index.js'
import { Bluetooth } from './lib/bluetooth.js'
import * as verbs from './lib/operators.js'
import { peek } from './lib/peek.js'
import { t, schema } from './lib/spec.js'
import { FLUSH, TIMEOUT } from './lib/constants.js'

export { Handle, Ref, Local }
export * from './lib/operators.js'
export { peek } from './lib/peek.js'
export { t, schema } from './lib/spec.js'

/**
 * @typedef {import('./handle/index.js').Context} Context
 */

/**
 * @typedef {object} CeroOpts
 * @property {string} [phrase]                         The identity's BIP-39 phrase, as `cero.phrase(me)` gives it: on a new `dir` it recovers that identity.
 * @property {string} [invite]                         A device invite, as `cero.invite(me)` gives it on another device of yours: on a new `dir` this device joins that identity once a device of it accepts, with no phrase.
 * @property {(id: string) => void} [onrequest]         With `invite`: called with the request's id as it is sent, the same id `me.requests` shows on the accepting device.
 * @property {12 | 24} [words]                         Mnemonic length when generating a fresh identity.
 * @property {string | null} [name]                    Friendly device name persisted on the identity claim.
 * @property {boolean} [isMobile]                      Marks this device as mobile.
 * @property {Array<{ host: string, port: number }>} [bootstrap]  Custom DHT bootstrap nodes.
 * @property {number[]} [backoffs]                     Swarm reconnect backoff tiers in ms (testing/tuning).
 * @property {string} [channel]                        Optional network-isolation label; only same-channel peers connect.
 * @property {Array<string | Uint8Array>} [mirrors]    Blind-peer public keys. Handles and files are mirrored through them so peers sync even when never online at the same time. Mirrors hold only encrypted blocks — they never read your data.
 * @property {{ active?: number, announced?: number, idle?: number }} [presence]  How many handles search, how many only announce, and the idle ms before the rest leave the swarm.
 * @property {(err: Error) => void} [onerror]            Where background errors go; the console without one.
 * @property {number} [recoveryTimeout]                Max wait to find another device and be admitted, in ms. Defaults to 30000.
 * @property {Uint8Array} [storageKey]                 32-byte key encrypting local key material (master seed, device keypairs) at rest. Source it from the OS keychain — cero never stores it.
 * @property {import('./extensions/index.js').Extension[]} [extensions]  The extensions this instance runs, instead of the ones the spec carries. Build with the same list.
 * @property {{ on?: boolean, topic?: string, backend?: object | null, maxOutbound?: number, maxInbound?: number, pipe?: 'l2cap' | 'gatt' }} [bluetooth]  Bluetooth at start: `on` (off by default) and `topic` (the default one, else the channel's own); the app turns the radio on and off with `cero.nearby`, and nothing is stored. `maxOutbound`/`maxInbound` cap concurrent outbound links and inbound sessions. `pipe` picks the data pipe, `'l2cap'` (default, faster) or `'gatt'`; both peers must match. `backend` injects a bare-bluetooth-shaped backend (tests); with none on the host, `status.nearby` reads `'unsupported'`.
 */

/**
 * Open (or create) a cero handle at `dir`.
 *
 * @param {string} dir       Data directory.
 * @param {import('./lib/spec.js').Spec} spec  Built spec, the output of `cero/build`.
 * @param {CeroOpts} [opts]
 * @returns {Promise<Context>}
 */
async function start(dir, spec, opts = {}) {
  if (typeof dir !== 'string' || !dir) throw CeroError.INVALID('dir must be a non-empty string')
  if (!spec) throw CeroError.REQUIRED('spec')
  const bt = opts.bluetooth ?? {}
  if (typeof bt !== 'object') {
    throw CeroError.INVALID('bluetooth takes { on, topic, pipe, maxOutbound, maxInbound }')
  }

  const storage = new HypercoreStorage(`${dir}/main`)
  let store = null
  let local = null
  let network = null
  let discovery = null
  let bluetooth = null
  let me = null
  // background failures reach opts.onerror, else the console, never silence
  const onerror = opts.onerror || ((err) => console.error(err))
  opts = { ...opts, onerror }
  // any failure during open must close what opened, or the storage lock leaks
  try {
    await storage.ready()
    await fs.promises.chmod(`${dir}/main`, 0o700)
    store = new Corestore(storage, { manifestVersion: 2 })
    await store.ready()
    store.watch((core) => {
      const session = new Hypercore({ core, weak: true })
      session.on('verification-error', onerror)
      session.on('invalid-request', onerror)
      session.on('conflict', () => onerror(CeroError.CONFLICT(`fork on core ${session.id}`)))
    })

    local = new Local(null, spec, { store, storageKey: opts.storageKey })
    await local.ready()

    const device = (await local.store.get('keypair')).data
    const done = !!device && !device.setup
    if (done && opts.invite) {
      throw CeroError.INVALID('dir holds an identity: a device invite needs a fresh one')
    }
    // a device invite, this launch's or the one a killed launch was waiting on
    const pending = done || opts.phrase ? null : await pendingLink(local)
    const linking = !done && !opts.phrase && !!(opts.invite || pending)
    const resolved = linking ? null : await resolveIdentity(opts, local, done)
    // cero creates only an identity it minted, in this launch or in the killed one it resumes
    const creating =
      !done && !linking && !opts.phrase && (resolved.fresh || device?.setup === 'create')
    const recovering = !done && !linking && !creating
    const setup = done ? null : linking ? 'link' : creating ? 'create' : 'recover'
    const keyPair =
      done || device?.setup === setup
        ? { publicKey: device.publicKey, secretKey: device.secretKey }
        : Identity.randomKeyPair()
    // the key before the seed: a seed stored without its create would read as one to recover
    if (!done && device?.setup !== setup) {
      await local.store.set('keypair', { ...keyPair, setup })
    }
    if (resolved?.minted) {
      await local.store.set('master', { seed: resolved.identity.seed })
      await local.store.set('device', pack(resolved.identity))
    }
    const timeout = opts.recoveryTimeout ?? TIMEOUT

    // a storage remembers its channel; reopening under another would silently rejoin the global network
    const stored = (await local.store.get('environment')).data?.channel ?? null
    const wanted = opts.channel ?? null
    if (stored == null && wanted != null) {
      await local.store.set('environment', { channel: wanted })
    } else if (stored != null && stored !== wanted) throw CeroError.CHANNEL_MISMATCH()

    network = new Network({
      bootstrap: opts.bootstrap,
      backoffs: opts.backoffs,
      channel: opts.channel,
      store,
      mirrors: opts.mirrors,
      presence: opts.presence,
      onerror
    })
    await network.ready()
    // the link first: who this device is comes with the reply
    const linked = linking
      ? await ask(local, network, spec, { ...opts, writer: keyPair, timeout }, pending)
      : null
    const identity = linked ? linked.identity : resolved.identity
    const fresh = resolved?.fresh === true
    // the radio before the pointer read: a phrase recovers from a device in range, no internet
    bluetooth = new Bluetooth(network, { ...bt, identity, keyPair })
    await bluetooth.ready()
    discovery = network.join(identity.topic)
    // a fresh identity has no peers yet, flushing the announce would only delay onboarding
    if (!fresh) await Promise.race([discovery.flush(), new Promise((r) => setTimeout(r, FLUSH))])

    // the pointer core: identity-signed, written once by the creating device, holds the root key
    const manifest = pointerManifest(store, identity)
    const pointer = store.get(
      creating
        ? { keyPair: await Identity.keyPair(identity.seed), manifest }
        : { key: Hypercore.key(manifest) }
    )
    await pointer.ready()
    network.attach(pointer)

    const key = recovering ? await readPointer(pointer, timeout) : linked?.key

    me = new Handle({
      storage,
      store,
      local,
      discovery,
      identity,
      network,
      spec,
      opts,
      dir,
      key,
      keyPair,
      epochs: linked?.epochs,
      bluetooth,
      bootstrap: done
        ? null
        : {
            name: opts.name || null,
            isMobile: opts.isMobile === true,
            recovering: recovering || linking,
            timeout
          }
    })
    // an extension's hooks see every op the root applies; what else it calls waits for the open
    const setups = Promise.all(me.extensions.map(async (ext) => ext.setup?.(me)))
    setups.catch(() => {}) // a failed setup surfaces below, once the root can close
    await me.ready()
    me.once('close', () => pointer.close().catch(safetyCatch))

    if (!done) {
      if (creating && pointer.length === 0) {
        await pointer.append(c.encode(c.fixed32, me.store.key))
      }
      if (linked) {
        await local.store.set('device', pack(identity))
        await local.store.del('joins', linked.id)
      }
      await local.store.set('keypair', { setup: null })
    }

    for (const off of await setups) {
      if (typeof off === 'function') me.once('close', off)
    }

    return me
  } catch (err) {
    // before the root opens, tear the raw resources down in reverse order
    if (me?.opened) await me.close().catch(safetyCatch)
    else {
      await me?.store.close().catch(safetyCatch)
      await discovery?.destroy().catch(safetyCatch)
      await bluetooth?.close().catch(safetyCatch)
      await network?.close().catch(safetyCatch)
      await local?.close().catch(safetyCatch)
      await store?.close().catch(safetyCatch)
      await storage.close().catch(safetyCatch)
    }
    throw err
  }
}

/**
 * Restore a cero instance from a recovery phrase.
 *
 * @param {Context} me  The root to restore.
 * @param {string} phrase  The identity's BIP-39 phrase, as `cero.phrase(me)` gives it.
 * @returns {Promise<Handle>}  Freshly restored root handle.
 */
export async function restore(me, phrase) {
  if (!me?._dir) throw CeroError.INVALID('me must be a cero instance')
  if (!phrase) throw CeroError.REQUIRED('phrase')

  const current = await Identity.create({ seed: Identity.toSeed(phrase) })
  if (current.id === me.identity.id) return me

  // everything carries over except the identity, the channel above all
  const { _dir: dir, spec, _opts: opts } = me

  await me.close()
  await fs.promises.rm(`${dir}/main`, { recursive: true, force: true })

  return start(dir, spec, { ...opts, phrase })
}

/**
 * Link this device to the identity behind a device invite: closes `me`, deletes `dir/main` and
 * opens the directory with `invite`, as a new device of that identity, with no phrase on it.
 *
 * @param {Context} me  The root to replace.
 * @param {string} invite  A device invite, as `cero.invite(me)` gives it on a device of that identity.
 * @param {{ onrequest?: (id: string) => void }} [opts]  `onrequest`: the request's id as it is sent, the one the accepting device sees in `me.requests`.
 * @returns {Promise<Handle>}  The linked root handle.
 */
export async function link(me, invite, { onrequest } = {}) {
  if (!me?._dir) throw CeroError.INVALID('me must be a cero instance')
  if (!invite) throw CeroError.REQUIRED('invite')

  const { _dir: dir, spec, _opts: opts } = me

  await me.close()
  await fs.promises.rm(`${dir}/main`, { recursive: true, force: true })

  // the other device is in someone's other hand: the wait is the invite's lifetime, deny ends it
  return start(dir, spec, { ...opts, phrase: undefined, invite, onrequest, recoveryTimeout: 0 })
}

// the facade: cero.put and import { put } are the same function
/** @type {typeof start & typeof verbs & { t: typeof t, schema: typeof schema, peek: typeof peek, restore: typeof restore, link: typeof link }} */
export const cero = Object.assign(start, verbs, { t, schema, peek, restore, link })

function pointerManifest(store, identity) {
  return { version: store.manifestVersion, signers: [{ publicKey: identity.publicKey }] }
}

async function readPointer(pointer, timeout) {
  try {
    return c.decode(c.fixed32, await pointer.get(0, { timeout }))
  } catch {
    throw CeroError.TIMEOUT('recovery: finding a device of this identity')
  }
}

// the identity as this device holds it: stored, or minted now from the phrase or afresh
async function resolveIdentity(opts, local, done) {
  const provided = opts.phrase ? Identity.toSeed(opts.phrase) : null
  const seed = (await local.store.get('master')).data?.seed ?? null
  const row = (await local.store.get('device')).data
  if (seed && !row) throw CeroError.INVALID('this storage predates device keys: recreate it')
  const same =
    row && provided ? b4a.equals((await Identity.keyPair(provided)).publicKey, row.identity) : true
  // another identity comes in only through restore, which wipes this one first
  if (done && !same) throw CeroError.INVALID('dir holds another identity: switch with cero.restore')
  // a phrase given to an unfinished setup takes over from the identity it minted
  if (row && same) return { identity: unpack(row, seed), fresh: false, minted: false }
  const identity = await Identity.create({ seed: provided, words: opts.words })
  return { identity, fresh: !provided, minted: true }
}

// the root's own join in the joins rows
const LINK = 'root'

async function pendingLink(local) {
  const { data: rows } = await local.store.get('joins')
  return rows.find((row) => row.type === LINK) ?? null
}

// the root's join: this device, bare, knocks with the invite and waits for a device of the identity
// to let it in. What it learns is kept in its joins row, so a killed launch resumes it
async function ask(local, network, spec, { invite, writer, onrequest, timeout }, pending) {
  const parsed = Invite.parse(invite ?? pending.invite)
  if (parsed.data?.byteLength !== 32) throw CeroError.INVALID_INVITE('not a device invite')
  const secret = pending?.device ?? Identity.randomKeyPair().secretKey
  const device = { publicKey: secret.subarray(32), secretKey: secret }
  const row = {
    ...pending,
    id: b4a.toHex(parsed.discoveryKey),
    type: LINK,
    invite: invite ?? pending.invite,
    publicKey: writer.publicKey,
    secretKey: writer.secretKey,
    device: secret
  }
  await local.store.put('joins', row)
  let reply = row.key
    ? { ...row, epochs: row.epochs ? c.decode(epochEntries, row.epochs) : [] }
    : null
  if (!reply) {
    const { store } = network
    const inbox = box(local.store, 'inbox')
    const outbox = box(local.store, 'outbox')
    const mailbox = new Mailbox(network, { inbox, outbox })
    await mailbox.ready()
    try {
      const signers = [{ publicKey: writer.publicKey }]
      onrequest?.(hid.encode(Hypercore.key({ version: store.manifestVersion, signers })))
      // the reply is kept before the join settles, a denial forgets the join
      const keep = async (answer) => {
        if (answer instanceof Error) return local.store.del('joins', row.id)
        const { key, encryptionKey, epochs, proof } = answer
        const kept = { ...row, key, encryptionKey, epochs: c.encode(epochEntries, epochs), proof }
        await local.store.put('joins', kept)
      }
      const identity = await Identity.bare(device)
      reply = await Pairing.join(mailbox, row.invite, { identity, spec, writer, timeout, keep })
    } finally {
      await mailbox.close()
    }
  }
  // the chain the accepting device wrote ends at this device, under the identity the invite named
  const chained = Identity.verify(reply.proof, null, parsed.data)
  if (!chained || !b4a.equals(chained.device, device.publicKey)) {
    throw CeroError.INVALID('the reply does not link this device to the identity of the invite')
  }
  const { encryptionKey, proof } = reply
  const identity = Identity.from({ publicKey: parsed.data, encryptionKey, device, proof })
  return { identity, key: reply.key, epochs: reply.epochs, id: row.id }
}

function pack({ device, proof, publicKey, encryptionKey }) {
  const { publicKey: key, secretKey } = device
  return { publicKey: key, secretKey, proof, identity: publicKey, encryptionKey }
}

function unpack({ publicKey, secretKey, proof, identity, encryptionKey }, seed) {
  const device = { publicKey, secretKey }
  return Identity.from({ publicKey: identity, encryptionKey, device, proof, seed })
}
