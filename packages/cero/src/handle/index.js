import AbortController from 'bare-abort-controller'
import b4a from 'b4a'
import { discoveryKey } from 'hypercore-crypto'
import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import Suspendify from 'suspendify'
import z32 from 'z32'

import { Identity } from '@cero-base/core/identity'
import { Database } from '@cero-base/core/database'
import { blobEpochKey } from '@cero-base/core/database/encryption'
import { Pairing } from '@cero-base/core/pairing'
import { Invite } from '@cero-base/core/invite'
import { Mailbox } from '@cero-base/core/mailbox'
import hid from 'hypercore-id-encoding'
import { admission, onAbort, filter } from '@cero-base/core/utils'
import { CeroError } from '@cero-base/core/errors'
import { Blobs } from '@cero-base/core/blobs'
import { decodeId } from '@cero-base/core/blobs/codec'
import { FileServer } from '@cero-base/core/blobs/server'

import { NS, TIMEOUT } from '../lib/constants.js'

import { Ref } from '../lib/refs.js'
import { Join, wait } from './join.js'
import { box } from '../local/index.js'
import { extensionsOf } from '../extensions/index.js'

export { Ref } from '../lib/refs.js'

/**
 * @typedef {import('@cero-base/core/network').Network} Network
 * @typedef {import('../local/index.js').Local} Local
 * @typedef {import('../lib/spec.js').Spec} Spec
 * @typedef {import('@cero-base/core/identity').KeyPair} KeyPair
 *
 * @typedef {object} HandleOpts
 * @property {Handle} [parent]                 Parent handle when this is a child slot.
 * @property {Identity} [identity]             Long-lived user identity. Inherited from `parent` if omitted.
 * @property {Network} [network]               Shared swarm. Inherited from `parent` if omitted.
 * @property {import('corestore')} [store]    Pre-existing Corestore. Falls back to `parent.store.store`.
 * @property {Spec} [spec]                     Built cero spec.
 * @property {Local} [local]                   Local store for per-handle keypairs.
 * @property {import('hypercore-storage')} [storage]  Owned HypercoreStorage to close on shutdown.
 * @property {{ destroy(): Promise<void> }} [discovery]  Owned identity discovery to destroy on shutdown.
 * @property {string} [dir]                    Data directory (root handles only).
 * @property {import('../index.js').CeroOpts} [opts]  Pass-through cero(...) options.
 * @property {Uint8Array} [key]                Existing database key.
 * @property {Uint8Array} [encryptionKey]      Existing encryption key.
 * @property {Array<{ epoch: number, entropy: Uint8Array }>} [epochs]  Rotation epochs delivered at join.
 * @property {string} [namespace]              Corestore namespace.
 * @property {KeyPair} [keyPair]               Writer keypair.
 * @property {boolean} [pair]                  When `false`, skips creating a `Pairing` session.
 * @property {import('../lib/bluetooth.js').Bluetooth | null} [bluetooth]  Root only: the radio, up before the root opens.
 * @property {{ name?: string | null, isMobile?: boolean, recovering?: boolean, timeout?: number } | null} [bootstrap]  Root only: provision this device as it opens, its genesis or its recovery.
 *
 * @typedef {object} CreateChildOpts
 * @property {string | null} [name]
 *
 * @typedef {object} JoinChildOpts
 * @property {number} [timeout]
 *
 * @typedef {object} StaticJoinOpts
 * @property {Handle} [parent]
 * @property {Network} [network]
 * @property {Identity} [identity]
 * @property {import('corestore')} [store]
 * @property {Spec} [spec]
 * @property {string} [namespace]
 * @property {KeyPair} [writer]                  Writer keypair in the joined handle; a fresh one by default.
 * @property {number} [timeout]
 *
 * @typedef {object} HandleExtra
 * @property {string | null} [name]                       Display name; set on child handles by the owner flow.
 * @property {import('../lib/refs.js').Ref} [profile]    `profile` ref, attached dynamically when the schema declares one.
 * @property {import('../lib/refs.js').Ref} [members]    `members` ref, attached dynamically when the schema declares one.
 *
 * @typedef {Handle & HandleExtra} Child  A child handle plus its dynamically-attached refs.
 *
 * @typedef {Handle & Record<string, import('../lib/refs.js').Ref>} Context  A root or a room: a handle with its refs (`me.profile`, `room.messages`).
 */

/**
 * A cero handle — a single writable database session attached to a swarm.
 */
