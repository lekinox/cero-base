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
import {
  put,
  set,
  get,
  del,
  count,
  watch,
  changes,
  call,
  open,
  rotate,
  before,
  after,
  bind,
  define
} from './lib/operators.js'
import { peek } from './lib/peek.js'
import { t, schema } from './lib/spec.js'
import { FLUSH, TIMEOUT } from './lib/constants.js'
import { internal } from './lib/internal.js'

export { Handle, Ref, Local }
export {
  put,
  set,
  get,
  del,
  count,
  watch,
  changes,
  call,
  open,
  rotate,
  before,
  after,
  bind,
  define
} from './lib/operators.js'
export { peek } from './lib/peek.js'
export { t, schema } from './lib/spec.js'

/**
 * @typedef {import('./handle/index.js').CeroHandle} CeroHandle
 */

/**
 * @typedef {object} CeroOpts
 * @property {Identity} [identity]                     Pre-resolved identity. If absent, derived from `seed`/`phrase` or generated.
 * @property {Uint8Array} [seed]                       16- or 32-byte seed entropy.
 * @property {string} [phrase]                         BIP-39 mnemonic — alternative to `seed`.
 * @property {12 | 24} [words]                         Mnemonic length when generating a fresh identity.
 * @property {string | null} [name]                    Friendly device name persisted on the identity claim.
 * @property {boolean} [isMobile]                      Marks this device as mobile.
 * @property {Array<{ host: string, port: number }>} [bootstrap]  Custom DHT bootstrap nodes.
 * @property {number[]} [backoffs]                     Swarm reconnect backoff tiers in ms (testing/tuning).
 * @property {string} [channel]                        Optional network-isolation label; only same-channel peers connect.
 * @property {Array<string | Uint8Array>} [mirrors]    Blind-peer public keys. Rooms and files are mirrored through them so peers sync even when never online at the same time. Mirrors hold only encrypted blocks — they never read your data.
 * @property {Uint8Array} [key]                        Existing database key to recover into, skipping the pointer lookup.
 * @property {Uint8Array} [encryptionKey]              Pre-existing encryption key.
 * @property {Record<string, Function>} [routes]       Custom RPC routes for the database dispatcher.
 * @property {(err: any) => void} [onerror]            Background-task error handler.
 * @property {number} [recoveryTimeout]                Max wait to find another device and be admitted, in ms. Defaults to 30000.
 * @property {Uint8Array} [storageKey]                 32-byte key encrypting local key material (master seed, device keypairs) at rest. Source it from the OS keychain — cero never stores it.
 * @property {boolean} [extensions]                    `false` disables the bundled extensions (profileSync, handleSync) for this instance. Build with `{ extensions: false }` too so the spec matches.
 * @property {boolean | { autoStart?: boolean, backend?: any, maxOutbound?: number, maxInbound?: number, pipe?: 'l2cap' | 'gatt' }} [bluetooth]  `true` enables nearby (Bluetooth) sync via `me.bluetooth` (auto-started). `{ autoStart: false }` creates the facade without starting the radio — the app calls `me.bluetooth.start()`/`stop()` (user toggle). `backend` injects a bare-bluetooth-shaped backend (tests). `maxOutbound`/`maxInbound` cap concurrent outbound links and inbound sessions. `pipe` picks the data pipe — `'l2cap'` (default, faster) or `'gatt'`; both peers must match. Absent backend on an unsupported host → `me.bluetooth.state === 'unsupported'`.
 */

/**
 * Open (or create) a cero handle at `dir`.
 *
 * @param {string} dir       Data directory.
 * @param {any} spec         Built spec — output of `cero/build`.
 * @param {CeroOpts} [opts]
 * @returns {Promise<CeroHandle>}
 */
