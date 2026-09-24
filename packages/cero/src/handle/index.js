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
import { admission, onAbort } from '@cero-base/core/utils'
import { CeroError } from '@cero-base/core/errors'
import { Blobs } from '@cero-base/core/blobs'
import { decodeId } from '@cero-base/core/blobs/codec'
import { FileServer } from '@cero-base/core/blobs/server'

import { NS, TIMEOUT } from '../lib/constants.js'

import { Ref } from '../lib/refs.js'
import { Join, wait } from './join.js'
import { box } from '../local/index.js'
import { extensionsOf, operatorsOf, bind } from '../extensions/index.js'
import { before, after } from '../lib/operators.js'

export { Ref } from '../lib/refs.js'

/**
 * @typedef {import('@cero-base/core/network').Network} Network
 * @typedef {import('../local/index.js').Local} Local
 * @typedef {import('@cero-base/core/identity').KeyPair} KeyPair
 *
 * @typedef {object} HandleOpts
 * @property {Handle} [parent]                 Parent handle when this is a child slot.
 * @property {Identity} [identity]             Long-lived user identity. Inherited from `parent` if omitted.
 * @property {Network} [network]               Shared swarm. Inherited from `parent` if omitted.
 * @property {any} [store]                     Pre-existing Corestore. Falls back to `parent.store.store`.
 * @property {any} [spec]                      Built cero spec.
 * @property {Local} [local]                   Local store for per-handle keypairs.
 * @property {any} [storage]                   Owned HypercoreStorage to close on shutdown.
 * @property {any} [discovery]                 Owned identity Discovery to destroy on shutdown.
 * @property {string} [dir]                    Data directory (root handles only).
 * @property {any} [opts]                      Pass-through cero(...) options.
 * @property {Record<string, Function>} [routes]
 * @property {Uint8Array} [key]                Existing database key.
 * @property {Uint8Array} [encryptionKey]      Existing encryption key.
 * @property {Array<{ epoch: number, entropy: Uint8Array }>} [epochs]  Rotation epochs delivered at join.
 * @property {string} [namespace]              Corestore namespace.
 * @property {KeyPair} [keyPair]               Writer keypair.
 * @property {boolean} [pair]                  When `false`, skips creating a `Pairing` session.
 *
 * @typedef {object} CreateChildOpts
 * @property {string | null} [name]
 * @property {Record<string, Function>} [routes]
 *
 * @typedef {object} JoinChildOpts
 * @property {Record<string, Function>} [routes]
 * @property {number} [timeout]
 *
 * @typedef {object} StaticJoinOpts
 * @property {Handle} [parent]
 * @property {Network} [network]
 * @property {Identity} [identity]
 * @property {any} [store]
 * @property {any} [spec]
 * @property {string} [namespace]
 * @property {Record<string, Function>} [routes]
 * @property {KeyPair} [writer]                  Writer keypair in the joined handle; a fresh one by default.
 * @property {number} [timeout]
 *
 * @typedef {object} AcceptOpts
 * @property {string} [role]   Role to grant the joining peer. Falls back to the invite's role, then `'member'`.
 *
 * @typedef {object} HandleExtra
 * @property {string | null} [name]                       Display name; set on child handles by the owner flow.
 * @property {import('../lib/refs.js').Ref} [profile]    `profile` ref, attached dynamically when the schema declares one.
 * @property {import('../lib/refs.js').Ref} [members]    `members` ref, attached dynamically when the schema declares one.
 *
 * @typedef {Handle & HandleExtra} Child  A child handle plus its dynamically-attached refs.
 *
 * @typedef {Handle & Record<string, import('../lib/refs.js').Ref>} CeroHandle  A handle with every schema ref reachable as a `Ref` property (e.g. `me.profile`, `room.messages`).
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

    this.identity = identity
    this.network = network
    this.spec = spec
    this.parent = parent

    this.local = opts.local || null
    // one per device: the root's, its boxes in the local store
    this.mailbox = parent ? parent.root.mailbox : new Mailbox(network, boxes(this.local))
    this._storage = opts.storage || null
    this._discovery = opts.discovery || null
    this._dir = opts.dir || null
    this._opts = opts.opts || {}
    this.extensions = parent?.extensions || extensionsOf(spec, this._opts.extensions)
    this.operators = parent?.operators || operatorsOf(spec, this._opts.operators)
    this._onerror = this._opts.onerror || ((err) => console.error(err))
    this.children = parent ? null : new Set()
    this._typeHooks = parent ? null : new Set()
    this._loading = parent ? null : new Map()
    this._joining = parent ? null : new Map() // type/discovery key → Join
    this._coreKeys = parent ? null : new Map()
    this._fileServer = null
    this._blobs = null
    this._epochBlobs = null
    // root only, serializes suspend/resume and converges rapid bounces
    this._sus = parent
      ? null
      : new Suspendify({ suspend: () => this._suspend(), resume: () => this._resume() })
    this._owned = new Set()

    this.store = new Database({
      store: store,
      identity,
      network,
      spec,
      routes: opts.routes,
      key: opts.key,
      encryptionKey: opts.encryptionKey,
      epochs: opts.epochs,
      namespace: opts.namespace,
      keyPair: opts.keyPair,
      pinned: !parent,
      onerror: this._onerror
    })
    this.pair = null
    this._wantsPair = opts.pair !== false
  }

  /**
   * An `AbortSignal` that fires when this handle closes.
   *
   * @returns {AbortSignal}
   */
  get signal() {
    if (!this._ac) {
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

  /** Canonical id — identity id for the root handle, store key for children. */
  get id() {
    if (!this.parent) return this.identity.id
    return this.store?.key ? hid.encode(this.store.key) : null
  }

  /** This device's id + name. `null` on child handles. */
  get device() {
    if (this.parent) return null
    const k = this.store?.writerKey
    return k ? { id: hid.encode(k), name: this._opts.name || null } : null
  }

  get suspended() {
    return this._sus?.suspended === true
  }

  async _open() {
    await this.store.ready()
    if (this._wantsPair) {
      this.pair = new Pairing({ mailbox: this.mailbox, db: this.store })
      await this.pair.ready()
    }
    Ref.attach(this, this.store.refs, this.spec.handles)
    this.root._coreKeys.set(b4a.toHex(this.store.key), this.store.encryptionKey)
    if (!this.parent) {
      await this.fileServer.listen()
      await this.mailbox.ready()
      await this._carryOn().catch(this._onerror)
      this._reserve().catch(this._onerror)
    }
  }

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
      () => this.pair?.close()
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
        () => this.bluetooth?.close(),
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

  /**
   * `EventEmitter.on` plus an optional `{ signal }` that removes the listener
   * when the signal aborts — e.g. `me.on('handle', fn, { signal: me.signal })`.
   *
   * @param {string} event
   * @param {(...args: any[]) => void} fn
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {this}
   */
  on(event, fn, opts) {
    super.on(event, fn)
    onAbort(opts?.signal, () => super.off(event, fn))
    return this
  }

  /**
   * Resolve a durable file id to an ephemeral download url via this identity's
   * file server.
   *
   * @param {string} id
   * @returns {string}
   */
  getLink(id) {
    return this.root.fileServer.getLink(id)
  }

  /**
   * Initialise a fresh database: write the genesis claim, derive the writer.
   * Forwards to `Database.bootstrap`.
   *
   * @param {any} [opts]
   * @returns {Promise<any>}
   */
  bootstrap(opts) {
    return this.store.bootstrap(opts)
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

  /**
   * `true` ranks this handle as just touched, `false` takes it out of the swarm until the
   * next update lands in it.
   *
   * @param {boolean} active
   */
  setActive(active) {
    this.store.setActive(active)
  }

  /**
   * Mint an invite into this handle.
   *
   * @param {import('@cero-base/core/pairing').InviteOpts} [opts]
   * @returns {Promise<string>}  Z32-encoded invite string.
   */
  async invite(opts) {
    if (!this.pair) {
      throw CeroError.INVALID(
        'invite() is not available on the root handle — open a child handle first'
      )
    }
    return this.pair.invite(opts)
  }

  /**
   * Revoke an invite, on every member.
   *
   * @param {string} invite
   * @returns {Promise<boolean>}  `true` if it was served.
   */
  async revoke(invite) {
    if (!this.pair) throw CeroError.INVALID('revoke() is not available on the root handle')
    return this.pair.revoke(invite)
  }

  /**
   * Accept a join request: admits the joiner, then sends it this handle's keys.
   *
   * @param {import('@cero-base/core/pairing').Request} request
   * @param {AcceptOpts} [opts]
   * @returns {Promise<void>}
   */
  async accept(request, opts) {
    return request.accept(opts)
  }

  /**
   * Leave a child handle — removes it from the parent's `handles` collection
   * and closes the session. No-op on root handles.
   *
   * @returns {Promise<void>}
   */
  async leave() {
    if (!this.parent) return
    await this.parent.store.call('del-handle', { id: hid.encode(this.store.key) })
    await this.close()
  }

  /**
   * Pause networking + storage. Idempotent; no-op on child handles.
   *
   * @returns {Promise<void>}
   */
  async suspend() {
    if (this._sus) await this._sus.suspend()
  }

  /**
   * Resume a suspended root handle. Idempotent; no-op on child handles.
   *
   * @returns {Promise<void>}
   */
  async resume() {
    if (this._sus) await this._sus.resume()
  }

  /**
   * @param {Uint8Array} coreKey
   * @param {object} info
   * @returns {{ key: Uint8Array, encryptionKey: Uint8Array } | null}
   */
  _resolveCore(coreKey, info) {
    const hex = b4a.toHex(coreKey)
    const encryptionKey = this.root._coreKeys.get(hex)
    if (encryptionKey !== undefined) return { key: coreKey, encryptionKey }
    return null
  }

  _baseBlobs() {
    if (!this._blobs) this._blobs = this._makeBlobs('blobs', this.store.encryptionKey, 0)
    return this._blobs
  }

  _makeBlobs(name, encryptionKey, stamp) {
    const blobs = new Blobs({
      store: this.store.store,
      network: this.network,
      encryptionKey,
      name
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

  // base-era cores use the OWNING handle's key, rooms have their own
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
   */
  async _create(type, { name = null, routes } = {}) {
    const writer = Identity.randomKeyPair()
    const child = /** @type {Child} */ (
      new Handle({
        parent: this,
        spec: pickHandle(this.spec, type),
        namespace: `${NS}/handle/${type}/${writer.id}`,
        routes,
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
   */
  async _join(invite, type, { routes, timeout = TIMEOUT } = {}) {
    const known = await this._joined(type, Invite.parse(invite).discoveryKey)
    if (known) return known

    const join = this._start(invite, type, routes)
    join.waiting++
    try {
      return await wait(join.done, timeout)
    } finally {
      join.waiting--
    }
  }

  _start(invite, type, routes) {
    const target = Invite.parse(invite).discoveryKey
    const key = `${type}/${b4a.toHex(target)}`
    let join = this._joining.get(key)
    if (!join) {
      join = new Join(this, {
        type,
        spec: pickHandle(this.spec, type),
        discoveryKey: target,
        routes,
        onend: () => this._joining.delete(key)
      })
      this._joining.set(key, join)
    }
    if (join.invite !== invite) join.start(invite)
    return join
  }

  /**
   * The joins no member answered yet. Each is resumed on every boot until it is admitted,
   * denied, expired or cancelled.
   *
   * @returns {Promise<string[]>}  Their invites.
   */
  async joining() {
    const { local } = this.root
    if (!local) return []
    const { data } = await local.store.get('joins')
    return data.map((join) => join.invite)
  }

  /**
   * Stop joining the handle an invite opens, for good: it is not resumed on the next boot.
   *
   * @param {string} invite
   * @returns {Promise<boolean>}  Whether a join was pending.
   */
  async cancel(invite) {
    const id = b4a.toHex(Invite.parse(invite).discoveryKey)
    const join = [...this.root._joining.values()].find((join) => join.id === id)
    await join?.cancel()
    return !!join
  }

  // a stored writer still admitted reopens without pairing; a removed writer's core is frozen,
  // so that one pairs again with a fresh keypair
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
   * @param {Record<string, Function>} [routes]
   * @returns {Promise<Handle>}
   */
  async _enter(type, reply, routes) {
    const child = /** @type {Child} */ (
      Handle.fromReply(reply, {
        parent: this,
        spec: pickHandle(this.spec, type),
        namespace: `${NS}/handle/${type}/${randomNs()}`,
        routes
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
    const child = new Handle({
      parent: this,
      spec: pickHandle(this.spec, type),
      namespace: `${NS}/handle/${type}/${id}`,
      key: data.key,
      encryptionKey: data.encryptionKey,
      keyPair: /** @type {KeyPair} */ (writer)
    })
    await child.ready()
    if (firstTime && !child.store.writable) {
      await child.store.claim()
    }
    if (firstTime) {
      await this._saveKeyPair(id, writer)
    }
    this._adopt(child, {})
    return child
  }

  async _suspend() {
    if (this.closing || this.closed) return
    await this.bluetooth?.suspend().catch(this._onerror)
    await this.network.suspend().catch(this._onerror)
    await this.store.store.suspend().catch(this._onerror)
  }

  async _resume() {
    if (this.closing || this.closed) return
    await this.store.store.resume().catch(this._onerror)
    await this.network.resume().catch(this._onerror)
    await this.bluetooth?.resume().catch(this._onerror)
  }

  // a child is a child once it has its operators, the hooks declared for its type, and a slot
  _adopt(child, info) {
    bind(child, child.type, this.operators)
    for (const hook of this._typeHooks) hook.apply(child)
    this.children.add(child)
    this._serve(child)
    this.emit('handle', child, info)
  }

  // before(me.room.notes, fn): on every room open now and every one opened later
  _hookType(op, ref, fn, opts) {
    const offs = new Map()
    const hook = {
      apply: (child) => {
        if (child.type !== ref.type) return
        offs.set(child, op(child[ref.name], fn))
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
  _serve(child) {
    if (!this.local || !child.pair) return
    const save = async () => {
      const { serving } = child.pair
      if (serving === child._serving) return
      child._serving = serving
      if (!serving) return this.local.store.del('serving', child.id)
      await this.local.store.put('serving', { id: child.id, type: child.type })
    }
    child.pair.on('serving', () => save().catch(this._onerror))
    save().catch(this._onerror)
  }

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
    { parent, network, identity, store, spec, namespace, routes, writer, timeout = TIMEOUT } = {}
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
      const opts = { parent, store, identity: id, network: net, spec, namespace, routes }
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
  static fromReply({ key, encryptionKey, epochs, writer }, opts) {
    return new Handle({ ...opts, key, encryptionKey, epochs, keyPair: writer })
  }
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