export class Handle extends ReadyResource {
  /** @param {HandleOpts} [opts] */
  constructor(opts = {}) {
    super()

    const { parent = null } = opts
    const identity = opts.identity || parent?.identity
    const network = opts.network || parent?.network
    const store = opts.store || parent?.store?.store
    const spec = opts.spec

    if (!identity) throw CeroError.REQUIRED('identity')
    if (!network) throw CeroError.REQUIRED('network')
    if (!store) throw CeroError.REQUIRED('store')
    if (!spec) throw CeroError.REQUIRED('spec')

    /** @type {Identity} */
    this.identity = identity
    /** @type {Network} */
    this.network = network
    this.spec = spec
    this.parent = parent

    this.local = opts.local || null
    // one per device: the root's, its boxes in the local store
    /** @type {Mailbox} */
    this.mailbox = parent ? parent.root.mailbox : new Mailbox(network, boxes(this.local))
    /** @private */
    this._storage = opts.storage || null
    /** @private */
    this._discovery = opts.discovery || null
    /** @private */
    this._dir = opts.dir || null
    /** @private */
    this._opts = opts.opts || {}
    /** @type {import('../extensions/index.js').Extension[]} */
    this.extensions = parent?.extensions || extensionsOf(spec, this._opts.extensions)
    /** @private */
    this._onerror = this._opts.onerror || ((err) => console.error(err))
    /** @type {Set<Handle> | null} */
    this.children = parent ? null : new Set()
    /** @private */
    this._typeHooks = parent ? null : new Set()
    /** @private */
    this._loading = parent ? null : new Map()
    /** @private */
    this._joining = parent ? null : new Map() // type/discovery key → Join
    /** @private */
    this._coreKeys = parent ? null : new Map()
    /** @private */
    this._fileServer = null
    /** @private */
    this._blobs = null
    /** @private */
    this._epochBlobs = null
    // root only, serializes suspend/resume and converges rapid bounces
    /** @private */
    this._sus = parent
      ? null
      : new Suspendify({ suspend: () => this._sleep(), resume: () => this._wake() })
    /** @private */
    this._owned = new Set()

    this.store = new Database({
      store: store,
      identity,
      network,
      spec,
      key: opts.key,
      encryptionKey: opts.encryptionKey,
      epochs: opts.epochs,
      namespace: opts.namespace,
      keyPair: opts.keyPair,
      pinned: !parent,
      onerror: this._onerror
    })
    /** @private */
    this._pair = null
    /** @private */
    this._wantsPair = opts.pair !== false
    /** @private */
    this._boot = opts.bootstrap || null
    /** @private */
    this._bluetooth = opts.bluetooth || null
    // refs before the open, so a hook can attach before any op applies
    Ref.attach(this, this.store.refs, this.spec.handles)
    /** @private */
    this._live = {
      status: { get: () => this._status(), watch: (fn) => this._onStatus(fn) },
      ...(!this.parent && {
        joins: { get: (q) => this._joins(q), watch: (fn) => this._onJoins(fn) },
        nearby: { get: () => this._peers(), watch: (fn) => this._onPeers(fn) }
      })
    }
  }

  /**
   * An `AbortSignal` that fires when this handle closes.
   *
   * @returns {AbortSignal}
   */
  get signal() {
    if (!this._ac) {
      /** @private */
      this._ac = new AbortController()
      if (this.closed) this._ac.abort()
      else this.once('close', () => this._ac.abort())
    }
    return this._ac.signal
  }

  /** The top-most handle in the parent chain — itself for a root handle. */
  get root() {
    let h = this
    while (h.parent) h = h.parent
    return h
  }

  /**
   * Lazily-built file server for this identity. Root-only — child handles
   * reach it through `this.root.fileServer`.
   *
   * @returns {FileServer}
   */
  get fileServer() {
    if (this.parent) return this.root.fileServer
    if (!this._fileServer) {
      this._fileServer = new FileServer({
        store: this.store.store,
        resolve: (coreKey, info) => this._resolveCore(coreKey, info)
      })
    }
    return this._fileServer
  }

  /**
   * Lazily-built blob store for THIS handle's writing device, at the current rotation epoch.
   *
   * @returns {Blobs}
   */
  get blobs() {
    const stamp = this.store.keyring.current
    if (!stamp) return this._baseBlobs()
    let blobs = this._epochBlobs?.get(stamp)
    if (!blobs) {
      const entropy = this.store.keyring.entropy(stamp)
      blobs = this._makeBlobs(`blobs-${stamp}`, blobEpochKey(entropy), stamp)
      ;(this._epochBlobs ??= new Map()).set(stamp, blobs)
    }
    return blobs
  }

