import Hypercore from 'hypercore'
import HypercoreStorage from 'hypercore-storage'
import Corestore from 'corestore'
import safetyCatch from 'safety-catch'
import c from 'compact-encoding'
import fs from 'fs'

import { Identity } from '@cero-base/core/identity'
import { Network } from '@cero-base/core/network'
import { CeroError } from '@cero-base/core/errors'

import { Handle, Ref } from './handle/index.js'
import { Local } from './local/index.js'
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
 * @property {Identity} [identity]                     Pre-resolved identity. If absent, derived from `seed` or generated.
 * @property {Uint8Array} [seed]                       16- or 32-byte seed entropy: `toSeed(phrase)` restores from a phrase.
 * @property {12 | 24} [words]                         Mnemonic length when generating a fresh identity.
 * @property {string | null} [name]                    Friendly device name persisted on the identity claim.
 * @property {boolean} [isMobile]                      Marks this device as mobile.
 * @property {Array<{ host: string, port: number }>} [bootstrap]  Custom DHT bootstrap nodes.
 * @property {number[]} [backoffs]                     Swarm reconnect backoff tiers in ms (testing/tuning).
 * @property {string} [channel]                        Optional network-isolation label; only same-channel peers connect.
 * @property {Array<string | Uint8Array>} [mirrors]    Blind-peer public keys. Rooms and files are mirrored through them so peers sync even when never online at the same time. Mirrors hold only encrypted blocks — they never read your data.
 * @property {{ active?: number, announced?: number, idle?: number }} [presence]  How many rooms search, how many only announce, and the idle ms before the rest leave the swarm.
 * @property {Uint8Array} [key]                        Existing database key to recover into, skipping the pointer lookup.
 * @property {Uint8Array} [encryptionKey]              Pre-existing encryption key.
 * @property {(err: Error) => void} [onerror]            Where background errors go; the console without one.
 * @property {number} [recoveryTimeout]                Max wait to find another device and be admitted, in ms. Defaults to 30000.
 * @property {Uint8Array} [storageKey]                 32-byte key encrypting local key material (master seed, device keypairs) at rest. Source it from the OS keychain — cero never stores it.
 * @property {import('./extensions/index.js').Extension[]} [extensions]  The extensions this instance runs, instead of the ones the spec carries. Build with the same list.
 * @property {boolean | { autoStart?: boolean, backend?: object, maxOutbound?: number, maxInbound?: number, pipe?: 'l2cap' | 'gatt' }} [bluetooth]  `true` enables nearby (Bluetooth) sync, the radio on. `{ autoStart: false }` leaves it off until `cero.nearby(me, true)`. `backend` injects a bare-bluetooth-shaped backend (tests). `maxOutbound`/`maxInbound` cap concurrent outbound links and inbound sessions. `pipe` picks the data pipe, `'l2cap'` (default, faster) or `'gatt'`; both peers must match. Without a backend on the host, `me.status` reports `nearby: 'unsupported'`.
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

    if (spec.local && spec.meta?.local) {
      local = new Local(null, spec, { store, storageKey: opts.storageKey })
      await local.ready()
    }

    const { identity, fresh, seed } = await resolveIdentity(opts, local)
    const device = local ? (await local.store.get('keypair')).data : null
    const done = !!device && !device.setup
    // cero creates only an identity it minted, in this launch or in the killed one it resumes
    const creating =
      !done && !opts.key && !opts.seed && !opts.identity && (fresh || device?.setup === 'create')
    const recovering = !done && !creating
    const setup = done ? null : creating ? 'create' : 'recover'
    const keyPair =
      done || device?.setup === setup
        ? { publicKey: device.publicKey, secretKey: device.secretKey }
        : Identity.randomKeyPair()
    // the key before the seed: a seed stored without its create would read as one to recover
    if (local && !done && device?.setup !== setup) {
      await local.store.set('keypair', { ...keyPair, setup })
    }
    if (local && seed) await local.store.set('master', { seed })
    const timeout = opts.recoveryTimeout || TIMEOUT

    // a storage remembers its channel; reopening under another would silently rejoin the global network
    if (local) {
      const stored = (await local.store.get('environment')).data?.channel ?? null
      const wanted = opts.channel ?? null
      if (stored == null && wanted != null) {
        await local.store.set('environment', { channel: wanted })
      } else if (stored != null && stored !== wanted) throw CeroError.CHANNEL_MISMATCH()
    }

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
    // the radio before the pointer read: a phrase recovers from a device in range, no internet
    if (opts.bluetooth) {
      const bt = opts.bluetooth === true ? {} : opts.bluetooth
      bluetooth = new Bluetooth(network, {
        identity,
        keyPair,
        // an omitted backend lazy-loads bare-bluetooth, null disables it
        backend: bt.backend,
        autoStart: bt.autoStart !== false,
        maxOutbound: bt.maxOutbound,
        maxInbound: bt.maxInbound,
        pipe: bt.pipe
      })
      await bluetooth.ready()
    }
    discovery = network.join(identity.topic)
    // a fresh identity has no peers yet, flushing the announce would only delay onboarding
    if (!fresh) await Promise.race([discovery.flush(), new Promise((r) => setTimeout(r, FLUSH))])

    // the pointer core: identity-signed, written once by the creating device, holds the root key
    const manifest = pointerManifest(store, identity)
    const pointer = store.get(
      creating
        ? { keyPair: { publicKey: identity.publicKey, secretKey: identity.secretKey }, manifest }
        : { key: Hypercore.key(manifest) }
    )
    await pointer.ready()
    network.attach(pointer)

    const key = opts.key || (recovering ? await readPointer(pointer, timeout) : undefined)

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
      encryptionKey: opts.encryptionKey,
      keyPair,
      bluetooth,
      pair: false,
      bootstrap: done
        ? null
        : { name: opts.name || null, isMobile: opts.isMobile === true, recovering, timeout }
    })
    // an extension's hooks see every op the root applies; what else it calls waits for the open
    const setups = Promise.all(me.extensions.map(async (ext) => ext.setup?.(me)))
    setups.catch(() => {}) // a failed setup surfaces below, once the root can close
    await me.ready()
    me.once('close', () => {
      network.detach(pointer)
      pointer.close().catch(safetyCatch)
    })

    if (!done) {
      if (creating && pointer.length === 0) {
        await pointer.append(c.encode(c.fixed32, me.store.key))
      }
      if (local) await local.store.set('keypair', { setup: null })
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
 * Restore a cero instance from a seed.
 *
 * @param {Context} me  The root to restore.
 * @param {Uint8Array} seed   The identity's seed: `toSeed(phrase)` from a phrase.
 * @returns {Promise<Handle>}  Freshly restored root handle.
 */
export async function restore(me, seed) {
  if (!me?._dir) throw CeroError.INVALID('me must be a cero instance')
  // no seed would mint a fresh identity and wipe this one
  if (!seed) throw CeroError.REQUIRED('seed')

  const current = await Identity.create({ seed })
  if (current.id === me.identity.id) return me

  // everything carries over except the identity, the channel above all
  const {
    _dir: dir,
    spec,
    _opts: { identity, key, keyPair, ...opts }
  } = me

  await me.close()
  await fs.promises.rm(`${dir}/main`, { recursive: true, force: true })

  return start(dir, spec, { ...opts, seed })
}

/**
 * The seed a BIP-39 phrase writes out, for `cero(dir, spec, { seed })` and `restore(me, seed)`.
 *
 * @param {string} phrase
 * @returns {Uint8Array}
 */
export function toSeed(phrase) {
  return Identity.toSeed(phrase)
}

// the facade: cero.put and import { put } are the same function
/** @type {typeof start & typeof verbs & { t: typeof t, schema: typeof schema, peek: typeof peek, restore: typeof restore, toSeed: typeof toSeed }} */
export const cero = Object.assign(start, verbs, { t, schema, peek, restore, toSeed })

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

// `seed` is the one to store: supplied or minted, null when already stored
async function resolveIdentity(opts, local) {
  if (opts.identity) return { identity: opts.identity, fresh: false, seed: null }

  const provided = opts.seed
  const stored = !provided && local && (await local.store.get('master')).data?.seed
  const identity = await Identity.create({ seed: provided || stored || null, words: opts.words })
  return { identity, fresh: !provided && !stored, seed: stored ? null : identity.seed }
}