export async function cero(dir, spec, opts = {}) {
  if (typeof dir !== 'string' || !dir) throw CeroError.INVALID('dir must be a non-empty string')
  if (!spec) throw CeroError.REQUIRED('spec')

  const storage = new HypercoreStorage(`${dir}/main`)
  let store = null
  let local = null
  let network = null
  let discovery = null
  let me = null
  // any failure during open must close what opened, or the storage lock leaks
  try {
    await storage.ready()
    await fs.promises.chmod(`${dir}/main`, 0o700)
    store = new Corestore(storage, { manifestVersion: 2 })
    await store.ready()

    if (spec.local && spec.meta?.local) {
      local = new Local(null, spec, { store, storageKey: opts.storageKey })
      await local.ready()
    }

    const { identity, fresh } = await resolveIdentity(opts, local)
    const writer = local ? (await local.store.get('keypair')).data : null
    // a supplied identity on a device with no writer recovers; only a cero-minted identity creates
    const recovering = !writer && (!!opts.key || !fresh)
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
      mirrors: opts.mirrors
    })
    await network.ready()
    discovery = network.join(identity.topic)
    // a fresh identity has no peers yet, flushing the announce would only delay onboarding
    if (!fresh) await Promise.race([discovery.flush(), new Promise((r) => setTimeout(r, FLUSH))])

    // the pointer core: identity-signed, written once by the creating device, holds the root key
    const manifest = pointerManifest(store, identity)
    const pointer = store.get(
      !writer && !recovering
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
      routes: opts.routes,
      key,
      encryptionKey: opts.encryptionKey,
      keyPair: writer ? { publicKey: writer.publicKey, secretKey: writer.secretKey } : undefined,
      pair: false
    })
    await me.ready()
    me.once('close', () => {
      network.detach(pointer)
      pointer.close().catch(safetyCatch)
    })

    if (!writer) {
      const result = await me.bootstrap({
        name: opts.name || null,
        isMobile: opts.isMobile === true,
        recovering,
        timeout
      })
      if (local) {
        await local.store.set('keypair', {
          publicKey: result.writer.publicKey,
          secretKey: result.writer.secretKey
        })
      }
      if (!recovering) {
        const ts = Date.now()
        await me.store.call('add-member', {
          id: identity.id,
          key: me.store.writerKey,
          role: 'owner',
          name: opts.name || null,
          createdAt: ts,
          updatedAt: ts
        })
        if (pointer.length === 0) await pointer.append(c.encode(c.fixed32, me.store.key))
      }
    }

    for (const ext of internal.extensions) {
      if (ext.bundled && opts.extensions === false) continue
      const off = await ext.setup?.(me)
      if (typeof off === 'function') me.once('close', off)
    }

    if (opts.bluetooth) {
      const bt = opts.bluetooth === true ? {} : opts.bluetooth
      me.bluetooth = new Bluetooth(me, {
        // an omitted backend lazy-loads bare-bluetooth, null disables it
        backend: bt.backend,
        autoStart: bt.autoStart !== false,
        maxOutbound: bt.maxOutbound,
        maxInbound: bt.maxInbound,
        pipe: bt.pipe
      })
      me.once('close', () => me.bluetooth.close().catch(safetyCatch))
      await me.bluetooth.ready()
    }

    bind(me, null)
    return me
  } catch (err) {
    // before the root Handle exists, tear the raw resources down in reverse order
    if (me) await me.close().catch(safetyCatch)
    else {
      await discovery?.destroy().catch(safetyCatch)
      await network?.close().catch(safetyCatch)
      await local?.close().catch(safetyCatch)
      await store?.close().catch(safetyCatch)
      await storage.close().catch(safetyCatch)
    }
    throw err
  }
}

/**
 * Restore a cero instance from a mnemonic phrase.
 *
 * @param {Handle} me   Existing root handle to restore.
 * @param {string} phrase   BIP-39 mnemonic phrase.
 * @returns {Promise<Handle>}  Freshly restored root handle.
 */
export async function restore(me, phrase) {
  if (!me?._dir) throw CeroError.INVALID('me must be a cero instance')
  if (!phrase || typeof phrase !== 'string') throw CeroError.INVALID('phrase must be a string')

  const current = await Identity.fromSeed(Identity.toSeed(phrase))
  if (current.id === me.identity.id) return me

  // everything carries over except the identity, the channel above all
  const {
    _dir: dir,
    spec,
    _opts: { seed, identity, key, keyPair, ...opts }
  } = me

  await me.close()
  await fs.promises.rm(`${dir}/main`, { recursive: true, force: true })

  return cero(dir, spec, { ...opts, phrase })
}

// the facade: cero.put and import { put } are the same function
cero.t = t
cero.put = put
cero.set = set
cero.get = get
cero.del = del
cero.count = count
cero.watch = watch
cero.changes = changes
cero.call = call
cero.open = open
cero.rotate = rotate
cero.before = before
cero.after = after
cero.peek = peek
cero.restore = restore
cero.schema = schema
cero.bind = bind
cero.define = define
// test-only
cero._internal = internal
// a bare function is shorthand for { setup }; a named extension replaces one of the same name
cero.use = (...exts) => {
  for (const e of exts.flat().map((e) => (typeof e === 'function' ? { setup: e } : e))) {
    const i = e.name ? internal.extensions.findIndex((x) => x.name === e.name) : -1
    if (i >= 0) internal.extensions[i] = e
    else internal.extensions.push(e)
  }
}

function pointerManifest(store, identity) {
  return { version: store.manifestVersion, signers: [{ publicKey: identity.publicKey }] }
}

async function readPointer(pointer, timeout) {
  try {
    return c.decode(c.fixed32, await pointer.get(0, { timeout }))
  } catch {
    throw CeroError.TIMED_OUT('recovery: finding a device of this identity')
  }
}

async function resolveIdentity(opts, local) {
  if (opts.identity) return { identity: opts.identity, fresh: false }

  const provided = opts.seed || (opts.phrase && Identity.toSeed(opts.phrase))
  if (provided) {
    if (local) await local.store.set('master', { seed: provided })
    return { identity: await Identity.fromSeed(provided), fresh: false }
  }

  const stored = local && (await local.store.get('master')).data?.seed
  if (stored) return { identity: await Identity.fromSeed(stored), fresh: false }

  const identity = await Identity.generate({ words: opts.words })
  if (local) await local.store.set('master', { seed: identity.seed })
  return { identity, fresh: true }
}