  /** The handle type of a child, null on the root. */
  get type() {
    return this.spec.meta.type || null
  }

  /**
   * Canonical id: the identity id on the root, the database key on a room.
   *
   * @returns {string | null}
   */
  get id() {
    if (!this.parent) return this.identity.id
    return this.store?.key ? hid.encode(this.store.key) : null
  }

  /**
   * This device's id and name. `null` on a room.
   *
   * @returns {{ id: string, name: string | null } | null}
   */
  get device() {
    if (this.parent) return null
    const k = this.store?.writerKey
    return k ? { id: hid.encode(k), name: this._opts.name || null } : null
  }

  /** @private */
  async _open() {
    await this.store.ready()
    // a fresh device takes writes only once provisioned, and an operator waits for the open
    if (this._boot) await this.store.bootstrap(this._boot)
    if (this._wantsPair) {
      this._pair = new Pairing({ mailbox: this.mailbox, db: this.store })
      await this._pair.ready()
    }
    this.root._coreKeys.set(b4a.toHex(this.store.key), this.store.encryptionKey)
    if (!this.parent) {
      await this.fileServer.listen()
      await this.mailbox.ready()
      if (this._bluetooth) {
        const off = this.store.onUpdate('profile', () => this._tell().catch(this._onerror))
        this.once('close', off)
        await this._tell()
      }
      await this._carryOn().catch(this._onerror)
      this._reserve().catch(this._onerror)
    }
  }

  /** @private */
  async _close() {
    this.root._coreKeys.delete(b4a.toHex(this.store.key))
    if (this._blobs?.key) this.root._coreKeys.delete(b4a.toHex(this._blobs.key))
    for (const b of this._epochBlobs?.values() || []) {
      if (b.key) this.root._coreKeys.delete(b4a.toHex(b.key))
    }
    for (const hex of this._blobKeys || []) this.root._coreKeys.delete(hex)
    for (const r of [...this._owned]) r.destroy?.()
    this._owned.clear()
    if (this._discovery) this._discovery.destroy().catch(safetyCatch)

    const steps = [
      ...[...(this._joining?.values() || [])].map((join) => () => join.close()),
      () => this._blobs?.close(),
      ...[...(this._epochBlobs?.values() || [])].map((b) => () => b.close()),
      ...[...(this.children || [])].map((c) => () => c.close()),
      () => this._pair?.close()
    ]
    this._epochBlobs = null
    this.children?.clear()

    if (this.parent) {
      this.parent.children?.delete(this)
      steps.push(() => this.store.close())
    } else {
      const store = this.store.store
      steps.push(
        () => this.mailbox.close(),
        () => this._bluetooth?.close(),
        () => this.local?.close(),
        async () => {
          await this._fileServer?.close()
          this._fileServer = null
        },
        () => this.store.close(),
        () => this.network.close(),
        () => store.close(),
        () => this._storage?.close()
      )
    }
    await settle(steps)
  }

  /**
   * Tie a destroyable resource (a `watch` stream, a timer, any `{ destroy }`) to this
   * handle's lifecycle — it's destroyed automatically on close, so callers don't track
   * cleanup.
   *
   * @template {{ destroy?: Function, once?: Function }} T
   * @param {T} resource
   * @returns {T}
   */
  own(resource) {
    if (this.closing || this.closed) {
      resource.destroy?.()
      return resource
    }
    this._owned.add(resource)
    resource.once?.('close', () => this._owned.delete(resource))
    return resource
  }

  // a file's url on this device's file server, for the rows that name it
  /** @private */
  _link(id) {
    return this.root.fileServer.getLink(id)
  }

  /**
   * Claim writer capability on an existing database (paired-device flow).
   * Forwards to `Database.claim`.
   *
   * @returns {Promise<void>}
   */
  claim() {
    return this.store.claim()
  }

  // the verbs in lib/operators.js land here

  /** @private */
  async _invite(opts) {
    return this._pairing().invite(opts)
  }

  /** @private */
  async _revoke(invite) {
    return this._pairing().revoke(invite)
  }

  /** @private */
  async _answer(id, { accept, role, reason }) {
    const request = await this._pairing().request(id)
    return accept ? request.accept({ role }) : request.deny(reason)
  }

  /** @private */
  _rotate() {
    return this.store.rotate()
  }

