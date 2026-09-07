import AbortController from 'bare-abort-controller'
import b4a from 'b4a'
import c from 'compact-encoding'
import Hypercore from 'hypercore'
import { discoveryKey } from 'hypercore-crypto'
import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import Suspendify from 'suspendify'
import z32 from 'z32'

import { Identity } from '@cero-base/core/identity'
import { Database } from '@cero-base/core/database'
import { epochEntries, blobEpochKey } from '@cero-base/core/database/encryption'
import { Pairing } from '@cero-base/core/pairing'
import hid from 'hypercore-id-encoding'
import { grants, can, isRank, admission, REMOVE, onAbort } from '@cero-base/core/utils'
import { CeroError } from '@cero-base/core/errors'
import { Blobs } from '@cero-base/core/blobs'
import { decodeId } from '@cero-base/core/blobs/codec'
import { FileServer } from '@cero-base/core/blobs/server'

import { NS, TIMEOUT } from '../lib/constants.js'

import { Ref } from '../lib/refs.js'
import { bind } from '../lib/operators.js'

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
 * @property {string} [role]
 * @property {boolean} [accept]
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
 * @property {number} [timeout]
 *
 * @typedef {object} AcceptOpts
 * @property {string} [role]   Role to grant the joining peer. Falls back to the invite's role, then `'member'`.
 * @property {string | null} [name]
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
    this._storage = opts.storage || null
    this._discovery = opts.discovery || null
    this._dir = opts.dir || null
    this._opts = opts.opts || {}
    this._onerror = this._opts.onerror || safetyCatch
    this.children = parent ? null : new Set()
    this._loading = parent ? null : new Map()
    this._joining = parent ? null : new Map()
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
      this.pair = new Pairing({
        network: this.network,
        identity: this.identity,
        topic: this.store.key,
        onerror: this._onerror,
        onconsume: (id) => {
          this.store.call('del-invite', { id }).catch(safetyCatch)
        }
      })
      await this.pair.ready()
      // serve invites persisted by any member, in step with the rows
      await this._syncInvites().catch(safetyCatch)
      this._invitesSync = (touched) => {
        if (touched.has('*') || touched.has('invites')) this._syncInvites().catch(safetyCatch)
      }
      this.store.on('update', this._invitesSync)
    }
    Ref.attach(this, this.store.refs)
    this.root._coreKeys.set(b4a.toString(this.store.key, 'hex'), this.store.encryptionKey)
    if (!this.parent) await this.fileServer.listen()
  }

  async _close() {
    this.root._coreKeys.delete(b4a.toString(this.store.key, 'hex'))
    if (this._blobs?.key) this.root._coreKeys.delete(b4a.toString(this._blobs.key, 'hex'))
    for (const b of this._epochBlobs?.values() || []) {
      if (b.key) this.root._coreKeys.delete(b4a.toString(b.key, 'hex'))
    }
    for (const hex of this._blobKeys || []) this.root._coreKeys.delete(hex)
    for (const r of [...this._owned]) r.destroy?.()
    this._owned.clear()
    if (this._blobs) await this._blobs.close()
    for (const b of this._epochBlobs?.values() || []) await b.close().catch(safetyCatch)
    this._epochBlobs = null
    if (this.children) {
      for (const c of [...this.children]) await c.close()
      this.children.clear()
    }
    if (this._invitesSync) {
      this.store.off('update', this._invitesSync)
      this._invitesSync = null
    }
    if (this.pair) await this.pair.close()

    if (this.parent) {
      this.parent.children?.delete(this)
      await this.store.close()
      return
    }

    if (this.local) await this.local.close()
    if (this._fileServer) {
      await this._fileServer.close()
      this._fileServer = null
    }
    const store = this.store.store
    await this.store.close()
    if (this._discovery) this._discovery.destroy().catch(safetyCatch)
    await this.network.close()
    await store.close()
    if (this._storage) await this._storage.close()
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
   * Mint a pairing invite for this handle.
   *
   * @param {{ role?: string, expiresIn?: number, data?: any }} [opts]
   * @returns {Promise<string>}  Z32-encoded invite string.
   */
  async invite(opts) {
    if (!this.pair) {
      throw CeroError.INVALID(
        'invite() is not available on the root handle — open a child handle first'
      )
    }
    // an invite is a capability, cap the rank or apply drops the mismatch silently
    if (opts?.role !== undefined && opts.role !== '') await this._checkGrant(opts.role)
    const str = await this.pair.createInvite(opts)
    const record = this.pair.recordOf(str)
    if (record) {
      // persist so every member replica serves it across restarts
      await this.store
        .call('add-invite', {
          id: b4a.toString(record.id, 'hex'),
          invite: b4a.from(str),
          publicKey: record.publicKey,
          seed: record.seed,
          role: record.invite.role || '',
          expires: record.invite.expires || 0,
          createdAt: Date.now(),
          reuse: !!record.reuse
        })
        .catch(safetyCatch)
    }
    return str
  }

  /**
   * Revoke a previously-minted invite by its string form.
   *
   * @param {string} invite
   * @returns {Promise<boolean>}  `true` if the invite was found and removed.
   */
  async revoke(invite) {
    if (!this.pair) throw CeroError.INVALID('revoke() is not available on the root handle')
    // apply refuses revoke below REMOVE, and other members would keep serving it
    const { data: me } = await this.store.get('members', this.identity.id)
    if (me && !can(me.role, REMOVE)) {
      throw CeroError.DENIED(null, 'revoking an invite needs the remove permission')
    }
    const record = this.pair.recordOf(invite)
    const revoked = this.pair.revoke(invite)
    if (revoked && record) {
      // drop the persisted row so every other member stops serving it too
      await this.store.call('del-invite', { id: b4a.toString(record.id, 'hex') })
    }
    return revoked
  }

  /**
   * Accept a paired candidate — adds them as a writer (or read-only member)
   * and confirms the pairing so they receive this handle's keys.
   *
   * @param {any} candidate
   * @param {AcceptOpts} [opts]
   * @returns {Promise<void>}
   */
  async accept(candidate, { role, name } = {}) {
    const data = candidate.userData
    if (!b4a.isBuffer(data) || data.length !== 64) {
      throw CeroError.INVALID(
        'candidate userData must be a 64-byte buffer (identity + writer pubkey)'
      )
    }
    if (candidate.invite.expired) throw CeroError.EXPIRED()
    role = role || candidate.invite.role || 'member'
    if (candidate.invite.role && !grants(candidate.invite.role, role)) {
      throw CeroError.INVALID(`role '${role}' exceeds the invite role '${candidate.invite.role}'`)
    }
    // synchronous on purpose, the cap against our own rank is enforced at apply
    if (!isRank(role)) {
      throw CeroError.INVALID(`role '${role}' is not a rank (owner, admin, member, reader)`)
    }

    // confirm must answer within the request's lifetime, so the key goes out before the membership
    // writes land; epoch secrets ride along so a post-rotation joiner reads full history
    const epochs = this.store.keyring.all()
    await candidate.confirm({
      key: this.store.key,
      encryptionKey: this.store.encryptionKey,
      additional: epochs.length ? c.encode(epochEntries, epochs) : null
    })

    const ts = Date.now()
    const writerKey = Hypercore.key({ version: 2, signers: [{ publicKey: data.subarray(32, 64) }] })
    const member = {
      id: hid.encode(data.subarray(0, 32)),
      key: writerKey,
      role,
      name: name || null,
      createdAt: ts,
      updatedAt: ts
    }

    if (role === 'reader') {
      await this.store.call('add-member', member)
      return
    }

    const sig = this.identity.sign(admission(this.store.key, writerKey, this.store.writerKey))
    // one batch: the member row, then the writer that belongs to it; a refusal discards both
    await this.store.tx(async (tx) => {
      await tx.call('add-member', member)
      await tx.call('add-writer', {
        sig,
        master: this.identity.publicKey,
        writer: writerKey,
        memberId: member.id,
        ts: member.updatedAt || Date.now()
      })
    })
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
    const hex = b4a.toString(coreKey, 'hex')
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
        this.root._coreKeys.set(b4a.toString(blobs.key, 'hex'), encryptionKey)
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
      const hex = b4a.toString(coreKey, 'hex')
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

  async _syncInvites() {
    if (!this.pair) return
    const { data } = await this.store.get('invites')
    this.pair.syncRows(data || [])
  }

  // `grants` treats an unknown role as "no", so an app role name must fail loudly
  async _checkGrant(role) {
    if (!isRank(role)) {
      throw CeroError.INVALID(`role '${role}' is not a rank (owner, admin, member, reader)`)
    }
    const { data: me } = await this.store.get('members', this.identity.id)
    // no member row yet = genesis, nothing to cap
    if (!me) return
    if (!grants(me.role, role)) {
      throw CeroError.DENIED(null, `role '${role}' exceeds your own role '${me.role}'`)
    }
  }

  /**
   * Create a new child handle of `type`. Owner-flow — generates a fresh writer, adds it as a
   * writer + member, and registers the child on the parent's `handles` collection.
   *
   * @param {string} type
   * @param {CreateChildOpts} [opts]
   * @returns {Promise<Handle>}
   */
  async _create(type, { name = null, routes, role, accept } = {}) {
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
      // same shape as accept(), so a room's first two ops land together
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

      if (accept !== false) this._wireAccept(child, { role })
      bind(child, type)
      this.children.add(child)
      this.emit('handle', child, { name, role })
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
   * Join a child handle by invite (joiner-flow).
   *
   * @param {string} invite
   * @param {string} type
   * @param {JoinChildOpts} [opts]
   * @returns {Promise<Handle>}
   */
  async _join(invite, type, opts = {}) {
    // the pairing layer allows one candidate per invite, attach to the in-flight join
    const target = Pairing.inviteTopic(invite)
    const key = target && `${type}/${b4a.toString(target, 'hex')}`
    if (!key) return this._pair(invite, type, opts, target)
    const pending = this._joining.get(key)
    if (pending) return pending
    const joining = this._pair(invite, type, opts, target)
    this._joining.set(key, joining)
    try {
      return await joining
    } finally {
      this._joining.delete(key)
    }
  }

  /**
   * @param {string} invite
   * @param {string} type
   * @param {JoinChildOpts} [opts]
   * @param {Uint8Array | null} [target]
   * @returns {Promise<Handle>}
   */
  async _pair(invite, type, { routes, timeout } = {}, target = null) {
    const deadline = timeout || TIMEOUT

    // a stored writer still admitted reopens without waiting; a removed writer's core is
    // frozen, so fall through to a real pairing and a fresh keypair
    if (target) {
      const { data: joined } = await this.store.get('handles')
      const existing = joined.find(
        (h) => h.type === type && b4a.equals(discoveryKey(h.key), target)
      )
      if (existing) {
        const known = await this._load(type, existing.id)
        const { data: me } = await known.store.get('members', this.identity.id)
        const { data: device } = await known.store.get('devices', hid.encode(known.store.writerKey))
        if (me && device) return known
        await known.close().catch(safetyCatch)
      }
    }

    // offline join: rendezvous on the invite-derived BLE UUID for the join
    const stopNearby = this.root.bluetooth ? this.root.bluetooth.announce(invite) : null

    const child = /** @type {Child} */ (
      await Handle.join(invite, {
        parent: this,
        spec: pickHandle(this.spec, type),
        namespace: `${NS}/handle/${type}/${randomNs()}`,
        routes,
        timeout
      }).finally(() => stopNearby?.())
    )
    // whenWritable timing out (host offline) is normal, don't leak the opened child
    let publish = null
    let abort = null
    let inflightId = null
    try {
      await child.ready()
      if (!child.store.writable) await child.store.whenWritable({ timeout: deadline })

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
      this._wireAccept(child)
      bind(child, type)
      this.children.add(child)
      this.emit('handle', child, {})
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
   * Get an open child by id, or re-open it. Concurrent calls for the same id share one
   * in-flight load, so the child is built — and `handle` emitted — exactly once.
   *
   * @param {string} type
   * @param {string} id
   * @returns {Promise<Handle>}
   */
  async _load(type, id, opts) {
    for (const c of this.children) if (c.id === id) return c
    const existing = this._loading.get(id)
    if (existing) return existing
    const loading = this._reopen(type, id, opts)
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
  async _reopen(type, id, opts) {
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
    // `accept: false` is a host-approval gate, re-arming it silently is worse
    if (opts?.accept !== false) this._wireAccept(child, { role: opts?.role })
    bind(child, type)
    this.children.add(child)
    this.emit('handle', child, {})
    return child
  }

  async _suspend() {
    if (this.closing || this.closed) return
    await Promise.all([...this.children].map((c) => c.pair?.suspend()))
    await this.bluetooth?.suspend()
    await this.network.suspend()
    try {
      await this.store.store.suspend()
    } catch (err) {
      this._onerror(err)
    }
  }

  async _resume() {
    if (this.closing || this.closed) return
    try {
      await this.store.store.resume()
    } catch (err) {
      this._onerror(err)
    }
    await this.network.resume()
    await this.bluetooth?.resume()
    await Promise.all([...this.children].map((child) => child.pair?.resume()))
  }

  /**
   * @param {Handle} child
   * @param {{ role?: string }} [opts]
   */
  _wireAccept(child, { role } = {}) {
    child.pair.on('candidate', (cand) => {
      if (this.closing || this.closed || child.closing || child.closed) return
      child.accept(cand, { role }).catch(this._onerror)
    })
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
   * Pair into an existing handle via an invite, returning a brand-new
   * `Handle` already configured with the resolved key + encryption key.
   *
   * @param {string} invite
   * @param {StaticJoinOpts} [opts]
   * @returns {Promise<Handle>}
   */
  static async join(
    invite,
    { parent, network, identity, store, spec, namespace, routes, timeout = TIMEOUT } = {}
  ) {
    const net = network || parent?.network
    const id = identity || parent?.identity
    if (!net) throw CeroError.REQUIRED('network')
    if (!id) throw CeroError.REQUIRED('identity')
    if (!store && !parent) throw CeroError.REQUIRED('store')
    if (!spec) throw CeroError.REQUIRED('spec')

    const writer = Identity.randomKeyPair()
    // join-only: a member listener here would collide with concurrent joins on the identity topic
    const pair = new Pairing({ network: net, identity: id, host: false })
    await pair.ready()

    let key, encryptionKey, additional
    try {
      const userData = b4a.concat([id.publicKey, writer.publicKey])
      ;({ key, encryptionKey, additional } = await pair.join(invite, { userData, timeout }))
    } finally {
      await pair.close()
    }

    let epochs = null
    if (additional?.byteLength) {
      // the epoch set is load-bearing, a malformed delivery must fail the join
      try {
        epochs = c.decode(epochEntries, additional)
      } catch {
        throw CeroError.INVALID('malformed epoch delivery in pairing confirm')
      }
    }

    return new Handle({
      parent,
      store,
      identity: id,
      network: net,
      spec,
      namespace,
      routes,
      key,
      encryptionKey,
      epochs,
      keyPair: writer
    })
  }
}

function pickHandle(spec, type) {
  const h = spec.handles?.[type]
  if (!h) throw CeroError.UNKNOWN('handle type', type)
  return h
}

function randomNs() {
  return z32.encode(Identity.randomBytes(8))
}
