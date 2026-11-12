import AbortController from 'bare-abort-controller'
import b4a from 'b4a'
import c from 'compact-encoding'
import { discoveryKey, hash } from 'hypercore-crypto'
import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import Suspendify from 'suspendify'
import z32 from 'z32'

import { Identity } from '@cero-base/core/identity'
import { Database } from '@cero-base/core/database'
import { blobEpochKey, epochEntries } from '@cero-base/core/database/encryption'
import { Pairing } from '@cero-base/core/pairing'
import { read } from '../push/index.js'
import { Invite } from '@cero-base/core/invite'
import { Mailbox } from '@cero-base/core/mailbox'
import { seal, unseal, decodeAddress } from '../lib/mail.js'
import hid from 'hypercore-id-encoding'
import { admission, onAbort, filter, can, WRITE } from '@cero-base/core/utils'
import { CeroError } from '@cero-base/core/errors'
import { Blobs } from '@cero-base/core/blobs'
import { decodeId, servedType } from '@cero-base/core/blobs/codec'
import { FileServer } from '@cero-base/core/blobs/server'

import { KEEP_OPEN, NS, TIMEOUT } from '../lib/constants.js'

import { Ref } from '../lib/refs.js'
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
 * @property {Local} [local]                   Root only, and required there: the device store for handle keypairs and mail.
 * @property {import('hypercore-storage')} [storage]  Owned HypercoreStorage to close on shutdown.
 * @property {{ destroy(): Promise<void> }} [discovery]  Owned identity discovery to destroy on shutdown.
 * @property {string} [dir]                    Data directory (root handles only).
 * @property {import('../index.js').CeroOpts} [opts]  Pass-through cero(...) options.
 * @property {Uint8Array} [key]                Existing database key.
 * @property {Uint8Array} [encryptionKey]      Existing encryption key.
 * @property {Array<{ epoch: number, entropy: Uint8Array }>} [epochs]  Rotation epochs delivered at join.
 * @property {string} [namespace]              Corestore namespace.
 * @property {KeyPair} [keyPair]               Writer keypair.
 * @property {import('../lib/bluetooth.js').Bluetooth | null} [bluetooth]  Root only: the radio, up before the root opens.
 * @property {{ name?: string | null, isMobile?: boolean, recovering?: boolean, timeout?: number } | null} [bootstrap]  Root only: provision this device as it opens, its genesis or its recovery.
 *
 * @typedef {object} CreateChildOpts
 * @property {string | null} [name]
 *
 * @typedef {object} JoinChildOpts
 * @property {number} [timeout]
 *
 * @typedef {object} HandleExtra
 * @property {string | null} [name]                       Display name; set on child handles by the owner flow.
 * @property {import('../lib/refs.js').Ref} [profile]    `profile` ref, attached dynamically when the schema declares one.
 * @property {import('../lib/refs.js').Ref} [members]    `members` ref, attached dynamically when the schema declares one.
 *
 * @typedef {Handle & HandleExtra} Child  A child handle plus its dynamically-attached refs.
 *
 * @typedef {Handle & Record<string, import('../lib/refs.js').Ref>} Context  The root or an opened handle, with its refs (`me.profile`, `room.messages`).
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
    if (!parent && !opts.local) throw CeroError.REQUIRED('local')

    /** @type {Identity} */
    this.identity = identity
    /** @type {Network} */
    this.network = network
    this.spec = spec
    this.parent = parent

    this.local = opts.local || null
    // one per device: the root's, its boxes in the local store
    /** @type {Mailbox} */
    this.mailbox = parent
      ? parent.root.mailbox
      : new Mailbox(network, {
          inbox: box(this.local.store, 'inbox'),
          outbox: box(this.local.store, 'outbox'),
          onerror: (err) => this._onerror(err)
        })
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
    // one for the app: what a handle does on its own reaches the root's
    /** @private */
    this._onerror = parent ? parent._onerror : this._opts.onerror || ((err) => console.error(err))
    /** @type {Set<Handle> | null} */
    this.children = parent ? null : new Set()
    // children still opening, not adopted yet: a close must close them too
    /** @private */
    this._pending = parent ? null : new Set()
    // children closing on their own: a close waits for them, they still read its stores
    /** @private */
    this._ending = parent ? null : new Set()
    /** @private */
    this._typeHooks = parent ? null : new Set()
    /** @private */
    this._loading = parent ? null : new Map()
    /** @private */
    this._joining = parent ? null : new Map() // handle id → its join in flight
    /** @private */
    this._coreKeys = parent ? null : new Map()
    /** @private */
    this._offJoins = null
    /** @private */
    this._departing = parent ? null : new Map()
    /** @private */
    this._leaving = parent ? null : new Map()
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
    // what its holders tied to it, a watch: gone with the last of them
    /** @private */
    this._owned = new Set()
    // what follows it for as long as it is open, an extension's watch
    /** @private */
    this._kept = new Set()
    /** @private */
    this._arriving = false
    // a child's holders: open hands every caller on this device the same handle, so each close lets one go and the
    // last one leaves it idle
    /** @private */
    this._refs = 0
    // a child's compare with the root's device keys, the next one behind it
    /** @private */
    this._pruning = null
    // the children nobody holds, the least recently used first
    /** @private */
    this._idle = parent ? null : new Set()
    // the closed rooms a pass is telling, by id: an open of one waits for it to close
    /** @private */
    this._tellings = parent ? null : new Map()
    /** @private */
    this._telling = null
    // what an extension tells the rooms closed here, through the same pass: `stamp` names it,
    // `tell` writes it into a room opened for it
    /** @private @type {Array<{ stamp: () => Promise<string | null>, tell: (child: Handle) => Promise<void> }> | null} */
    this._tellers = parent ? null : []
    /** @private */
    this._retell = false

    this.store = new Database({
      store: store,
      identity,
      network,
      spec,
      key: opts.key,
      // the root stays seed-derived: a phrase recovers it, nothing delivers it
      encryptionKey: parent ? opts.encryptionKey : identity.encryptionKey,
      epochs: opts.epochs,
      namespace: opts.namespace,
      keyPair: opts.keyPair,
      pinned: !parent,
      root: !parent,
      // the root has no topic to push to
      push: !!parent,
      // the root says which of this identity's devices are removed: behind there, behind here
      parent: parent?.root.store,
      onerror: this._onerror
    })
    /** @private */
    this._pair = null
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
        nearby: { get: () => this._peers(), watch: (fn) => this._onRadio(fn) },
        topics: { get: (q) => this._topics(q), watch: (fn) => this._onTopics(fn) }
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
   * Canonical id: the identity id on the root, the database key on a handle.
   *
   * @returns {string | null}
   */
  get id() {
    if (!this.parent) return this.identity.id
    return this.store?.key ? hid.encode(this.store.key) : null
  }

  /**
   * This device's id and name. `null` on a handle.
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
    this._pair = new Pairing({ mailbox: this.mailbox, db: this.store })
    await this._pair.ready()
    this.root._coreKeys.set(b4a.toHex(this.store.key), this.store.encryptionKey)
    if (!this.parent) {
      await this.fileServer.listen()
      await this.mailbox.ready()
      const prune = this.store.onUpdate('devices', () => {
        this._pruneAll().catch(this._onerror)
        this._tellClosed()
      })
      this.once('close', prune)
      if (this._bluetooth) {
        const off = this.store.onUpdate('profile', () => this._tell().catch(this._onerror))
        this.once('close', off)
        await this._tell()
      }
      // the joins on their way, at launch and as their rows move
      this._offJoins = this.store.onUpdate('handles', () => this._carryOn().catch(this._onerror))
      await this._carryOn().catch(this._onerror)
      await this._sweep().catch(this._onerror)
      this._reserve().catch(this._onerror)
      this._tellClosed()
      // the handles rows, keyed by push topic, for a cold push process that cannot read the root
      const off = this.store.onUpdate('handles', () => this._index().catch(this._onerror))
      this.once('close', off)
      await this._index()
    }
  }

  /** @private */
  async _close() {
    // a write that raced a suspend holds the close until the storage resumes, once a suspend still running settled
    if (this._sus) await this._sus.resume()
    this.root._coreKeys.delete(b4a.toHex(this.store.key))
    if (this._blobs?.key) this.root._coreKeys.delete(b4a.toHex(this._blobs.key))
    for (const b of this._epochBlobs?.values() || []) {
      if (b.key) this.root._coreKeys.delete(b4a.toHex(b.key))
    }
    for (const hex of this._blobKeys || []) this.root._coreKeys.delete(hex)
    this._disown()
    for (const r of [...this._kept]) r.destroy?.()
    this._kept.clear()
    if (this._discovery) this._discovery.destroy().catch(safetyCatch)

    const root = !this.parent
    this._offJoins?.()
    const steps = [
      ...[...(this._joining?.values() || [])].map((join) => () => join.running?.abort()),
      // mirroring stops before any database closes, once the mailbox is done with it: blind peering reads
      // storage for each database it mirrors
      ...(root ? [() => this.mailbox.close(), () => this.network.closePeering()] : []),
      () => this._blobs?.close(),
      ...[...(this._epochBlobs?.values() || [])].map((b) => () => b.close()),
      ...[...(this.children || [])].map((c) => () => c._end()),
      ...[...(this._pending || [])].map((c) => () => c._end()),
      ...[...(this._ending || [])].map((c) => () => c.closing),
      () => this._pair?.close()
    ]
    this._epochBlobs = null
    this.children?.clear()

    if (!root) {
      this.parent.children?.delete(this)
      this.parent._ending?.add(this)
      steps.push(
        () => this.parent._seal(this).catch(this._onerror),
        () => this.store.close()
      )
    } else {
      const store = this.store.store
      steps.push(
        () => this._bluetooth?.close(),
        () => this.local.close(),
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
    try {
      await settle(steps)
    } finally {
      this.parent?._ending?.delete(this)
    }
  }

  /**
   * Tie a destroyable resource (a `watch` stream, a timer, any `{ destroy }`) to this handle, so callers
   * don't track cleanup. Tied by a holder, it is destroyed once the last holder closes the handle; tied by
   * a `handle` listener as it runs, an extension's watch, it follows the handle for as long as it is open.
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
    const tied = this._arriving ? this._kept : this._owned
    tied.add(resource)
    resource.once?.('close', () => tied.delete(resource))
    return resource
  }

  /** @private */
  _disown() {
    for (const r of [...this._owned]) r.destroy?.()
    this._owned.clear()
  }

  // a file's url on this device's file server, for the rows that name it
  /** @private */
  _link(id) {
    return this.root.fileServer.getLink(id)
  }

  // the verbs in lib/operators.js land here

  // the root's invite is for a device of yours: one, confirmed by hand, carrying the identity the
  // device checks its chain against
  /** @private */
  async _invite(opts = {}) {
    if (!opts || typeof opts !== 'object') throw CeroError.INVALID('invite options are an object')
    if (this.parent) {
      const invite = await this._pair.invite(opts)
      // a close right after the invite must not drop the row that reopens this handle at boot
      await this._saved
      return invite
    }
    const { ttl = '2h' } = opts
    return this._pair.invite({ role: 'owner', confirm: true, ttl, data: this.identity.publicKey })
  }

  /** @private */
  async _revoke(invite) {
    return this._pair.revoke(invite)
  }

  // accepting on the root links the device: this one attests its key
  /** @private */
  async _answer(id, { accept, role, reason }) {
    if (!accept) return this._pair.deny(id, reason)
    if (this.parent) return this._pair.accept(id, { role })
    const { data: row } = await this.store.get('requests', id)
    if (!row) throw CeroError.UNKNOWN('request', id)
    return this._pair.accept(id, { proof: this.identity.link(row.key) })
  }

  /** @private */
  _rotate() {
    return this.store.rotate()
  }

  /** @private */
  _removed(id) {
    return this.store.removed(id)
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
  async _leave() {
    if (!this.parent) throw CeroError.INVALID('the root cannot be left')
    // leaving is written on the root row: behind there, nothing is done
    if (this.parent.store.behind !== null) throw CeroError.BEHIND(this.parent.store.behind)
    // what the room refuses of her removal is refused here, before the row says leaving
    const { data: members } = await this.store.get('members')
    const others = members.filter((m) => m.id !== this.identity.id)
    const owner = members.some((m) => m.id === this.identity.id && m.role === 'owner')
    if (owner && others.length && !others.some((m) => m.role === 'owner')) {
      throw CeroError.INVALID('the last owner cannot leave: make another member an owner first')
    }
    const root = this.root
    // her removal is on the room's log before the call resolves: the row carries the rest
    const out = root.store
      .set('handles', { id: this.id, state: 'leaving' })
      .then(() => this.store.del('members', this.identity.id))
    root._leaving.set(this.id, out)
    try {
      await out
    } finally {
      root._leaving.delete(this.id)
    }
  }

  // a leaving row is carried by every device of the identity seated in its room: its removal of
  // herself, held by another device or a mirror, then the row goes
  /** @private */
  _depart(type, id) {
    if (this._departing.has(id)) return
    const run = async () => {
      if (!(await this._loadKeyPair(id))) return
      await this._leaving.get(id)?.catch(safetyCatch)
      const child = await this._load(type, id)
      try {
        const out = await child.store.removed(this.identity.id)
        // a launch finds a leave the app closed under before her removal was appended
        if (!out) await child.store.del('members', this.identity.id)
        await child.store.held()
        if (out === 'removed') return
        const { data: row } = await this.store.get('handles', id)
        if (row?.state !== 'leaving') return
        await this.store.tx(async (tx) => {
          await tx.set('handles', { id, state: 'left' })
          await tx.del('handles', id)
        })
      } finally {
        await child._end()
      }
    }
    const going = run()
      .catch((err) => err.code !== 'CLOSED' && this._onerror(err))
      .finally(() => this._departing.delete(id))
    this._departing.set(id, going)
  }

  // a device that applies its own identity's removal writes it on the row, with who removed her
  /** @private */
  async _ousted(child) {
    const removal = await child.store.removal(this.identity.id)
    if (!removal) return
    const { data: row } = await this.store.get('handles', child.id)
    // only a seat held is lost: a row asking or joining is a rejoin under way, one ended is over
    if (!row || !['in', 'leaving'].includes(row.state || 'in')) return
    const fields = { by: removal.by, reason: null, encryptionKey: null, epochs: null }
    await this.store.set('handles', { id: child.id, state: 'removed', ...fields })
  }

  /**
   * One holder done with it: a child stays open for the others. With its last, what they tied to it ends and it
   * stays open, idle, so a reopen finds it as it is; the root keeps `keepOpen` of them (16 by default) and one more
   * closes the least recently used, on its own. The root closes at once, after any `cero.link` or `cero.restore` on
   * it: one still waiting stops, one taking its place finishes first.
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.parent) {
      // one swap may wait behind another: the root ends once none is left
      const swap = this._swap
      if (swap) return (swap.committing ? swap.done : swap.abort()).then(() => this.close())
      return this._end()
    }
    if (this._refs > 1) {
      this._refs--
      return
    }
    const idle = this.root._idle
    if (idle.has(this)) return
    const max = this.root._opts.keepOpen ?? KEEP_OPEN
    if (!max || this._refs === 0) return this._end()
    this._refs = 0
    this._disown()
    idle.add(this)
    if (idle.size <= max) return
    const [oldest] = idle
    oldest._end().catch(this._onerror)
  }

  /** @private one more holder: an idle handle is kept */
  _hold() {
    this.root._idle.delete(this)
    this._refs++
  }

  /**
   * Closed for every holder at once: pushed out past `keepOpen`, the parent closing, or the handle left for good.
   * @private
   */
  _end() {
    this.root._idle.delete(this)
    this._refs = 0
    return super.close()
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
      throw CeroError.INVALID(
        "suspend and resume are the app's, on me: a handle uses cero.activate"
      )
    }
    return this._sus
  }

  // true ranks a handle as just used, false takes it off the swarm until something lands in it
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
      version: await this.store.dispatcher.version(this.store.view),
      nearby: this.root._bluetooth?.state ?? null,
      owed: await this.store.owed()
    }
    if (this.parent) data.topic = b4a.toHex(this.store.discoveryKey)
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
    if (this.parent) sources.push([this.root, 'status'], [this.root.store, 'behind'])
    for (const [emitter, event] of sources) emitter.on(event, fn)
    const off = this._onRadio(fn)
    return () => {
      for (const [emitter, event] of sources) emitter.off(event, fn)
      off()
    }
  }

  /** @private */
  async _nearby(on, opts) {
    return this.root._bluetooth.set(on, opts)
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

  // a peer's name as its member row shows it in a handle open here; a stranger has none
  /** @private */
  async _nameOf(id) {
    for (const room of this.children) {
      const { data } = await room.store.get('members', id)
      if (data?.name) return data.name
    }
    return null
  }

  /** @private */
  _onRadio(fn) {
    const bt = this.root._bluetooth
    if (!bt) return () => {}
    bt.on('update', fn)
    return () => bt.off('update', fn)
  }

  /** @private */
  _onTopics(fn) {
    this.on('topics', fn)
    return () => this.off('topics', fn)
  }

  /** @private */
  async _topics(query) {
    if (typeof query === 'string') {
      const { data } = await this.local.store.get('topics', query)
      return { data: data && listing(data) }
    }
    const rows = (await this.local.store.get('topics')).data
    return listed(rows.map(listing), query)
  }

  // one pass at a time, failed or not: two overlapping could put back a row the later one deleted. A call while a
  // pass waits to start joins it; `child` is the handle whose writers changed, none follows the root's rows
  /** @private */
  _index(child = null) {
    if (this._queued) {
      if (child) this._queued.children.add(child)
      else this._queued.root = true
      // a failed pass reaches onerror once, through the call that queued it: joined calls only wait for it
      return this._indexing.catch(() => {})
    }
    const queued = (this._queued = { root: !child, children: new Set(child ? [child] : []) })
    const run = async () => {
      this._queued = null
      if (this.closing || this.closed) return
      try {
        if (queued.root) await this._follow()
      } finally {
        // their writers are read whether or not the root's rows were, each on its own
        for (const child of queued.children) await this._topic(child).catch(this._onerror)
      }
    }
    this._indexing = (this._indexing ?? Promise.resolve()).then(run, run)
    return this._indexing
  }

  // a handle on its way to closing writes the writers it last applied while its store still reads, so a removal that
  // landed just before is kept; the root's local store closes after its handles
  /** @private */
  _seal(child) {
    const run = () => this._topic(child, true)
    this._indexing = (this._indexing ?? Promise.resolve()).then(run, run)
    return this._indexing
  }

  // the topics rows follow the root's handles row by row: those that changed since the last pass that finished, so
  // a launch reads none of the others. A pass with no point to go on from reads them all and drops the rows of
  // handles that are gone
  /** @private */
  async _follow() {
    const { changes, reset, settle } = await this.store.since('handles', 'topics')
    let rows = null
    if (reset) {
      const wanted = new Set(
        changes.filter(({ next }) => topical(next)).map(({ next }) => topicOf(next))
      )
      rows = new Map((await this.local.store.get('topics')).data.map((row) => [row.id, row]))
      for (const id of rows.keys()) {
        if (!wanted.has(id)) await this._drop(id)
      }
    }
    for (const { prev, next } of changes) {
      if (!topical(next)) {
        if (prev?.encryptionKey || !next) await this._drop(topicOf(prev))
        continue
      }
      await this._row(next, rows ? (rows.get(topicOf(next)) ?? null) : undefined)
    }
    await settle()
  }

  // a topics row written or dropped wakes what watches them
  /** @private */
  async _put(row) {
    await this.local.store.put('topics', row)
    this.emit('topics')
  }

  /** @private */
  async _drop(id) {
    await this.local.store.del('topics', id)
    this.emit('topics')
  }

  // who may write to an open handle, on the row the root's pass wrote for it; a handle on its way out is its
  // seal's to read
  /** @private */
  async _topic(child, sealing = false) {
    if (!child.opened || (child.closing && !sealing)) return
    const id = b4a.toHex(child.store.discoveryKey)
    let { data: have } = await this.local.store.get('topics', id)
    if (!have) {
      // the root's pass has not written its row, or failed to: it does now, so the handle's writers are kept
      await this._follow()
      have = (await this.local.store.get('topics', id)).data
      if (!have) return
    }
    const writers = await writersOf(child.store).catch(unread)
    if (sameBytes(have.writers, writers)) return
    // me.topics shows no writers: this one wakes no watch
    await this.local.store.put('topics', { ...have, writers })
  }

  // one handle's topics row, written when it differs from `have`, the row there is, read when not given. Who may
  // write is read off the handle while it is open here, and kept as it was otherwise
  /** @private */
  async _row(h, have) {
    const id = topicOf(h)
    // a handle on its way out is its seal's to read
    const child = [...this.children, ...this._pending].find(
      (c) => c.opened && !c.closing && c.id === h.id
    )
    if (have === undefined) have = (await this.local.store.get('topics', id)).data
    const row = {
      id,
      handle: h.id,
      type: h.type,
      key: h.key,
      name: h.name ?? null,
      encryptionKey: h.encryptionKey ?? null,
      epochs: h.epochs && c.decode(epochEntries, h.epochs).length ? h.epochs : null,
      writers: child ? await writersOf(child.store).catch(unread) : (have?.writers ?? null)
    }
    if (!same(have, row)) await this._put(row)
  }

  // a push about one of this device's handles, verified against its own cores
  /** @private */
  async _receive(payload) {
    // a suspended storage answers no read: the cold entry serves a push while the app sleeps
    if (this._sus.suspended) throw CeroError.INVALID('receive: the app is suspended')
    return read(this.store.store.storage, this.spec, payload, this.local.store)
  }

  /** @private */
  async _phrase() {
    return this.identity.toPhrase()
  }

  /** @private */
  async _send(address, value, { keep = true } = {}) {
    if (this.root.closing) throw CeroError.CLOSED('Mailbox')
    const to = decodeAddress(address)
    await this.root.mailbox.send(to, seal(this.identity, to, value), { keep })
  }

  /** @private */
  _inbox(secret, fn, { keep = true } = {}) {
    const to = Mailbox.getAddress(secret)
    const onmessage = async (bytes) => {
      const mail = unseal(to, bytes)
      if (!mail) return false
      await fn(mail.value, { id: mail.id, from: mail.from, device: mail.device })
    }
    const inbox = this.root.mailbox.receive(secret, onmessage, { keep })
    return () => inbox.close()
  }

  /**
   * @param {Uint8Array} coreKey
   * @param {object} info
   * @returns {{ key: Uint8Array, encryptionKey: Uint8Array } | null}
   * @private
   */
  _resolveCore(coreKey, info) {
    const keys = this.root._coreKeys
    const file = (type) => (info.blob ? keys.get(fileEntry(coreKey, info.blob, type)) : undefined)
    // a row typed '' keys its file ahead of one whose type no header carries, served as '' too
    const encryptionKey =
      file(info.type) ?? (info.type ? undefined : file(UNSERVED)) ?? keys.get(b4a.toHex(coreKey))
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
      // a row's stamp keys its own file: a member's row cannot pick the key of another's on the same core
      const { coreKey, blobId, type } = decodeId(id)
      // a core this device keys itself serves every file on it
      if (this.root._coreKeys.has(b4a.toHex(coreKey))) return
      const entry = fileEntry(coreKey, blobId, servedType(type) === type ? type : UNSERVED)
      if (!this.root._coreKeys.has(entry)) {
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
        this.root._coreKeys.set(entry, key)
      }
      // remember which handle read it, so close prunes the entry
      if (this !== this.root) (this._blobKeys ??= new Set()).add(entry)
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

  // base-era cores use the OWNING handle's key, handles have their own
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
        // inheriting identity.encryptionKey would let any member decrypt every handle
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
      // one batch, so a handle's first ops land together
      await child.store.tx(async (tx) => {
        // first, so the rest is written at the version
        await tx.call('upgrade', { version: child.store.target })
        await tx.call('add-writer', {
          master: this.identity.publicKey,
          writer: writerKey,
          proof: this.identity.sign(admission(child.store.key, writerKey, child.store.writerKey)),
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
      // a creation the parent's close broke fails with CLOSED, whichever resource went first
      const reason = this.closing || this.closed ? CeroError.CLOSED('Handle') : err
      if (abort) abort(reason)
      if (inflightId) this._loading?.delete(inflightId)
      await child._end().catch(safetyCatch)
      throw reason
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
    const { key } = Invite.parse(invite)
    const known = await this._joined(type, key)
    if (known) return known

    const id = hid.encode(key)
    const start = Date.now()
    let { data: row } = await this.store.get('handles', id)
    // a room being left is asked again once it is left
    if (row?.state === 'leaving') {
      await wait(null, this._left(id), timeout)
      row = (await this.store.get('handles', id)).data
    }
    // a join another device of this identity asks with is waited on here, not asked again
    const theirs =
      row?.state === 'asking' && row.invite === invite && !(await this._asked(id, invite))
    const join = theirs ? null : this._start(invite, type)
    // a row in a room this identity lost its seat in is not the join landing: it lands once it moved on
    const stale = !!row && (row.state || 'in') === 'in'
    const left = timeout && Math.max(1, timeout - (Date.now() - start))
    await wait(join, this._landed(id, invite, join, stale), left)
    return this._load(type, id)
  }

  /** @private */
  _left(id) {
    return new Promise((resolve, reject) => {
      const done = (err) => {
        off()
        this.off('close', onclose)
        if (err) reject(err)
        else resolve()
      }
      const check = async () => {
        const { data: row } = await this.store.get('handles', id)
        if (row?.state !== 'leaving') done(null)
      }
      const off = this.store.onUpdate('handles', () => check().catch(done))
      const onclose = () => done(CeroError.CLOSED('Handle'))
      this.once('close', onclose)
      check().catch(done)
    })
  }

  // what an open waits on: the row, wherever the join is carried, or an error here its row has no state for
  /** @private */
  _landed(id, invite, join, stale) {
    return new Promise((resolve, reject) => {
      const done = (err) => {
        off()
        this.off('close', onclose)
        if (err) reject(err)
        else resolve()
      }
      const check = async () => {
        const { data: row } = await this.store.get('handles', id)
        // the row of another invite is a join this one takes over, unless it took this one over
        const ours = row?.invite === invite || (!!join && row?.invite === join.invite)
        const state = ours && (row.state || 'in')
        if (state && state !== 'in') stale = false
        if (state === 'in' && !stale && row.encryptionKey) done(null)
        else if (OVER[state && state.toUpperCase()]) done(ENDS[state](row.reason))
      }
      const off = this.store.onUpdate('handles', () => check().catch(done))
      const onclose = () => done(CeroError.CLOSED('Handle'))
      this.once('close', onclose)
      join?.done.catch(done)
      check().catch(done)
    })
  }

  // the device that asked holds the writer the answer is sealed to
  /** @private */
  async _asked(id, invite) {
    const { data: kept } = await this.local.store.get('handle-keypairs', id)
    return kept?.invite === invite
  }

  // one join a handle, whoever waits on it: it goes on until its row says how it ended, and a close only pauses it
  /** @private */
  _start(invite, type) {
    const id = hid.encode(Invite.parse(invite).key)
    let join = this._joining.get(id)
    if (!join) {
      join = { id, type, invite: null, waiting: 0, end: null, running: null }
      join.done = new Promise((resolve, reject) => {
        join.resolve = resolve
        join.reject = reject
      })
      join.done.catch(safetyCatch)
      this._joining.set(id, join)
    }
    if (join.invite !== invite) this._run(join, invite)
    return join
  }

  // a newer invite takes over from an older attempt: the writer stays, so a reply to the older one still lands
  /** @private */
  async _run(join, invite) {
    join.invite = invite
    join.running?.abort()
    const running = (join.running = new AbortController())
    const settle = (end, value) => {
      this._joining.delete(join.id)
      end(value)
    }
    try {
      const id = await this._ask(join.type, invite)
      const writer = await this._loadKeyPair(id)
      const { data: row } = await this.store.get('handles', id)
      // the keys are on the row before the reply is let go: a restart opens the handle without joining again
      const keep = async (answer) => {
        if (!(answer instanceof Error)) await this._stand(id, 'joining', keys(answer))
      }
      const spec = pickHandle(this.spec, join.type)
      const { identity, mailbox } = this
      const opts = { identity, spec, writer, keep, timeout: 0, signal: running.signal }
      const reply = row.encryptionKey
        ? { ...row, epochs: row.epochs ? c.decode(epochEntries, row.epochs) : [], writer }
        : await Pairing.join(mailbox, invite, opts)
      await this._stand(id, 'joining', keys(reply))
      const child = await this._enter(join.type, reply, invite)
      // every waiter takes its own hold once the row reads in: this one is let go, idle until the app opens it
      child.close().catch(this._onerror)
      settle(join.resolve, child)
    } catch (err) {
      if (running !== join.running) return
      const end = join.end || err
      // counted before its row says how it ended: a waiter hears that row
      const alone = !join.waiting
      // a close pauses the join, anything else ends it, and its row says how
      if (end.code !== 'CLOSED') await this._over(invite, end).catch(this._onerror)
      if (join.end?.code === 'CANCELLED') await this._retract(join).catch(this._onerror)
      if (err.code !== 'CLOSED' && alone) this._onerror(err)
      settle(join.reject, end)
    }
  }

  // ends it for good from any device: its row reads cancelled, so no device and no restart carries it on
  /** @private */
  async _cancel(invite) {
    const root = this.root
    const id = hid.encode(Invite.parse(invite).key)
    const { data: row } = await root.store.get('handles', id)
    if (row?.state !== 'asking') return false
    await root._over(invite, CeroError.CANCELLED())
    const join = root._joining.get(id)
    if (join) {
      root._stop(join, CeroError.CANCELLED())
      await join.done.catch(safetyCatch)
    } else await root._retract(row)
    return true
  }

  // only the device that asked holds the writer its request is under: its keypair row stays, and a
  // launch announces the cancel again, until a peer or a mirror holds it
  /** @private */
  async _retract({ id, type }) {
    const { data: kept } = await this.local.store.get('handle-keypairs', id)
    if (!kept?.invite) return false
    const writer = { publicKey: kept.publicKey, secretKey: kept.secretKey }
    Pairing.cancel(this.mailbox, kept.invite, { spec: pickHandle(this.spec, type), writer })
      .then(() => this._forget(id, writer.publicKey))
      .catch((err) => this.closing || this._onerror(err))
    return true
  }

  // a keypair row goes with nothing owed on it, unless a join since took it over
  /** @private */
  async _forget(id, publicKey) {
    const { data: kept } = await this.local.store.get('handle-keypairs', id)
    if (kept && b4a.equals(kept.publicKey, publicKey)) {
      await this.local.store.del('handle-keypairs', id)
    }
  }

  /** @private */
  _stop(join, end) {
    join.end = end
    join.running?.abort()
  }

  // a join's row: `asking` with its invite and no keys. A join that ended under this invite ends the same way again
  /** @private */
  async _ask(type, invite) {
    const { key } = Invite.parse(invite)
    const id = hid.encode(key)
    const { data: row } = await this.store.get('handles', id)
    const state = row && (row.state || 'in')
    // the writer this device asks with: fixed before the join is written, so a resumed one hears the reply to it
    const { data: kept } = await this.local.store.get('handle-keypairs', id)
    const mine = !!kept?.invite && (state === 'asking' || state === 'joining')
    if (mine && (state === 'joining' || row.invite === invite)) return id
    if (ENDS[state] && row.invite === invite) throw ENDS[state](row.reason)
    await this._saveKeyPair(id, mine ? kept : Identity.randomKeyPair(), invite)
    // a room another device of this identity already has the keys of is joined with them
    if (state === 'joining') return id
    // a room she left is asked again under any invite, the one she came in with too
    if (state === 'left' && row.invite === invite) await this.store.call('del-handle', { id })
    const ts = Date.now()
    await this.store.call('add-handle', {
      id,
      type,
      key,
      name: null,
      createdAt: ts,
      updatedAt: ts,
      state: 'asking',
      invite
    })
    return id
  }

  // a join's row moves on once: a step run again finds it there
  /** @private */
  async _stand(id, state, fields) {
    const { data: row } = await this.store.get('handles', id)
    if (!row || row.state === state) return
    await this.store.set('handles', { id, state, ...fields })
  }

  // how a join ended, on its row, which keeps none of the keys it was handed
  /** @private */
  async _over(invite, err) {
    const state = OVER[err.code]
    const id = hid.encode(Invite.parse(invite).key)
    const { data: row } = await this.store.get('handles', id)
    // a join on its way ends, one seated or over stays as it reads
    const ends = row?.state === 'asking' || (row?.state === 'joining' && state === 'denied')
    if (!state || !ends) return
    const reason = err.reason ?? null
    await this.store.set('handles', { id, state, reason, encryptionKey: null, epochs: null })
  }

  // a stored writer still admitted reopens without pairing; a removed writer's core is frozen,
  // so that one pairs again with a fresh keypair
  /** @private */
  async _joined(type, key) {
    const { data: existing } = await this.store.get('handles', hid.encode(key))
    if (!existing) return null
    if (existing.type !== type) {
      throw CeroError.INVALID(`handle ${existing.id} is type ${existing.type}, not ${type}`)
    }
    // a join on its way, or one that is over, is its row's to tell
    if (!existing.encryptionKey || (existing.state || 'in') !== 'in') return null
    const known = await this._load(type, existing.id)
    const { data: me } = await known.store.get('members', this.identity.id)
    const { data: device } = await known.store.get('devices', hid.encode(known.store.writerKey))
    // a reader never had a seat, a removed writer lost it
    if (me && (device || me.role === 'reader')) return known
    // the identity's removal is its row's, every device's; a device that alone lost its seat is refused here
    if (!me) await this._ousted(known).catch(safetyCatch)
    await known._end().catch(safetyCatch)
    if (me) throw ENDS.removed()
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
  async _enter(type, reply, invite) {
    const id = hid.encode(reply.key)
    // a room this identity lost its seat in stays open on its old writer: it ends before the new seat opens it
    const stale = [...this.children].find((c) => c.id === id && !c.closing)
    const out = stale && (await stale.store.removed(this.identity.id))
    if (out) await stale._end().catch(safetyCatch)
    const child = /** @type {Child} */ (
      this._room({
        spec: pickHandle(this.spec, type),
        namespace: `${NS}/handle/${type}/${randomNs()}`,
        ...delivered(reply)
      })
    )
    // its row is listed while it joins: an open by id shares this child, a second on the same core deadlocks
    let publish = null
    let abort = null
    const inflight = new Promise((resolve, reject) => {
      publish = resolve
      abort = reject
    })
    inflight.catch(safetyCatch)
    this._loading?.set(id, inflight)
    try {
      await child.ready()
      // let in by a promise, this device seats itself: its claim writes the member row
      await child.store.claim({ timeout: 0 })
      // admitted once our member row lands; the same apply seats a writer, a reader has no seat
      const member = await admitted(child.store, this.identity.id)
      if (member.role !== 'reader' && !child.store.writable) {
        await child.store.whenWritable({ timeout: 0 })
      }

      await this._saveKeyPair(id, child.store.keyPair, invite)

      const ts = Date.now()
      await this.store.call('add-handle', {
        id,
        type,
        key: child.store.key,
        encryptionKey: child.store.encryptionKey,
        epochs: c.encode(epochEntries, child.store.keyring.all()),
        name: null,
        createdAt: ts,
        updatedAt: ts,
        state: 'in',
        invite
      })
      this._adopt(child, {})
      publish(child)
      this._loading?.delete(id)
      return child
    } catch (err) {
      abort(err)
      this._loading?.delete(id)
      await child._end().catch(safetyCatch)
      throw err
    }
  }

  // the rows that ended go, with their keypairs: a cancel once no peer is owed it, or `KEPT` on
  // with none reached, the others once the app had `KEPT` to show why
  /** @private */
  async _sweep() {
    const old = Date.now() - KEPT
    const gone = []
    for (const state of SWEPT) {
      for (const row of (await this.store.get('handles', { state })).data) {
        const owed = state === 'cancelled' && row.updatedAt >= old && (await this._retract(row))
        if (!owed && (state === 'cancelled' || row.updatedAt < old)) {
          gone.push(row.id)
        }
      }
    }
    if (!gone.length) return
    await this.store.tx(async (tx) => {
      for (const id of gone) await tx.del('handles', id)
    })
    for (const id of gone) await this.local.store.del('handle-keypairs', id)
  }

  // the joins on their way go on, with nobody waiting; the mailbox sends what its outbox kept
  /** @private */
  async _carryOn() {
    // the rows not settled, through their index: never every handle
    for (const state of ['asking', 'joining']) {
      for (const { id, type, invite, encryptionKey } of (await this.store.get('handles', { state }))
        .data) {
        // an answer is heard by the device that asked, and the keys on a row seat any device
        if (encryptionKey || (await this._asked(id, invite))) this._start(invite, type)
      }
    }
    for (const { id, type } of (await this.store.get('handles', { state: 'leaving' })).data) {
      this._depart(type, id)
    }
    // a join another device ended stops here
    for (const join of [...this._joining.values()]) {
      const { data: row } = await this.store.get('handles', join.id)
      if (row?.invite === join.invite && OVER[row.state?.toUpperCase()]) {
        this._stop(join, ENDS[row.state](row.reason))
      }
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
    const loading = this._loading.get(id)
    // no await unless one is loading: a concurrent open must see this one's entry, not race it
    const open = [...this.children].find((c) => c.id === id) || (loading && (await loading))
    if (open && open.type !== type) {
      throw CeroError.INVALID(`handle ${id} is type ${open.type}, not ${type}`)
    }
    if (open) {
      open._hold()
      return open
    }
    const reopening = this._reopen(type, id)
    this._loading.set(id, reopening)
    try {
      return await reopening
    } finally {
      this._loading.delete(id)
    }
  }

  /**
   * Reconstruct a child handle by id. Reuses the stored writer keypair if available; otherwise
   * stores a fresh one, and a device that may write claims its seat with it.
   *
   * @param {string} type
   * @param {string} id
   * @returns {Promise<Handle>}
   * @private
   */
  async _reopen(type, id) {
    let child = null
    try {
      const { data } = await this.store.get('handles', id)
      // a join with no keys yet is no room to open
      if (!data?.encryptionKey) throw CeroError.UNKNOWN('handle', id)
      if (data.type !== type) {
        throw CeroError.INVALID(`handle ${id} is type ${data.type}, not ${type}`)
      }
      await this._tellings.get(id)
      // stored before its claim is on the log: a retry claims with it, never with another
      const writer = (await this._loadKeyPair(id)) || Identity.randomKeyPair()
      await this._saveKeyPair(id, writer)
      child = this._room({
        spec: pickHandle(this.spec, type),
        namespace: `${NS}/handle/${type}/${id}`,
        key: data.key,
        encryptionKey: data.encryptionKey,
        epochs: data.epochs ? c.decode(epochEntries, data.epochs) : undefined,
        keyPair: /** @type {KeyPair} */ (writer)
      })
      await child.ready()
      // a writer that never wrote has not claimed yet
      if (!child.store.writable && child.store.length === 0) {
        await child.store.claim({ timeout: TIMEOUT })
      }
      this._adopt(child, {})
      return child
    } catch (err) {
      await child?._end().catch(safetyCatch)
      // a reopen the root's close broke fails with CLOSED, whichever store went first
      throw this.closing || this.closed ? CeroError.CLOSED('Handle') : err
    }
  }

  // a handle has its type's hooks before it opens, so no op it applies runs without them
  /** @private */
  _room(opts) {
    // a closing root has listed the rooms it closes: one opened now would outlive its stores
    if (this.closing || this.closed) throw CeroError.CLOSED('Handle')
    const child = new Handle({ parent: this, ...opts })
    for (const hook of this._typeHooks) hook.apply(child)
    this._pending.add(child)
    child.once('close', () => this._pending.delete(child))
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
    if (this.closed) return
    await this.store.store.resume().catch(this._onerror)
    // a close takes its storage back and nothing else: the network stays down
    if (this.closing) return
    await this.network.resume().catch(this._onerror)
    await this._bluetooth?.resume().catch(this._onerror)
  }

  /** @private */
  _adopt(child, info) {
    // a closing parent has already closed its children, it would never close this one
    if (this.closing || this.closed) throw CeroError.CLOSED('Handle')
    this._pending.delete(child)
    this.children.add(child)
    child._refs = 1
    this._serve(child)
    this._carry(child)
    // it tells a handle nothing before it has a seat there
    const prune = () => this._prune(child).catch(this._onerror)
    child.store.on('writable', prune)
    child.once('close', () => child.store.off('writable', prune))
    prune()
    this._seats(child)
    // what a listener ties to the handle as it runs is no holder's: it stays through their last close
    child._arriving = true
    try {
      this.emit('handle', child, info)
    } finally {
      child._arriving = false
    }
  }

  // a handle's topics row follows who may write to it while it is open, so a push is checked
  // against the room as this device last applied it
  /** @private */
  _seats(child) {
    const onchange = (touched) => {
      if (touched.has('*') || touched.has('devices') || touched.has('members')) {
        this._index(child).catch(this._onerror)
        this._ousted(child).catch(this._onerror)
      }
    }
    child.store.on('update', onchange)
    child.once('close', () => child.store.off('update', onchange))
    this._index(child).catch(this._onerror)
  }

  // a device removed from the root is out of every handle: its chain is static, so a handle is
  // told the identity's keys the root removed and those it seats, by a device that stands there,
  // when that is not what it was told. One compare at a time: two would tell it twice
  /** @private */
  _prune(child, stamp) {
    const run = async () => {
      try {
        const told = await this._compare(child)
        return told && (stamp === undefined || (await this._teach(child, stamp)))
      } catch (err) {
        // one that closes as it is told is told again, at its next open or pass
        if (this.closing || child.closing || child.closed) return false
        throw err
      }
    }
    const pruning = child._pruning ? child._pruning.then(run) : run()
    child._pruning = pruning.catch(safetyCatch)
    return pruning
  }

  // covered once it holds what the root holds, or this device has no seat there to tell it from
  /** @private */
  async _compare(child) {
    if (child.closing || child.closed) return false
    const removed = await this.store.removals()
    if (removed.length === 0) return true
    const { data: rows } = await this.store.get('devices')
    const standing = rows.filter((row) => row.key).map((row) => row.key)
    const { store } = child
    const at = Math.min(store.version, await store.dispatcher.version(store.view))
    if ((store.meta.since?.routes[`@${store.ns}/revoke`] ?? 0) > at) {
      await this._unseat(child, removed)
    } else {
      if (!store.writable) return true
      if (!has(standing, this.identity.device.publicKey)) return false
      // a root that lags has fewer removed than the handle was told: those add up, and stay
      const told = await store.told(this.identity.id)
      const same =
        removed.every((key) => has(told.removed, key)) &&
        standing.length === told.standing.length &&
        standing.every((key) => has(told.standing, key))
      if (child.closing || child.closed) return false
      if (!same) {
        await store.call('revoke', { removed: b4a.concat(removed), standing: b4a.concat(standing) })
      }
    }
    if (child.closing || child.closed) return false
    await this._mark(child.id, { told: digest(removed, standing) })
    return true
  }

  // what the extensions tell a room this device may write in, stamped once it is told
  /** @private */
  async _teach(child, stamp) {
    if (child.store.writable) for (const { tell } of this._tellers) await tell(child)
    if (child.closing || child.closed) return false
    await this._mark(child.id, { stamp })
    return true
  }

  // what a room was told, kept on its keypair row
  /** @private */
  async _mark(id, marks) {
    const { data } = await this.local.store.get('handle-keypairs', id)
    if (!data || Object.keys(marks).every((k) => sameBytes(data[k], marks[k]))) return
    await this.local.store.put('handle-keypairs', { ...data, ...marks })
  }

  // a handle that has no route to be told by loses the removed device's seats one by one
  /** @private */
  async _unseat(child, removed) {
    const { data: rows } = await child.store.get('devices')
    for (const row of rows) {
      // a sibling this root has not heard of yet is no removal: only its record is
      if (row.memberId !== this.identity.id || !row.key || !has(removed, row.key)) continue
      if (child.closing || child.closed) return
      await child.store.del('devices', row.id)
    }
  }

  /** @private */
  async _pruneAll() {
    for (const child of this.children) await this._prune(child)
  }

  // the closed rooms are told too, by a pass over those this device has a writer in, when the root's
  // device lists or the extensions' stamp are not the ones last told to all of them. One pass at a
  // time: a call while one waits to start joins it
  /** @private */
  _tellClosed() {
    if (this._retell) return this._telling
    this._retell = true
    const run = () => {
      this._retell = false
      return this._pass().catch((err) => this.closing || this._onerror(err))
    }
    this._telling = (this._telling ?? Promise.resolve()).then(run)
    return this._telling
  }

  /** @private */
  async _pass() {
    if (this.closing) return
    const lists = await this._lists()
    const stamp = await this._stamp()
    const { data: told } = await this.local.store.get('told')
    const listed =
      !lists ||
      (told && sameBytes(told.removed, lists.removed) && sameBytes(told.standing, lists.standing))
    if (listed && sameBytes(told?.stamp, stamp)) return
    // a writer in a room is the writer keypair this device keeps for it
    const rooms = []
    for (let after; ;) {
      const { data } = await this.local.store.get('handle-keypairs', { gt: after, limit: PAGE })
      for (const row of data) {
        if ((lists && !sameBytes(row.told, lists.marked)) || !sameBytes(row.stamp, stamp)) {
          rooms.push({ id: row.id, used: row.used ?? 0 })
        }
      }
      if (data.length < PAGE) break
      after = data[data.length - 1].id
    }
    rooms.sort((a, b) => b.used - a.used)
    let next = 0
    let covered = true
    const tell = async () => {
      while (next < rooms.length && !this.closing) {
        const { id } = rooms[next++]
        const done = await this._tellOne(id, stamp).catch((err) => {
          if (!this.closing) this._onerror(err)
          return false
        })
        if (!done) covered = false
      }
    }
    await Promise.all(Array.from({ length: TELLING }, tell))
    if (!covered || this.closing) return
    const { removed, standing } = lists ?? told ?? {}
    await this.local.store.set('told', { removed, standing, stamp })
  }

  // the root's device lists, 32-byte keys back to back, when there is a removal to tell and this
  // device stands to tell it
  /** @private */
  async _lists() {
    const removed = await this.store.removals()
    if (removed.length === 0) return null
    const { data: devices } = await this.store.get('devices')
    const standing = devices.filter((row) => row.key).map((row) => row.key)
    if (!has(standing, this.identity.device.publicKey)) return null
    const marked = digest(removed, standing)
    return { removed: b4a.concat(removed), standing: b4a.concat(standing), marked }
  }

  // what the extensions tell the rooms, as one digest: null when they tell nothing
  /** @private */
  async _stamp() {
    const stamps = await Promise.all(this._tellers.map(({ stamp }) => stamp()))
    if (stamps.every((s) => s === null)) return null
    return hash(b4a.from(JSON.stringify(stamps)))
  }

  // a closed room opened only to be told: no seat claimed, nothing handed to the app. One open
  // here runs the same compare, behind its own
  /** @private */
  async _tellOne(id, stamp) {
    const open = [...this.children].find((c) => c.id === id)
    if (open) return this._prune(open, stamp)
    const loading = this._loading.get(id)
    if (loading) {
      const child = await loading.catch(() => null)
      return child ? this._prune(child, stamp) : false
    }
    const telling = this._tellRoom(id, stamp)
    this._tellings.set(
      id,
      telling.catch(() => {})
    )
    try {
      return await telling
    } finally {
      this._tellings.delete(id)
    }
  }

  /** @private */
  async _tellRoom(id, stamp) {
    const { data: row } = await this.store.get('handles', id)
    // a room left on another device has no row; one still being joined is told by its own open
    if (!row?.encryptionKey) return true
    const { type, key, encryptionKey, epochs } = row
    const keyPair = await this._loadKeyPair(id)
    const child = this._room({
      spec: pickHandle(this.spec, type),
      namespace: `${NS}/handle/${type}/${id}`,
      key,
      encryptionKey,
      epochs: epochs ? c.decode(epochEntries, epochs) : undefined,
      keyPair: /** @type {KeyPair} */ (keyPair)
    })
    try {
      await child.ready()
      return await this._prune(child, stamp)
    } finally {
      await child._end().catch(safetyCatch)
    }
  }

  // a handle's epochs ride in its root row, which only the identity's devices read: one that
  // opens the handle later reads history with them, since envelopes in the log address a device
  /** @private */
  _carry(child) {
    const save = async () => {
      const epochs = c.encode(epochEntries, child.store.keyring.all())
      const { data: row } = await this.store.get('handles', child.id)
      if (!row || b4a.equals(row.epochs || b4a.alloc(0), epochs)) return
      await this.store.set('handles', { id: row.id, epochs })
    }
    // read when the row changes, and when an announcement applies: it is learned only after that
    const read = async () => {
      const { data: row } = await this.store.get('handles', child.id)
      if (row?.epochs) await child.store.learn(c.decode(epochEntries, row.epochs))
    }
    const touches = (name) => (touched) => touched.has('*') || touched.has(name)
    const onepoch = () => save().catch(this._onerror)
    const onroot = (touched) => touches('handles')(touched) && read().catch(this._onerror)
    const onchild = (touched) => touches('epochs')(touched) && read().catch(this._onerror)
    child.store.on('epoch', onepoch)
    child.store.on('update', onchild)
    this.store.on('update', onroot)
    child.once('close', () => {
      child.store.off('epoch', onepoch)
      child.store.off('update', onchild)
      this.store.off('update', onroot)
    })
  }

  // before(me.room.notes, fn): on every handle open now and every one opened later
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
    for (const child of [...this.children, ...this._pending]) hook.apply(child)
    const off = () => {
      this._typeHooks.delete(hook)
      for (const o of offs.values()) o()
      offs.clear()
    }
    onAbort(opts?.signal, off)
    return off
  }

  // a handle with invites is reopened at boot, so its joins are answered whenever we are online,
  // not only while the app has the handle open
  /** @private */
  _serve(child) {
    if (!child._pair) return
    const save = async () => {
      const { serving } = child._pair
      if (serving === child._serving) return
      child._serving = serving
      if (!serving) return this.local.store.del('serving', child.id)
      await this.local.store.put('serving', { id: child.id, type: child.type })
    }
    // one at a time, so an invite can wait for its row
    const queue = () => {
      child._saved = (child._saved || Promise.resolve()).then(save).catch(this._onerror)
    }
    child._pair.on('serving', queue)
    queue()
  }

  /** @private */
  async _reserve() {
    for (const { id, type } of (await this.local.store.get('serving')).data) {
      this._load(type, id).then(reserved, (err) => {
        if (err.code === 'UNKNOWN') return this.local.store.del('serving', id).catch(safetyCatch)
        // a close cut it short: the room is served again at the next launch
        if (err.code === 'CLOSED') return
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
  async _saveKeyPair(id, keyPair, invite) {
    if (!keyPair) return
    // a reopen stamps the row: what a join keeps on it stays
    const { data: was } = await this.local.store.get('handle-keypairs', id)
    await this.local.store.put('handle-keypairs', {
      ...was,
      id,
      publicKey: keyPair.publicKey,
      secretKey: keyPair.secretKey,
      ...(invite !== undefined && { invite }),
      used: Date.now()
    })
  }

  /**
   * @param {string} id
   * @returns {Promise<{ publicKey: Uint8Array, secretKey: Uint8Array } | null>}
   * @private
   */
  async _loadKeyPair(id) {
    const { data } = await this.local.store.get('handle-keypairs', id)
    if (!data) return null
    return {
      publicKey: data.publicKey,
      secretKey: data.secretKey
    }
  }
}

// the states a row ends in, read through their index at launch, and how long one stays
const SWEPT = ['cancelled', 'denied', 'expired', 'removed', 'left']
const KEPT = 30 * 24 * 60 * 60 * 1000

// how a join ends, as its row says it and as `open` throws it
const OVER = { DENIED: 'denied', EXPIRED: 'expired', CANCELLED: 'cancelled' }
const ENDS = {
  denied: (reason) => CeroError.DENIED(reason || null),
  expired: () => CeroError.EXPIRED(),
  cancelled: () => CeroError.CANCELLED(),
  // the invite it was let in with is one minted before its removal
  removed: () => CeroError.DENIED('removed')
}

// a push is heard only for a handle this identity is in or joining, with its keys
const TOPICAL = new Set(['in', 'joining'])

function topical(row) {
  return !!row?.encryptionKey && TOPICAL.has(row.state || 'in')
}

// the keys a pairing reply delivered, as a join's row keeps them
const keys = ({ encryptionKey, epochs }) => ({
  encryptionKey,
  epochs: c.encode(epochEntries, epochs)
})

/**
 * Wait for a join as one of its waiters, but stop waiting after `ms`; the join itself goes on.
 *
 * @param {{ waiting: number } | null} join  The join carried here, which reports its errors to the app with none waiting.
 * @param {Promise<void>} landed
 * @param {number} ms  `0` waits as long as the join takes.
 * @returns {Promise<void>}
 */
async function wait(join, landed, ms) {
  if (join) join.waiting++
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    if (!ms) return
    timer = setTimeout(() => reject(CeroError.TIMEOUT('join')), ms)
  })
  try {
    return await Promise.race([landed, timeout])
  } finally {
    clearTimeout(timer)
    if (join) join.waiting--
  }
}

// the keys a pairing reply delivered, as a handle opens with them
function delivered({ key, encryptionKey, epochs, writer }) {
  return { key, encryptionKey, epochs, keyPair: writer }
}

// the hold a boot took on a handle to serve its invites goes back once it serves none
function reserved(child) {
  const release = (serving) => {
    if (serving) return
    child._pair.off('serving', release)
    child.close().catch(child._onerror)
  }
  child._pair.on('serving', release)
  release(child._pair.serving)
}

// the entry type of a row whose type no header carries: no file server url builds it
const UNSERVED = '\n'

// what a room is told of an identity's device keys, as one value to hold it against
function digest(removed, standing) {
  return hash([hash(b4a.concat(removed)), hash(b4a.concat(standing))])
}

// the closed rooms a pass tells at once, and the keypairs it reads at a time
const TELLING = 4
const PAGE = 1000

// a file as its url names it to the file server
function fileEntry(coreKey, { blockOffset, blockLength, byteOffset, byteLength }, type) {
  return [b4a.toHex(coreKey), blockOffset, blockLength, byteOffset, byteLength, type].join('/')
}

// a local list read as a collection reads: one row by id, or the rows a query keeps
function listed(rows, query = {}) {
  if (typeof query === 'string') return { data: rows.find((row) => row.id === query) ?? null }
  const data = filter(rows, query)
  return { data, total: data.length, size: data.length }
}

function admitted(db, id) {
  return new Promise((resolve, reject) => {
    const done = (err, member) => {
      db.off('update', onupdate)
      db.off('close', onclose)
      if (err) reject(err)
      else resolve(member)
    }
    const check = async () => {
      const { data } = await db.get('members', id)
      if (data) done(null, data)
    }
    const onupdate = () => check().catch(done)
    const onclose = () => done(CeroError.CLOSED('Database'))
    db.on('update', onupdate)
    db.once('close', onclose)
    onupdate()
  })
}

function pickHandle(spec, type) {
  const h = spec.handles?.[type]
  if (!h) throw CeroError.UNKNOWN('handle type', type)
  return h
}

function randomNs() {
  return z32.encode(Identity.randomBytes(8))
}

// the push topic of a handles row, which keys its topics row
const topicOf = ({ key }) => b4a.toHex(discoveryKey(key))

// what me.topics shows of a topics row: none of the keys it keeps
const listing = ({ id, handle, type, name }) => ({ id, handle, type, name })

// a topics row still describes its handle
function same(row, next) {
  return (
    !!row &&
    row.handle === next.handle &&
    row.type === next.type &&
    (row.name ?? null) === next.name &&
    b4a.equals(row.key, next.key) &&
    sameBytes(row.encryptionKey, next.encryptionKey) &&
    sameBytes(row.epochs, next.epochs) &&
    sameBytes(row.writers, next.writers)
  )
}

// the keys that may write to a handle now: the devices of its members whose role writes
async function writersOf(db) {
  const [devices, members] = await Promise.all([db.get('devices'), db.get('members')])
  const writes = new Set(members.data.filter((m) => can(m.role, WRITE)).map((m) => m.id))
  return b4a.concat(devices.data.filter((d) => writes.has(d.memberId)).map((d) => hid.decode(d.id)))
}

// a handle whose writers do not read accepts nobody
function unread(err) {
  safetyCatch(err)
  return null
}

function has(keys, key) {
  return keys.some((k) => b4a.equals(k, key))
}

function sameBytes(a, b) {
  return a && b ? b4a.equals(a, b) : (a ?? null) === (b ?? null)
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