  // the same context, its refs writing into one batch; a fn that ignores it would write outside
  /** @private */
  async _tx(fn) {
    if (typeof fn !== 'function' || fn.length < 1) {
      throw CeroError.INVALID('tx(ctx, fn): fn takes the batch, (tx) => ...')
    }
    return this.store.tx((batch) => {
      const tx = Object.create(this)
      tx.store = batch
      for (const name of Object.keys(this.store.refs)) {
        tx[name] = new Ref(tx, name, this[name].kind, this[name].schema)
      }
      return fn(tx)
    })
  }

  /** @private */
  _pairing() {
    if (!this._pair) throw CeroError.INVALID('the root has no invites, open a room first')
    return this._pair
  }

  /** @private */
  async _leave() {
    if (!this.parent) throw CeroError.INVALID('the root cannot be left')
    await this.store.del('members', this.identity.id)
    await this.parent.store.call('del-handle', { id: hid.encode(this.store.key) })
    await this.close()
  }

  // the app going to the background and back: networking, storage and the radio together
  /** @private */
  async _suspend() {
    await this._lifecycle().suspend()
    this.emit('status')
  }

  /** @private */
  async _resume() {
    await this._lifecycle().resume()
    this.emit('status')
  }

  /** @private */
  _lifecycle() {
    if (!this._sus) {
      throw CeroError.INVALID("suspend and resume are the app's, on me: a room uses cero.activate")
    }
    return this._sus
  }

  // true ranks a room as just used, false takes it off the swarm until something lands in it
  /** @private */
  _active(on) {
    this.store.setActive(on)
  }

  /** @private */
  async _status() {
    const { data: member } = await this.store.get('members', this.identity.id)
    const { current, seqs } = this.store.keyring
    const data = {
      role: member?.role ?? null,
      writable: this.store.writable,
      epoch: (current && seqs.get(current)) || 0,
      suspended: this.root._sus.suspended,
      behind: this.store.behind || 0,
      nearby: this.root._bluetooth?.state ?? null
    }
    return { data }
  }

  /** @private */
  _onStatus(fn) {
    const sources = [
      [this, 'status'],
      [this.store, 'update'],
      [this.store, 'writable'],
      [this.store, 'unwritable'],
      [this.store, 'behind']
    ]
    if (this.parent) sources.push([this.root, 'status'])
    for (const [emitter, event] of sources) emitter.on(event, fn)
    const off = this._onRadio(fn)
    return () => {
      for (const [emitter, event] of sources) emitter.off(event, fn)
      off()
    }
  }

  // the radio is the device's: the mesh (true), off (false), or one invite's rendezvous (a code)
  // until the next call or the invite expires
  /** @private */
  async _nearby(mode) {
    const bt = this.root._bluetooth
    if (!bt) throw CeroError.INVALID('nearby needs cero() to open with the bluetooth option')
    this.root._rendezvous?.()
    this.root._rendezvous = null
    if (mode === false) return bt.stop()
    await bt.start()
    if (typeof mode === 'string') this.root._rendezvous = bt.announce(mode)
  }

  // what a Bluetooth peer hears: the profile's name and whether this device is a phone
  /** @private */
  async _tell() {
    const profile = this.store.refs.profile ? (await this.store.get('profile')).data : null
    const { data: device } = await this.store.get('devices', this.device.id)
    this._bluetooth.tell({ name: profile?.name ?? null, isMobile: device?.isMobile === true })
  }

  // one row a person: two of their devices in range link twice
  /** @private */
  async _peers() {
    const peers = this._bluetooth ? [...this._bluetooth.peers.keys()] : []
    const data = []
    for (const hex of peers) {
      const peer = this._bluetooth.told(hex)
      if (peer) data.push({ ...peer, name: peer.name ?? (await this._nameOf(peer.id)) })
    }
    return { data, total: data.length, size: data.length }
  }

  // a peer's name as its member row shows it in a room open here; a stranger has none
  /** @private */
  async _nameOf(id) {
    for (const room of this.children) {
      const { data } = await room.store.get('members', id)
      if (data?.name) return data.name
    }
    return null
  }

  // a link opening, closing, or a peer telling a new name
  /** @private */
  _onPeers(fn) {
    const off = this._onRadio(fn)
    this.network.on('peer-info', fn)
    return () => {
      off()
      this.network.off('peer-info', fn)
    }
  }

  /** @private */
  _onRadio(fn) {
    const bt = this.root._bluetooth
    if (!bt) return () => {}
    bt.on('update', fn)
    return () => bt.off('update', fn)
  }

  // the joins this device waits on, without the keys the local store keeps for them
  /** @private */
  async _joins(query = {}) {
    const rows = this.local ? (await this.local.store.get('joins')).data : []
    const data = filter(
      rows.map(({ id, type, invite }) => ({ id, type, invite })),
      query
    )
    return { data, total: data.length, size: data.length }
  }

  /** @private */
  _onJoins(fn) {
    if (!this.local) return () => {}
    this.local.store.db.watch(fn)
    return () => this.local.store.db.unwatch(fn)
  }

  /** @private */
  async _phrase() {
    return this.identity.toPhrase()
  }

  /**
   * @param {Uint8Array} coreKey
   * @param {object} info
   * @returns {{ key: Uint8Array, encryptionKey: Uint8Array } | null}
   * @private
   */
  _resolveCore(coreKey, info) {
    const hex = b4a.toHex(coreKey)
    const encryptionKey = this.root._coreKeys.get(hex)
    if (encryptionKey !== undefined) return { key: coreKey, encryptionKey }
    return null
  }

  /** @private */
  _baseBlobs() {
    if (!this._blobs) this._blobs = this._makeBlobs('blobs', this.store.encryptionKey, 0)
    return this._blobs
  }

  /** @private */
  _makeBlobs(name, encryptionKey, stamp) {
    const blobs = new Blobs({
      store: this.store.store,
      network: this.network,
      encryptionKey,
      // every handle shares the device's corestore: one core per handle, or its key serves the others
      name: this.parent ? `${name}/${this.id}` : name
    })
    blobs.stamp = stamp
    blobs
      .ready()
      .then(() => {
        // close prunes _coreKeys first, a late ready() must not re-insert the entry
        if (this.closing || this.closed || !blobs.key) return
        this.root._coreKeys.set(b4a.toHex(blobs.key), encryptionKey)
      })
      .catch(this._onerror)
    return blobs
  }

  /**
   * Remember the blob-core key a file id points at so the file server can open the core.
   *
   * @param {string} id
   * @param {number} [stamp]
   * @private
   */
  _registerBlobCore(id, stamp) {
    if (!id || !this.root?._coreKeys) return
    try {
      const { coreKey } = decodeId(id)
      const hex = b4a.toHex(coreKey)
      if (!this.root._coreKeys.has(hex)) {
        // no stamp on a file-field value, look it up (fire-and-forget, idempotent)
        if (stamp === undefined) {
          this.store
            .get('files', id)
            .then(({ data }) => {
              if (data && !this.closing && !this.closed) this._registerBlobCore(id, data.stamp || 0)
            })
            .catch(safetyCatch)
          return
        }
        const key = this._blobCoreKey(stamp)
        if (!key) return // unknown epoch — this device is not entitled to the core
        this.root._coreKeys.set(hex, key)
      }
      // remember which handle read it, so close prunes the entry
      if (this !== this.root) (this._blobKeys ??= new Set()).add(hex)
    } catch {
      // ignore invalid ids
    }
  }

  /**
   * The bytes of a file this handle holds, fetched from a peer when this device lacks them.
   *
   * @param {string} id
   * @returns {Promise<Uint8Array>}
   * @private
   */
  async _bytes(id) {
    const { coreKey, blobId } = decodeId(id)
    const { data } = await this.store.get('files', id)
    const encryptionKey = data && this._blobCoreKey(data.stamp || 0)
    if (!encryptionKey) throw CeroError.UNKNOWN('file', id)
    const blobs = new Blobs({ store: this.store.store, key: coreKey, encryptionKey })
    try {
      await blobs.ready()
      return await blobs.get(blobId)
    } finally {
      await blobs.close()
    }
  }

  // base-era cores use the OWNING handle's key, rooms have their own
  /** @private */
  _blobCoreKey(stamp) {
    if (!stamp) return this.store.encryptionKey
    const entropy = this.store.keyring.entropy(stamp)
    return entropy ? blobEpochKey(entropy) : null
  }

  /**
   * Create a new child handle of `type`. Owner-flow — generates a fresh writer, adds it as a
   * writer + member, and registers the child on the parent's `handles` collection.
   *
   * @param {string} type
   * @param {CreateChildOpts} [opts]
   * @returns {Promise<Handle>}
   * @private
   */
  async _create(type, { name = null } = {}) {
    const writer = Identity.randomKeyPair()
    const child = /** @type {Child} */ (
      this._room({
        spec: pickHandle(this.spec, type),
        namespace: `${NS}/handle/${type}/${writer.id}`,
        keyPair: writer,
        // inheriting identity.encryptionKey would let any member decrypt every room
        encryptionKey: Identity.randomBytes(32)
      })
    )
    // a failure after the child opens leaks its Database, swarm session and bee
    let publish = null
    let abort = null
    let inflightId = null
    try {
      await child.ready()
      child.name = name

      const id = hid.encode(child.store.key)
      // add-handle makes the row visible before create finishes; a second Handle on the same core deadlocks
      const inflight = new Promise((resolve, reject) => {
        publish = resolve
        abort = reject
      })
      inflight.catch(safetyCatch)
      inflightId = id
      this._loading?.set(id, inflight)
      await this._saveKeyPair(id, writer)

      const ts = Date.now()
      const writerKey = child.store.writerKey
      // one batch, so a room's first two ops land together
      await child.store.tx(async (tx) => {
        await tx.call('add-writer', {
          master: this.identity.publicKey,
          writer: writerKey,
          sig: this.identity.sign(admission(child.store.key, writerKey, child.store.writerKey)),
          ts
        })
        await tx.call('add-member', {
          id: this.identity.id,
          key: writerKey,
          role: 'owner',
          name: null,
          createdAt: ts,
          updatedAt: ts
        })
      })
      await this.store.call('add-handle', {
        id,
        type,
        key: child.store.key,
        encryptionKey: child.store.encryptionKey,
        name,
        createdAt: ts,
        updatedAt: ts
      })

      this._adopt(child, { name })
      publish(child)
      this._loading?.delete(id)
      return child
    } catch (err) {
      if (abort) abort(err)
      if (inflightId) this._loading?.delete(inflightId)
      await child.close().catch(safetyCatch)
      throw err
    }
  }

  /**
   * Join a child handle by invite. The caller waits up to `timeout`; the join itself goes on
   * until it is admitted, denied or expired, across restarts, and the handle then arrives
   * with the `handle` event.
   *
   * @param {string} invite
   * @param {string} type
   * @param {JoinChildOpts} [opts]
   * @returns {Promise<Handle>}
   * @private
   */
  async _join(invite, type, { timeout = TIMEOUT } = {}) {
    const known = await this._joined(type, Invite.parse(invite).discoveryKey)
    if (known) return known

    const join = this._start(invite, type)
    join.waiting++
    try {
      return await wait(join.done, timeout)
    } finally {
      join.waiting--
    }
  }

  /** @private */
  _start(invite, type) {
    const target = Invite.parse(invite).discoveryKey
    const key = `${type}/${b4a.toHex(target)}`
    let join = this._joining.get(key)
    if (!join) {
      join = new Join(this, {
        type,
        spec: pickHandle(this.spec, type),
        discoveryKey: target,
        onend: () => this._joining.delete(key)
      })
      this._joining.set(key, join)
    }
    if (join.invite !== invite) join.start(invite)
    return join
  }

  /** @private */
  async _cancel(invite) {
    const id = b4a.toHex(Invite.parse(invite).discoveryKey)
    const join = [...this.root._joining.values()].find((join) => join.id === id)
    await join?.cancel()
    return !!join
  }

  // a stored writer still admitted reopens without pairing; a removed writer's core is frozen,
  // so that one pairs again with a fresh keypair
  /** @private */
  async _joined(type, target) {
    const { data: joined } = await this.store.get('handles')
    const existing = joined.find((h) => h.type === type && b4a.equals(discoveryKey(h.key), target))
    if (!existing) return null
    const known = await this._load(type, existing.id)
    const { data: me } = await known.store.get('members', this.identity.id)
    const { data: device } = await known.store.get('devices', hid.encode(known.store.writerKey))
    // a reader never had a seat, a removed writer lost it
    if (me && (device || me.role === 'reader')) return known
    await known.close().catch(safetyCatch)
    return null
  }

  /**
   * Open a joined handle with the keys its reply delivered, once this writer is admitted.
   *
   * @param {string} type
   * @param {import('@cero-base/core/pairing').JoinResult} reply
   * @returns {Promise<Handle>}
   * @private
   */
  async _enter(type, reply) {
    const child = /** @type {Child} */ (
      this._room({
        spec: pickHandle(this.spec, type),
        namespace: `${NS}/handle/${type}/${randomNs()}`,
        ...delivered(reply)
      })
    )
    let publish = null
    let abort = null
    let inflightId = null
    try {
      await child.ready()
      // admitted once our member row lands; the same apply seats a writer, a reader has no seat
      const member = await admitted(child.store, this.identity.id)
      if (member.role !== 'reader' && !child.store.writable) {
        await child.store.whenWritable({ timeout: 0 })
      }

      const id = hid.encode(child.store.key)
      // same create/open race as _create, a concurrent _load must share this child
      const inflight = new Promise((resolve, reject) => {
        publish = resolve
        abort = reject
      })
      inflight.catch(safetyCatch)
      inflightId = id
      this._loading?.set(id, inflight)
      await this._saveKeyPair(id, child.store.keyPair)

      const ts = Date.now()
      await this.store.call('add-handle', {
        id,
        type,
        key: child.store.key,
        encryptionKey: child.store.encryptionKey,
        name: null,
        createdAt: ts,
        updatedAt: ts
      })
      this._adopt(child, {})
      publish(child)
      this._loading?.delete(id)
      return child
    } catch (err) {
      if (abort) abort(err)
      if (inflightId) this._loading?.delete(inflightId)
      await child.close().catch(safetyCatch)
      throw err
    }
  }

  // joins not answered at the last close go on, with nobody waiting; the mailbox sends what its
  // outbox kept
  /** @private */
  async _carryOn() {
    if (!this.local) return
    for (const { id, invite, type } of (await this.local.store.get('joins')).data) {
      if (await this._joined(type, Invite.parse(invite).discoveryKey)) {
        await this.local.store.del('joins', id)
        continue
      }
      this._start(invite, type)
    }
  }

  /**
   * Get an open child by id, or re-open it. Concurrent calls for the same id share one
   * in-flight load, so the child is built — and `handle` emitted — exactly once.
   *
   * @param {string} type
   * @param {string} id
   * @returns {Promise<Handle>}
   * @private
   */
  async _load(type, id) {
    for (const c of this.children) if (c.id === id) return c
    const existing = this._loading.get(id)
    if (existing) return existing
    const loading = this._reopen(type, id)
    this._loading.set(id, loading)
    try {
      return await loading
    } finally {
      this._loading.delete(id)
    }
  }

  /**
   * Reconstruct a child handle by id. Reuses the stored writer keypair if
   * available; otherwise generates a fresh one and claims writer capability.
   *
   * @param {string} type
   * @param {string} id
   * @returns {Promise<Handle>}
   * @private
   */
  async _reopen(type, id) {
    const { data } = await this.store.get('handles', id)
    if (!data) throw CeroError.UNKNOWN('handle', id)
    if (data.type !== type) {
      throw CeroError.INVALID(`handle ${id} is type ${data.type}, not ${type}`)
    }
    let writer = await this._loadKeyPair(id)
    const firstTime = !writer
    if (firstTime) {
      writer = Identity.randomKeyPair()
    }
    const child = this._room({
      spec: pickHandle(this.spec, type),
      namespace: `${NS}/handle/${type}/${id}`,
      key: data.key,
      encryptionKey: data.encryptionKey,
      keyPair: /** @type {KeyPair} */ (writer)
    })
    try {
      await child.ready()
      if (firstTime && !child.store.writable) {
        await child.store.claim()
      }
      if (firstTime) {
        await this._saveKeyPair(id, writer)
      }
    } catch (err) {
      await child.close().catch(safetyCatch)
      throw err
    }
    this._adopt(child, {})
    return child
  }

  // a room has its type's hooks before it opens, so no op it applies runs without them
  /** @private */
  _room(opts) {
    const child = new Handle({ parent: this, ...opts })
    for (const hook of this._typeHooks) hook.apply(child)
    return child
  }

  /** @private */
  async _sleep() {
    if (this.closing || this.closed) return
    await this._bluetooth?.suspend().catch(this._onerror)
    await this.network.suspend().catch(this._onerror)
    await this.store.store.suspend().catch(this._onerror)
  }

  /** @private */
  async _wake() {
    if (this.closing || this.closed) return
    await this.store.store.resume().catch(this._onerror)
    await this.network.resume().catch(this._onerror)
    await this._bluetooth?.resume().catch(this._onerror)
  }

  /** @private */
  _adopt(child, info) {
    this.children.add(child)
    this._serve(child)
    this.emit('handle', child, info)
  }

  // before(me.room.notes, fn): on every room open now and every one opened later
  /** @private */
  _hookType(ref, attach, opts) {
    const offs = new Map()
    const hook = {
      apply: (child) => {
        if (child.type !== ref.type) return
        offs.set(child, attach(child))
        child.once('close', () => offs.delete(child))
      }
    }
    this._typeHooks.add(hook)
    for (const child of this.children) hook.apply(child)
    const off = () => {
      this._typeHooks.delete(hook)
      for (const o of offs.values()) o()
      offs.clear()
    }
    onAbort(opts?.signal, off)
    return off
  }

  // a room with invites is reopened at boot, so its joins are answered whenever we are online,
  // not only while the app has the room open
  /** @private */
  _serve(child) {
    if (!this.local || !child._pair) return
    const save = async () => {
      const { serving } = child._pair
      if (serving === child._serving) return
      child._serving = serving
      if (!serving) return this.local.store.del('serving', child.id)
      await this.local.store.put('serving', { id: child.id, type: child.type })
    }
    child._pair.on('serving', () => save().catch(this._onerror))
    save().catch(this._onerror)
  }

  /** @private */
  async _reserve() {
    if (!this.local) return
    for (const { id, type } of (await this.local.store.get('serving')).data) {
      this._load(type, id).catch((err) => {
        if (err.code === 'UNKNOWN') return this.local.store.del('serving', id).catch(safetyCatch)
        this._onerror(err)
      })
    }
  }

  /**
   * @param {string} id
   * @param {KeyPair | { publicKey: Uint8Array, secretKey: Uint8Array } | null} keyPair
   * @returns {Promise<void>}
   * @private
   */
  async _saveKeyPair(id, keyPair) {
    if (!this.local || !keyPair) return
    await this.local.store.put('handle-keypairs', {
      id,
      publicKey: keyPair.publicKey,
      secretKey: keyPair.secretKey
    })
  }

  /**
   * @param {string} id
   * @returns {Promise<{ publicKey: Uint8Array, secretKey: Uint8Array } | null>}
   * @private
   */
  async _loadKeyPair(id) {
    if (!this.local) return null
    const { data } = await this.local.store.get('handle-keypairs', id)
    if (!data) return null
    return {
      publicKey: data.publicKey,
      secretKey: data.secretKey
    }
  }

  /**
   * Pair into an existing handle via an invite, returning a brand-new `Handle` opened with the
   * delivered keys. A one-shot join: the root's `_join` is the one that survives restarts.
   *
   * @param {string} invite
   * @param {StaticJoinOpts} [opts]
   * @returns {Promise<Handle>}
   */
  static async join(
    invite,
    { parent, network, identity, store, spec, namespace, writer, timeout = TIMEOUT } = {}
  ) {
    const net = network || parent?.network
    const id = identity || parent?.identity
    if (!net) throw CeroError.REQUIRED('network')
    if (!id) throw CeroError.REQUIRED('identity')
    if (!store && !parent) throw CeroError.REQUIRED('store')
    if (!spec) throw CeroError.REQUIRED('spec')

    // standalone, a mailbox of its own for this one join
    const mailbox = parent ? null : new Mailbox(net)
    try {
      const reply = await Pairing.join(mailbox || parent.mailbox, invite, {
        identity: id,
        spec,
        writer,
        timeout
      })
      const opts = { parent, store, identity: id, network: net, spec, namespace }
      return Handle.fromReply(reply, opts)
    } finally {
      await mailbox?.close()
    }
  }

  /**
   * A handle opened with the keys a pairing reply delivered.
   *
   * @param {import('@cero-base/core/pairing').JoinResult} reply
   * @param {Omit<HandleOpts, 'key' | 'encryptionKey' | 'epochs' | 'keyPair'>} opts
   * @returns {Handle}
   */
  static fromReply(reply, opts) {
    return new Handle({ ...opts, ...delivered(reply) })
  }
}

// the keys a pairing reply delivered, as a handle opens with them
function delivered({ key, encryptionKey, epochs, writer }) {
  return { key, encryptionKey, epochs, keyPair: writer }
}

function admitted(db, id) {
  return new Promise((resolve, reject) => {
    const check = async () => {
      const { data } = await db.get('members', id)
      if (!data) return
      db.off('update', onupdate)
      resolve(data)
    }
    const onupdate = () => check().catch(reject)
    db.on('update', onupdate)
    onupdate()
  })
}

// a device without a local store keeps its mail in memory
function boxes(local) {
  if (!local) return {}
  return { inbox: box(local.store, 'inbox'), outbox: box(local.store, 'outbox') }
}

function pickHandle(spec, type) {
  const h = spec.handles?.[type]
  if (!h) throw CeroError.UNKNOWN('handle type', type)
  return h
}

function randomNs() {
  return z32.encode(Identity.randomBytes(8))
}

// run every teardown step, then surface the first failure: a bug must not leak the storage lock
async function settle(steps) {
  let failed = null
  for (const step of steps) {
    try {
      await step()
    } catch (err) {
      failed ??= err
    }
  }
  if (failed) throw failed
}
