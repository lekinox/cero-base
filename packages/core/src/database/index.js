import HyperDB from 'hyperdb'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import Hypercore from 'hypercore'
import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'

import {
  NAMESPACE,
  SINGLE,
  COLLECTION,
  ACTION,
  QUERY_RESERVED,
  RANK,
  ADMIN,
  OWNER,
  WRITE,
  REMOVALS,
  REFUSALS,
  ASKS
} from '../lib/constants.js'
import { genId } from '../lib/ids.js'
import {
  subscribe,
  admission,
  can,
  filter,
  checkFields,
  checkRequired,
  stamp
} from '../lib/utils.js'
import { wrap, unwrap } from './envelope.js'
import { EpochAutobee, Keyring, loadEpochs, plainId } from './encryption.js'
import { CeroError } from '../lib/errors.js'
import { Identity } from '../identity/index.js'
import { Rotation, removes } from './rotation.js'
import { makeChanges } from './changes.js'
import { makeDispatcher, BESPOKE, leftId, toldId, keysOf } from './dispatch.js'
import { keyPair } from '../mailbox/inbox.js'

// autobee remaps an older store once a recovery peer, a mirror, serves it; unset, it closes the store
const recovery = []
Hypercore.setRecoveryPeers(recovery)

/**
 * @typedef {object} DatabaseOpts
 * @property {import('corestore')} store                              Corestore (or compatible) used to materialize the autobee.
 * @property {import('../identity/index.js').Identity} identity       Long-lived member identity used to sign writer changes.
 * @property {import('../network/index.js').Network} [network]        Optional swarm; required for multi-writer replication; `store` is its store or a session of it.
 * @property {{ database: object, dispatch: { Router: new () => object, encode: (name: string, value: unknown) => Uint8Array, decode: (buf: Uint8Array) => { name: string, value: unknown } }, meta?: { ns?: string, version?: number, rules?: number, start?: number, target?: number, refs?: Record<string, { kind?: string, verb?: string }> } }} spec  Generated hyperdb + hyperdispatch spec.
 * @property {string} [namespace]                                     Corestore namespace; defaults to `cero`.
 * @property {Uint8Array} encryptionKey                               Encrypts it; a join hands it out, so never the identity's on a database you pair.
 * @property {Array<{ epoch: number, entropy: Uint8Array }> | null} [epochs]  Rotation epochs to prime the keyring with (delivered at join).
 * @property {Uint8Array | null} [key]                                Existing autobee key to reopen.
 * @property {boolean} [pinned]                                       Always search and announce, outside the network's presence budget. The root.
 * @property {boolean} [push]                                         Push a notification through the mirrors after a local write to a ref whose meta declares `push`, naming the ref, so members learn of it while their app is dead.
 * @property {import('../identity/index.js').KeyPair} [keyPair]       This device's writer keypair; a fresh random one by default. Never the identity's, never the database key.
 * @property {Database | null} [parent]                               A database whose members this one follows: behind there, it is behind here too.
 * @property {(err: Error) => void} [onerror]                         Called when a node is skipped or refused, or the bee errors.
 *
 * Events: `update` (touched refs, a Set, after each applied batch that changed a row), `apply`
 * (one per applied op: `{ op, name, row, writerKey, seq }`, local and replicated), `writable`,
 * `unwritable`, `behind` (the database's version passed this build's contract).
 *
 * @typedef {Record<string, unknown>} Row  A row, fields by name.
 * @typedef {{ data: Row | null }} SingleResult
 * @typedef {{ data: Row[], total: number | null, size: number }} ListResult  `total` is null when a limited read skipped the full count — pass `{ total: true }` to force it.
 * @typedef {{ gt?: string, gte?: string, lt?: string, lte?: string, reverse?: boolean, limit?: number, search?: string, fields?: string[], total?: boolean }} Query
 * @typedef {{ kind: string, verb: string, name: string }} Ref
 * @typedef {object} HookContext
 * @property {string} op                                One of `put`, `set`, `del`, or an action name.
 * @property {string} name                              The ref the op targets.
 * @property {Record<string, unknown> | null} row       The incoming row; mutate it in `before` to change what lands.
 * @property {Record<string, unknown> | null} existing  The stored row, or null.
 * @property {string | null} id                         The row id for a `del`.
 * @property {string | null} memberId                   The writer's member id, null for a core no member owns yet (a join, a claim, genesis).
 * @property {string | null} role                       The writer's role, null likewise.
 * @property {boolean} [ranked]                        On removing a member or changing her rank: whether the writer's rank alone allows it. A rule answers `'grant'` to allow what rank refuses, `false` to refuse.
 * @property {(ref: string | { name: string }, query?: string | Record<string, unknown>) => Promise<{ data: unknown }>} get
 * @property {(ref: string | { name: string }, row: Record<string, unknown>) => Promise<void>} put
 * @property {(ref: string | { name: string }, row: Record<string, unknown>) => Promise<void>} set
 * @property {(ref: string | { name: string }, id?: string) => Promise<void>} del
 * @typedef {(ctx: HookContext) => unknown} HookFn
 */

/**
 * Multi-writer database built on Autobee + HyperDB.
 */
export class Database extends ReadyResource {
  /** @param {Partial<DatabaseOpts>} [opts] */
  constructor(opts = {}) {
    super()

    if (!opts.store) throw CeroError.REQUIRED('store')
    if (!opts.identity) throw CeroError.REQUIRED('identity')
    if (!opts.spec || !opts.spec.database || !opts.spec.dispatch) {
      throw CeroError.INVALID('spec must have database + dispatch')
    }
    if (!opts.encryptionKey) throw CeroError.REQUIRED('encryptionKey')
    // a network replicates its own store only: a database in another would never leave the device
    if (opts.network && !opts.network.replicates(opts.store)) {
      throw CeroError.INVALID("store must be the network's store or a session of it")
    }

    /** @type {import('corestore')} */
    this.store = opts.store
    this.identity = opts.identity
    this.network = opts.network || null
    for (const key of this.network?.mirrors || []) {
      if (!recovery.some((k) => b4a.equals(k, key))) recovery.push(key)
    }
    this.spec = opts.spec
    this.meta = opts.spec.meta || { ns: NAMESPACE, refs: {} }
    this.ns = this.meta.ns || NAMESPACE
    this.refs = this.meta.refs || {}
    this.version = this.meta.version || 1
    this.rules = this.meta.rules || 1
    // the version of a database with no version row, and the one this build asks databases to use
    this.start = this.meta.start || 1
    this.target = this.meta.target || this.start
    /** @type {Database | null} */
    this.parent = opts.parent || null
    /** @private */
    this._behind = null
    /** @private */
    this._skipped = null
    /** @private */
    this._applied = false
    /** @private */
    this._landed = false
    /** @private */
    this._rebuilding = null
    /** @private */
    this._writes = new Set()
    this.namespace = opts.namespace || NAMESPACE
    this._writable = false
    this.encryptionKey = opts.encryptionKey
    this.keyring = new Keyring()
    if (opts.epochs) for (const e of opts.epochs) this.keyring.add(e.stamp, e.entropy, e.epoch)
    /** @private */
    this._delivered = !!opts.epochs?.length
    this.rotation = new Rotation(this)
    this.keyring.onmiss = (stamp, writer) => this.rotation.meet(stamp, writer)
    this.key = opts.key || null
    this.pinned = opts.pinned === true
    this.push = opts.push === true
    /** @private */
    this._pushes = pushes(this.refs)
    this.keyPair = opts.keyPair || Identity.randomKeyPair()
    if (b4a.equals(this.keyPair.publicKey, this.identity.device.publicKey)) {
      throw CeroError.INVALID('the device keypair is never a writer — mint one')
    }

    /** @private */
    this._onerror = opts.onerror || ((err) => console.error(err))
    // a join is sealed to the address the encryption key owns: every member opens it, no one else
    /** @private */
    this._room = keyPair(this.encryptionKey)
    this.bee = null
    this.dispatcher = null
    /** @private */
    this._presence = null
    /** @private */
    this._pushing = null
    /** @private */
    this._pushAgain = false
    /** @private */
    this._pushed = -1
    /** @private */
    this._pushRef = null
    /** @private */
    this._onResume = () => {
      if (!this._pushAgain) return
      this._pushAgain = false
      this._push(this._pushRef)
    }
    /** @private */
    this._txChain = null
    /** @private */
    this._held = new Map()

    /** @private */
    this._before = new Map()
    /** @private */
    this._after = new Map()
    /** @private */
    this._hooking = 0
    /** @private */
    this._verbs = verbMap(this.refs)
    /** @private */
    this._touched = new Set()
    /** @private */
    this._seq = 0
    // every watch and changes stream is an 'update' listener
    this.setMaxListeners(0)
    /** @type {Array<[string, unknown]> | null} */
    this.txQueue = null
  }

  /** @returns {Uint8Array | null} discovery key of the underlying bee */
  get discoveryKey() {
    return this.bee?.discoveryKey || null
  }

  /** @returns {Uint8Array | null} where a join is sealed to: the address the encryption key owns */
  get address() {
    return this._room?.publicKey || null
  }

  /** @returns {Uint8Array | null} this device's local writer key */
  get writerKey() {
    return this.bee?.local?.key || null
  }

  /** @returns {number | null} the database's version, or its parent's, while it is past this build's contract */
  get behind() {
    return this._behind ?? this.parent?.behind ?? null
  }

  /** @returns {boolean} whether the bee accepts local writes */
  get writable() {
    return this._writable
  }

  /** @returns {number} number of ops in the local writer */
  get length() {
    return this.bee?.local?.length || 0
  }

  /** @returns {object | null} the materialized HyperDB view */
  get view() {
    return this.bee?.view || null
  }

  /** @private */
  async _open() {
    await this.store.ready()
    if (this.network) await this.network.ready()
    await this._preload()
    this.dispatcher = makeDispatcher({
      spec: this.spec,
      ns: this.ns,
      start: this.start,
      contract: () => this.version,
      onskip: (stamp) => this._skip(stamp),
      build: () => this._build(),
      onerror: this._onerror,
      key: () => this.key,
      onepoch: (row) => this.rotation.learn(row),
      room: () => this._room,
      hooks: (phase, op) => this._hooks(phase, op),
      touch: (name) => this._touched.add(name),
      read: (view, name, query) => this._read(view, name, query)
    })

    const known = !!this.key
    try {
      await this._boot()
      const replayed = await this._replay()
      if (replayed) await this._boot()

      // before replication can deliver blocks at epochs we haven't learned yet
      await this.rotation.hydrate()
      // epochs handed over at join are sealed to nobody this device can read later: keep them
      if (this._delivered) await this.rotation._save()
      this._track(await this.dispatcher.version(this.view))
      await this.rotation.pick()
    } catch (err) {
      // ready-resource runs no _close for an open that failed
      await this._close().catch(safetyCatch)
      throw err
    }

    // REMOVE-capable devices rotate when the epoch drifts from the member set, as it may have
    // while this one was closed, or as a close cut its rotation short; an owner's device raises
    // the version beside it
    this.on('update', () => this.rotation.heal())
    this.rotation.heal()
    this._writable = this.bee.writable
    this._wire()

    // a fresh db has no key until boot mints it
    if (this.network && !known) this._joinSwarm(this.bee, this.bee.discoveryKey)
  }

  /** @private */
  _wire() {
    this.bee.on('writable', () => this._onwritable())
    // falling edge: apps freeze the UI the moment access ends
    this.bee.on('unwritable', () => {
      this._writable = false
      this.emit('unwritable')
    })
    // without a listener autobee escalates apply/view errors to a process crash
    this.bee.on('error', this._onerror)
    // a failed background remap is only a warning: the store reads its old cores until a reopen or a fast-forward
    // tries again
    this.bee.on('warning', this._onerror)
    const bee = this.bee
    this.bee.on('move-to', () => this._onmove(bee))

    // with no mirror to hold the database, every member holds it: any member serves a joiner, offline
    if (this.network && !this.network.mirrors.length) {
      this.bee.on('move-to', () => this._holdRoom().catch(safetyCatch))
      this._holdRoom().catch(safetyCatch)
    }
  }

  /** @private */
  async _close() {
    this.rotation.close()
    this.network?.off('resume', this._onResume)
    if (this._presence) {
      this._presence.remove()
      this._presence = null
    }
    const held = [...this._held.values()]
    this._held.clear()
    for (const { range } of held) range.destroy()
    await Promise.allSettled(held.map(({ core }) => core.close()))
    if (this.bee) {
      await this.bee.close()
      this.bee = null
    }
  }

  /**
   * `true` ranks this database as just touched, `false` takes it out of the swarm until the
   * next update lands in it.
   *
   * @param {boolean} active
   */
  setActive(active) {
    if (!this._presence) return
    if (active) this._presence.touch()
    else this._presence.off()
  }

  /**
   * Register a pre-op hook. It runs at apply on every peer, inside the op's transaction;
   * returning `false` (or throwing) refuses the op everywhere.
   *
   * @param {string} op  A write (`put`, `set`, `del`), or an action's name.
   * @param {HookFn} fn
   * @returns {() => void} disposer
   */
  before(op, fn) {
    return addHook(this._before, op, fn)
  }

  /**
   * Register a post-op hook. It runs at apply on every peer, in the op's transaction, so it
   * may write derived rows through `ctx.put` / `ctx.set` / `ctx.del`. On an action it is what
   * the action does.
   *
   * @param {string} op  A write (`put`, `set`, `del`), or an action's name.
   * @param {HookFn} fn
   * @returns {() => void} disposer
   */
  after(op, fn) {
    return addHook(this._after, op, fn)
  }

  /**
   * Insert (or overwrite by id) a row, stamping `id`/`createdAt`/`updatedAt`: an overwrite keeps
   * the row's `createdAt`, and timestamps the caller passes are ignored.
   *
   * @param {string} name
   * @param {Record<string, unknown>} row
   * @returns {Promise<SingleResult | null>}
   */
  async put(name, row) {
    const ref = this._prepare(name, row)
    if (ref.kind === SINGLE) throw CeroError.INVALID(`${name} is a single: write it with set`)
    const was = row.id ? (await this.get(name, row.id)).data : null
    const stored = stamp({ ...row, id: row.id || genId() }, was?.createdAt)
    checkRequired(name, this.refs[name], stored)
    return this._done(await this._append(stored, `add-${ref.verb}`))
  }

  /**
   * Upsert by merging with the existing row, preserving `createdAt`.
   *
   * @param {string} name
   * @param {Record<string, unknown>} row
   * @param {{ upsert?: boolean }} [opts]
   * @returns {Promise<SingleResult | null>}
   */
  async set(name, row, opts) {
    if (this.txQueue) return this._done(await this._merge(name, row, opts))
    // read, merge and append as one unit: two sets on one row see each other
    return this._done(await this._chain(() => this._merge(name, row, opts)))
  }

  /**
   * Delete by id (collection) or wipe the whole single-row table.
   *
   * @param {string} name
   * @param {string} [id]
   * @returns {Promise<void | null>}
   */
  async del(name, id) {
    this.guard()
    const ref = this.ref(name)
    // singles have no id, the dummy one just satisfies the shared del-by-id encoding
    const payload = ref.kind === SINGLE ? { id: '' } : { id }
    await this.write([[`del-${ref.verb}`, payload]])
  }

  /**
   * Run a declared action: what the `after` hooks on its name do, at apply on every peer.
   *
   * @param {string} op
   * @param {Record<string, unknown>} [data]
   * @returns {Promise<void>}
   */
  async call(op, data = {}) {
    this.guard()
    // an action with nothing to run would write a dead op into the log
    if (this.refs[op]?.kind === ACTION && !this._after.get(op)?.length) {
      throw CeroError.INVALID(`action '${op}' has no after hook`)
    }
    await this.write([[op, data]])
  }

  /**
   * Rotate the encryption epoch: generate a fresh 32-byte secret, seal it to every current
   * member's identity key, and announce it through the log.
   *
   * @returns {Promise<{ epoch: number }>}
   */
  async rotate() {
    // queued in tx() the epoch is unobservable, and a batched rotation blurs the epoch
    if (this.txQueue) throw CeroError.INVALID('rotate() cannot run inside tx()')
    return this.rotation.rotate()
  }

  /**
   * Batch every write made through the transaction handle passed to `fn` into a single
   * autobee append.
   *
   * @template T
   * @param {(tx: Database) => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  async tx(fn) {
    // refuse a fn that ignores the handle, ambient batching silently loses atomicity
    if (typeof fn !== 'function' || fn.length < 1) {
      throw CeroError.INVALID('tx(fn) — fn must accept the transaction handle: tx((tx) => ...)')
    }
    if (this.txQueue) return fn(this)
    // only the commit is chained: a write the callback awaits outside the batch must not queue
    // behind it
    const batch = Object.create(this)
    batch.txQueue = []
    try {
      let result
      try {
        result = await fn(batch)
      } finally {
        batch.spent = true
      }
      if (batch.txQueue.length) await this._chain(() => this.write(batch.txQueue))
      return result
    } catch (err) {
      if (this.closing || this.closed) throw CeroError.CLOSED('Database')
      throw err
    }
  }

  // one after the other, past each other's failures so one does not wedge the rest
  /** @private */
  _chain(fn) {
    const prev = this._txChain || Promise.resolve()
    this._txChain = prev.then(fn, fn)
    return this._txChain
  }

  /**
   * Encode and append dispatch ops. Buffers into the active `tx` queue if one
   * is open.
   *
   * @param {Array<[string, unknown]>} ops
   * @returns {Promise<number | undefined>}  The stamp the last op was appended with; nothing when queued or when nothing changed.
   */
  async write(ops) {
    if (this._frozen(ops)) throw CeroError.BEHIND(this.behind)
    if (this.txQueue) {
      if (this.spent) throw CeroError.INVALID('a write through tx after its fn returned')
      for (const op of ops) this.txQueue.push(op)
      return
    }
    this.guard()
    return removes(ops) ? this.rotation.carry(ops) : this._write(ops)
  }

  // behind, a set merges from a view missing the newer writes and every device takes the stale
  // row: no writes until the update, but leaving, which touches nothing else
  /** @private */
  _frozen(ops) {
    return this.behind !== null && !leaving(ops, this.identity.id)
  }

  // a removal and the rotation it carries are `queued`: every other write waits until both are in
  /** @private */
  async _write(ops, queued = false) {
    // a write goes in on the bee it started on: a rebuild closes it once the write is done
    for (;;) {
      const busy = this._rebuilding || (!queued && this.rotation.carrying)
      if (!busy) break
      await busy
    }
    this.guard()
    const writing = this._commit(ops)
    this._writes.add(writing)
    try {
      return await writing
    } finally {
      this._writes.delete(writing)
    }
  }

  /** @private */
  async _commit(ops) {
    // leaving takes no seat, nor does asking for keys: a reader's own goes in optimistically, apply
    // admits it
    const optimistic = !this.bee.writable && seatless(ops, this.identity.id)
    if (!this.bee.writable && !optimistic) throw CeroError.NOT_WRITABLE('Database')
    // writable flips inside the apply that admits us, before its view flush lands our device row
    await this.bee.updated()
    // the dry run refuses what apply would; a no-op never reaches the log, an action always does
    const action = ops.some(([op]) => this.refs[op]?.kind === ACTION)
    try {
      const { wrapped, changed, stamp } = await this._dryRun(ops)
      if (!changed && !action) return
      // a newer op may have applied while this write awaited
      if (this._frozen(ops)) throw CeroError.BEHIND(this.behind)
      await this.bee.append(wrapped.length === 1 ? wrapped[0] : wrapped, { optimistic })
      const ref = this.push ? this._ref(ops) : null
      if (ref) this._push(ref)
      return stamp
    } catch (err) {
      if (this.closing || this.closed) throw CeroError.CLOSED('Database')
      throw err
    }
  }

  /** @returns {boolean} Whether a push notification is on its way to the mirrors. */
  get pushing() {
    return this._pushing !== null
  }

  // one in flight, then once more at the latest block; one due while the network sleeps goes at resume
  /** @private */
  _push(ref) {
    this._pushRef = ref
    if (!this.network?.mirrors.length || this.closing) return
    if (this._pushing || this.network.suspended) {
      this._pushAgain = true
      return
    }
    this._pushing = this._send().finally(() => {
      this._pushing = null
      if (!this._pushAgain) return
      this._pushAgain = false
      this._push(this._pushRef)
    })
  }

  // the first op on a ref that declares push names the notification; a burst keeps the latest
  /** @private */
  _ref(ops) {
    for (const [op] of ops) {
      const name = this._pushes.get(op.replace(/^(add|set|del)-/, ''))
      if (name) return name
    }
    return null
  }

  // a fresh writer core reaches the mirror a few seconds after its first block: one more try
  /** @private */
  async _send() {
    for (let tries = 0; ; tries++) {
      if (this.closing || !this.bee) return
      if (this.network.suspended) {
        this._pushAgain = true
        return
      }
      const core = this.bee.local
      const index = core.length - 1
      if (index === this._pushed) return
      try {
        await this.network.peering().sendNotification(core, {
          roomKey: this.key,
          index,
          target: this.key,
          extra: b4a.from(this._pushRef)
        })
        this._pushed = index
        return
      } catch (err) {
        safetyCatch(err)
        if (tries) return
        await new Promise((resolve) => setTimeout(resolve, PUSH_RETRY).unref())
      }
    }
  }

  /**
   * Read a row. With no `query`: list all (collection) or fetch the one
   * record (single). With a string id: fetch that specific row.
   *
   * @param {string} name
   * @param {string | Query} [query]
   * @returns {Promise<SingleResult | ListResult>}
   */
  async get(name, query) {
    this.guard()
    // a view being applied again is empty meanwhile: a read waits for it, as a write does
    while (this._rebuilding) await this._rebuilding
    return this._read(this.view, name, query)
  }

  /**
   * Whether a member is out for good, as this device has seen it: `'removed'` by another member, `'left'` on her
   * own, or null while she is a member, never was one, or her going has not reached this device. A member let in
   * again after is a member: null.
   *
   * @param {string} memberId
   * @returns {Promise<'removed' | 'left' | null>}
   */
  async removed(memberId) {
    this.guard()
    if ((await this.get('members', memberId)).data) return null
    const col = `@${this.ns}/${REMOVALS}`
    if (await this.view.get(col, { id: memberId })) return 'removed'
    if (await this.view.get(col, { id: leftId(memberId) })) return 'left'
    return null
  }

  /**
   * What a member's devices told this database of her device keys, 32 bytes each: those removed, and those that
   * stand.
   *
   * @param {string} memberId
   * @returns {Promise<{ removed: Uint8Array[], standing: Uint8Array[] }>}
   */
  async told(memberId) {
    this.guard()
    const row = await this.view.get(`@${this.ns}/${REMOVALS}`, { id: toldId(memberId) })
    return { removed: keysOf(row?.removed), standing: keysOf(row?.standing) }
  }

  /**
   * The keys this database holds as removed, 32 bytes each: a device's own, and a removed member's identity.
   *
   * @returns {Promise<Uint8Array[]>}
   */
  async removals() {
    this.guard()
    const rows = await this.view.find(`@${this.ns}/${REMOVALS}`, {}).toArray()
    return rows.filter((row) => !row.id.includes(':')).map((row) => hid.decode(row.id))
  }

  /**
   * Who removed a member, from the record of her removal: null while none reached this device, and
   * for one who left on her own.
   *
   * @param {string} memberId
   * @returns {Promise<{ by: string | null } | null>}
   */
  async removal(memberId) {
    if ((await this.removed(memberId)) !== 'removed') return null
    const row = await this.view.get(`@${this.ns}/${REMOVALS}`, { id: memberId })
    return { by: row.by ?? null }
  }

  /**
   * Resolves once another device or a mirror holds every block this device wrote.
   *
   * @returns {Promise<void>}
   */
  async held() {
    this.guard()
    const core = this.bee.local
    const length = core.length
    if (core.remoteContiguousLength >= length) return
    await new Promise((resolve, reject) => {
      const check = () => {
        if (this.closing || core.closed) done(CeroError.CLOSED('Database'))
        else if (core.remoteContiguousLength >= length) done(null)
      }
      const done = (err) => {
        core.off('remote-contiguous-length', check)
        core.off('close', check)
        if (err) reject(err)
        else resolve()
      }
      core.on('remote-contiguous-length', check)
      core.on('close', check)
      check()
    })
  }

  // the same read against any view: hooks read the transaction they run in
  /** @private */
  async _read(view, name, query) {
    const ref = this.ref(name)
    const col = this.col(ref)

    if (ref.kind === SINGLE) {
      return { data: await view.findOne(col, {}) }
    }

    if (typeof query === 'string') {
      return { data: await view.get(col, { id: query }) }
    }

    const { path, range, rest, sorted, count = path } = this._plan(name, query)
    const rows = await view.find(path, range).toArray()
    const matched = filter(rows, { ...rest, reverse: undefined, limit: undefined })
    if (!sorted) matched.sort(byIndex)
    if (rest.reverse) matched.reverse()
    const data = rest.limit === undefined ? matched : matched.slice(0, rest.limit)
    return { data, total: await this._total(view, count, range, matched, query), size: data.length }
  }

  /**
   * Live snapshot stream — re-emits the latest `get()` result on every
   * underlying mutation. Destroy the stream to stop watching.
   *
   * @param {string} name
   * @param {Query} [query]
   * @returns {import('streamx').Readable}
   */
  watch(name, query) {
    this.guard()
    return subscribe({
      get: () => this.get(name, query),
      watch: (fn) => this.onUpdate(name, fn)
    })
  }

  /**
   * Delta subscription: batches of `{ prev, next }` row pairs instead of full snapshots.
   *
   * @param {string} name
   * @param {Query} [query]
   * @returns {import('streamx').Readable}
   */
  changes(name, query = {}) {
    this.guard()
    const col = this.col(this.ref(name))
    const { limit, reverse, total, ...rest } = query
    return makeChanges(this, name, col, (row) => filter([row], rest).length > 0)
  }

  /**
   * The rows of a collection that changed since `settle` was last called under `mark`, a name of the
   * caller's, so what follows a collection row by row goes on after a restart where it stopped. With no
   * point to start from, `reset` is true and `changes` holds every row. A caller that takes changes and
   * does not settle starts over at its next call. The point is kept on this device only.
   *
   * @param {string} name
   * @param {string} mark
   * @returns {Promise<{ changes: Array<{ prev: Row | null, next: Row | null }>, reset: boolean, settle: () => Promise<void> }>}
   */
  async since(name, mark) {
    this.guard()
    while (this._rebuilding) await this._rebuilding
    const col = this.col(this.ref(name))
    const at = `cero/since/${mark}`
    const local = this.bee.local
    // taken before any await: a view being applied again would be read half way
    const snap = this.view.snapshot()
    const head = this.view.engine.head()
    try {
      const from = decodePoint(await local.getUserData(at))
      const told = from ? await rows(snap, col, from) : null
      const changes = told ?? (await rows(snap, col, null))
      // what the caller writes from here on is ahead of the point: unsettled, it starts over
      if (changes.length) await local.setUserData(at, null)
      const settle = async () => {
        // another core since, after a view applied again or a writer changed: the next call starts over
        if (this.bee?.local === local) await local.setUserData(at, c.encode(point, head))
      }
      return { changes, reset: told === null, settle }
    } finally {
      await snap.close().catch(safetyCatch)
    }
  }

  /**
   * Provision this device. Its writer core was minted when the database opened and this
   * device is its only author, ever.
   *
   * @param {{ name?: string | null, isMobile?: boolean, recovering?: boolean, timeout?: number }} [opts]
   * @returns {Promise<{ id: Uint8Array, writer: import('../identity/index.js').KeyPair }>}
   */
  async bootstrap({ name, isMobile, recovering = false, timeout = 30000 } = {}) {
    this.guard()
    const ts = Date.now()
    const device = [
      'set-device',
      {
        id: hid.encode(this.writerKey),
        name: name || null,
        isMobile: isMobile === true,
        createdAt: ts,
        updatedAt: ts
      }
    ]
    if (recovering) {
      await this.claim({ timeout })
      // an owner's device raises first, as at genesis; a member's leaves out what the version lacks
      await this._raise()
      const [op, row] = device
      const stamp = await this._stamp(this.view)
      await this.write([[op, this.dispatcher.cut(`@${this.ns}/${op}`, row, stamp)]])
    } else {
      // one batch: a writer is never on the log without its member row, nor the database without
      // the version its build asks for, raised first so the rest is written at it
      const member = {
        id: this.identity.id,
        key: this.writerKey,
        role: 'owner',
        name: name || null,
        createdAt: ts,
        updatedAt: ts
      }
      const writer = this._admission(this.writerKey, ts)
      const upgrade = ['upgrade', { version: this.target }]
      await this.write([upgrade, ['add-writer', writer], ['add-member', member], device])
    }
    return { id: this.writerKey, writer: this.keyPair }
  }

  /**
   * Seat this device's writer where its identity is a member, or was promised to be one: wait
   * for the member row or the promise, append the add-writer the identity signs from this
   * device's own core, and resolve once it writes. A member whose role cannot write takes no
   * seat; a promise made to her is kept all the same, and resolves at this device's row. A claim
   * that left this device nothing is made again once her member row or a promise made to her is
   * new. Rejects `DENIED`, with the reason, once the room shows this writer turned away: its
   * promise withdrawn.
   *
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<void>}
   */
  async claim({ timeout = 30000 } = {}) {
    this.guard()
    if (this.bee.writable) return
    const { role, promised, against } = await this._member(timeout, () => this._standing())
    // seated while it waited: a join that was admitted wrote the seat with the member row
    if (this.bee.writable) return
    if (!promised && !can(role, WRITE)) return
    const stamp = await this._stamp(this.view)
    const op = this.dispatcher.encode(
      `@${this.ns}/add-writer`,
      this._admission(this.writerKey),
      stamp
    )
    // from a core not yet admitted: apply verifies the identity's signature and seats it
    await this.bee.append(wrap(stamp, op), { optimistic: true })
    await this.bee.local.setUserData('cero/claim', against)
    await this.bee.update()
    await this._member(timeout, () => this._kept(role))
  }

  /**
   * Resolve once the bee becomes writable, or reject after `timeout` ms.
   *
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<void>}
   */
  async whenWritable({ timeout = 30000 } = {}) {
    this.guard()
    if (this.writable) return
    return new Promise((resolve, reject) => {
      const done = (err) => {
        clearTimeout(timer)
        this.off('writable', done)
        this.off('close', onclose)
        if (err) reject(err)
        else resolve()
      }
      const onclose = () => done(CeroError.CLOSED('Database'))
      const timer =
        timeout > 0 ? setTimeout(() => done(CeroError.TIMEOUT('whenWritable')), timeout) : null
      this.once('writable', done)
      this.once('close', onclose)
    })
  }

  // the bee flips writable inside the apply that admits this device, before that apply's view
  // flush lands its row: writable here means the row is there to read
  /** @private */
  async _onwritable() {
    try {
      await this.bee.updated()
    } catch {
      return
    }
    if (this._writable || !this.bee.writable || this.closing || this.closed) return
    this._writable = true
    this.emit('writable')
  }

  /**
   * Learn epochs handed over after the open, as a root carries them for a handle. One is kept
   * once its announcement applied here and the secret meets the commitment it carries; one whose
   * announcement has not applied yet waits for it, and is checked then.
   *
   * @param {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} epochs
   * @param {string} [from]  The device that sent them, when one did.
   * @returns {Promise<void>}
   */
  async learn(epochs, from) {
    this.guard()
    const rows = await this.rotation._epochs()
    let added = false
    for (const e of epochs) {
      if (e.entropy?.byteLength !== 32) continue
      const row = rows.find((r) => r.stamp === e.stamp)
      if (!row) this.rotation.keep(e, from)
      if (!row?.commit || this.rotation.held(row)) continue
      if (!b4a.equals(crypto.hash(e.entropy), row.commit)) continue
      this.keyring.add(e.stamp, e.entropy, e.epoch)
      added = true
    }
    if (!added) return
    await this.rotation.pick()
    await this.rotation._save()
  }

  /**
   * @returns {Promise<boolean>} Whether this device asked for keys it lacks and its ask still stands.
   */
  async owed() {
    this.guard()
    return !!(await this.view.get(`@${this.ns}/${ASKS}`, { id: hid.encode(this.writerKey) }))
  }

  /**
   * Remove a peer's writer key from the indexer set.
   *
   * @param {Uint8Array} publicKey
   * @returns {Promise<void>}
   */
  async removeWriter(publicKey) {
    return this._admit('del-writer', publicKey)
  }

  /**
   * Throw if the handle is closing/closed or the bee isn't ready yet.
   *
   * @returns {void}
   */
  guard() {
    if (this._hooking) {
      throw CeroError.INVALID('operators are not available inside a hook, use ctx.put / ctx.get')
    }
    if (this.closing || this.closed) throw CeroError.CLOSED('Database')
    if (!this.bee) throw CeroError.NOT_READY('Database', 'db')
  }

  /**
   * Resolve a table name to its normalized `{ name, kind, verb }` ref.
   *
   * @param {string} name
   * @returns {Ref}
   */
  ref(name) {
    if (typeof name !== 'string' || !name) {
      throw CeroError.INVALID('name must be a non-empty string')
    }
    const ref = this.refs[name]
    if (!ref) throw CeroError.UNKNOWN('ref', name)
    return { name, kind: ref.kind || COLLECTION, verb: ref.verb || name }
  }

  /**
   * Namespaced collection path for a ref.
   *
   * @param {Ref} ref
   * @returns {string}
   */
  col(ref) {
    return `@${this.ns}/${ref.name}`
  }

  // the boot reads post-rotation state through the keyring, primed before the bee exists
  /** @private */
  async _preload() {
    await this._onWriter(async (local) => {
      await loadEpochs(this.keyring, local)
      // read before the bee applies anything: an op applied as it opens adds to it, never over it
      const skipped = await local.getUserData('cero/skipped')
      this._skipped = skipped ? c.decode(c.uint, skipped) : null
      // behind is read from the view: a marker kept on the core says nothing
      if (await local.getUserData('cero/behind')) await local.setUserData('cero/behind', null)
    })
  }

  // this device's writer core on its own, with no bee over it to apply a batch meanwhile
  /** @private */
  async _onWriter(fn) {
    const ns = this.store.namespace(this.namespace)
    const local = ns.get({
      keyPair: this.keyPair,
      manifest: {
        version: this.store.manifestVersion,
        signers: [{ publicKey: this.keyPair.publicKey }]
      },
      active: false
    })
    await local.ready()
    try {
      await fn(local)
    } finally {
      // closing the session closes the core opened through it
      await ns.close()
    }
  }

  /** @private */
  async _boot({ land = true } = {}) {
    const bee = new EpochAutobee(this.store.namespace(this.namespace), this.key, {
      keyPair: this.keyPair,
      encryptionKey: this.encryptionKey,
      keyring: this.keyring,
      optimistic: true,
      fastForward: land ? undefined : false,
      wakeup: this.network?.wakeup || undefined,
      open: (b) => HyperDB.bee2(b, this.spec.database, { autoUpdate: true }),
      isTrusted: this._isTrusted.bind(this),
      apply: this._apply.bind(this),
      update: this._update.bind(this)
    })
    // swarm BEFORE boot so the boot has peers to pull from, not a cold open
    if (this.network && this.key) this._joinSwarm(bee, crypto.discoveryKey(this.key))
    // apply-time hooks (rotation.learn, _skip) must never see this.bee null mid-drain, and a failed open closes it
    this.bee = bee
    await bee.ready()
    this.key = bee.key
    await bee.update()
  }

  // a view another build applied, one with ops skipped this build now reaches among them, fills
  // from the log
  /** @private */
  async _replay() {
    // an empty view names no build: what was skipped and is now reached still has to be applied
    const caught = this._skipped !== null && this._skipped <= this.version
    if (!caught && !(await this._foreign(this.view))) return false
    await this._wipe()
    return true
  }

  // only an admin's or an owner's device hands over a view: anyone else holding the key could serve
  // a forged one that peers adopt without applying it
  /** @private */
  async _isTrusted(writer, view) {
    try {
      const row = await bounded(view.get(`@${this.ns}/devices`, { id: hid.encode(writer) }))
      if (!row) return false
      if (row.v) {
        const member = await bounded(view.get(`@${this.ns}/members`, { id: row.v.memberId }))
        return RANK[member?.v?.role] >= RANK[ADMIN]
      }
      // only a provably empty view trusts the genesis writer: its core is the db key
      const any = await bounded(view.find(`@${this.ns}/devices`, { limit: 1 }).toArray())
      if (!any) return false
      return any.v.length === 0 && !!this.key && b4a.equals(writer, this.key)
    } catch {
      return false
    }
  }

  // unwrap once so the dispatcher sees op bytes and the stamp each was written with
  /** @private */
  async _apply(nodes, view, host) {
    const ready = []
    for (const node of nodes) {
      const op = unwrap(node.value)
      // bytes with no envelope, or a cut one, are no op: skipped and surfaced like any node that does not decode
      if (!op) {
        this._onerror(CeroError.INVALID('an op with no envelope'))
        continue
      }
      // written without the key: a seat that holds none writes nothing
      const plain = this.bee.plain.has(plainId(node.key, node.length - 1))
      if (plain && !this._joins(op.body)) {
        this._onerror(
          CeroError.REFUSED('key', 'a block written without the key carries a join only')
        )
        continue
      }
      ready.push({ ...node, value: op.body, version: op.version })
    }
    this._applied = true
    const { landed, changed } = await this.dispatcher.apply(ready, view, host)
    // a reorder may have dropped the epoch written under
    await this.rotation.pick(view)
    if (landed.length > 0) this._landed = true
    this._notify(landed, changed)
  }

  // 'update' carries the refs the batch touched; '*' means any, so a scoped watcher can skip. A batch
  // that landed or changed nothing wakes nobody: anyone holding the key appends nodes apply refuses.
  // One that landed ranks its database all the same, changed or not: its ops have to reach the others
  /** @private */
  async _update(db) {
    await db.update()
    this._track(await this.dispatcher.version(db))
    const touched = this._touched
    const quiet = this._applied && touched.size === 0
    const landed = this._landed
    this._touched = new Set()
    this._applied = false
    this._landed = false
    if (!quiet) this.emit('update', touched.size === 0 ? new Set(['*']) : touched)
    if (!quiet || landed) this._presence?.touch()
  }

  // every bee a boot opens is attached, but the topic is joined once: close leaves it once
  /** @private */
  _joinSwarm(bee, discoveryKey) {
    this.network.attach(bee)
    if (this.push && !this._presence) this.network.on('resume', this._onResume)
    this._presence ??= this.network.presence.add(discoveryKey, { pinned: this.pinned })
  }

  // every writer the database ever had and every core its views read; only the system bee, an autobee
  // internal, lists all the writers
  /** @private */
  async _holdRoom() {
    const bee = this.bee
    const { views } = await bee.cores({ all: true })
    for (const key of views) this._hold(key)
    for await (const writer of bee.system.list()) this._hold(writer.key, writer.length)
  }

  // a view live, a writer only as far as the database applied it: past that a stranger could grow a
  // core every member pulls. Inactive, so a new connection stays silent: the range only asks peers
  // already replicating the core
  /** @private */
  _hold(key, end = -1) {
    const id = b4a.toHex(key)
    const held = this._held.get(id)
    if (this.closing || (held && (held.end === -1 || end <= held.end))) return
    // another device's writer is held in the bee's wakeup group, as autobee opens its writers: once autobee lets go of
    // it, a block landing on it still wakes the bee. A view stays out, or autobee would take it for a writer, and so
    // does this device's own writer, as autobee keeps it
    const other = end !== -1 && !b4a.equals(key, this.bee.local.key)
    const group = other ? this.bee.wakeupCapability?.discoveryKey || null : null
    const core = held ? held.core : this.store.get({ key, active: false, group })
    held?.range.destroy()
    this._held.set(id, { core, end, range: core.download({ start: 0, end }) })
  }

  // wrapped so an operator called from inside a hook fails instead of appending its own op
  /** @private */
  _hooks(phase, op) {
    const fns = (phase === 'before' ? this._before : this._after).get(op)
    return fns?.length ? fns.map((fn) => this._inHook(fn)) : NO_HOOKS
  }

  /** @private */
  _inHook(fn) {
    return async (ctx) => {
      // only the hook's own synchronous run is inside it: other work interleaves at its awaits
      this._hooking++
      let result
      try {
        result = fn(ctx)
      } finally {
        this._hooking--
      }
      return await result
    }
  }

  // an 'update' listener for one ref; the disposer detaches it
  /** @param {string} name @param {() => void} fn @returns {() => void} */
  onUpdate(name, fn) {
    const tick = (touched) => {
      if (touched.has('*') || touched.has(name)) fn()
    }
    this.on('update', tick)
    return () => this.off('update', tick)
  }

  /** @private */
  _joins(body) {
    try {
      return this.spec.dispatch.decode(body).name === `@${this.ns}/join`
    } catch {
      return false
    }
  }

  // '@cero/set-messages' → { op: 'set', name: 'messages' }; an action has no dash
  /** @private */
  _opOf(node) {
    const { name, value } = this.spec.dispatch.decode(node.value)
    const verb = name.slice(name.indexOf('/') + 1)
    const dash = verb.indexOf('-')
    if (dash < 0) return { op: verb, name: verb, value }
    return { op: verb.slice(0, dash), name: verb.slice(dash + 1), value }
  }

  // emits 'apply' per op, local and replicated alike, and marks the refs of a batch that changed a row
  /** @private */
  _notify(nodes, changed) {
    const listened = this.listenerCount('apply') > 0
    for (const node of nodes) {
      let op
      try {
        op = this._opOf(node)
      } catch (err) {
        if (changed) this._touched.add('*')
        safetyCatch(err)
        continue
      }
      const ref = this._verbs.get(op.name)
      // an action's hooks write wherever they want, widen to all
      if (changed) this._touched.add(ref && this.refs[ref].kind !== ACTION ? ref : '*')
      if (!listened) continue
      this.emit('apply', {
        op: op.op,
        name: op.name,
        row: op.value,
        writerKey: node.key,
        seq: this._seq++
      })
    }
  }

  /** @private */
  async _merge(name, row, { upsert = true } = {}) {
    const ref = this._prepare(name, row)
    const existing = ref.kind === SINGLE || row?.id ? (await this.get(name, row?.id)).data : null
    if (!upsert && !existing) return null
    // a single is one record with no fields of Cero's
    const merged = { ...existing, ...row }
    const stored = ref.kind === SINGLE ? merged : stamp(merged, existing?.createdAt)
    checkRequired(name, this.refs[name], stored)
    if (ref.kind === COLLECTION && !stored.id) stored.id = genId()
    const insert = ref.kind === COLLECTION && upsert && !BESPOKE.has(ref.verb)
    const verb = `${insert ? 'add' : 'set'}-${ref.verb}`
    // a member's rank travels only when the caller names one: this device's view of it may predate a change another
    // device made, which a merged copy would undo or get refused for. An empty rank is no change, and apply keeps
    // the stored one
    if (ref.verb === 'member' && !('role' in row)) {
      await this._append({ ...stored, role: '' }, verb)
      return { row: stored }
    }
    // where a handle stands travels the same way, only when named, and apply keeps the stored one
    if (ref.verb === 'handle' && !('state' in row)) {
      await this._append({ ...stored, state: null }, verb)
      return { row: stored }
    }
    return this._append(stored, verb)
  }

  /** @private */
  _prepare(name, row) {
    this.guard()
    const ref = this.ref(name)
    checkFields(name, this.refs[name], row)
    return ref
  }

  /** @private */
  async _append(stored, verb) {
    await this.write([[verb, stored]])
    return { row: stored }
  }

  /** @private */
  _done(ctx) {
    return ctx ? { data: ctx.row } : null
  }

  // the row this build keeps in the view it applies
  /** @private */
  _build() {
    return [this.spec.database.versions.db, this.rules, this.version, this._skipped ?? 0]
  }

  // a view another build applied: its row is not this build's, or it predates the row
  /** @private */
  async _foreign(view) {
    const built = await this.dispatcher.built(view)
    const own = this._build()
    return built !== null && built.some((n, i) => n !== own[i])
  }

  // a fast-forward landed on a view: one another build applied is applied again here, from the
  // log. Writes wait from the landing on, and a second landing is checked once the first is done
  /** @private */
  _onmove(bee = this.bee) {
    const prev = this._rebuilding
    const next = (async () => {
      await prev
      if (bee !== this.bee || this.closing) return
      if (await this._foreign(bee.view)) await this._rebuild()
    })()
      .catch(this._onerror)
      .finally(() => {
        if (this._rebuilding === next) this._rebuilding = null
      })
    this._rebuilding = next
  }

  // as an open does past skipped ops, with no fast-forward until it closes: one would land on such
  // a view again
  /** @private */
  async _rebuild() {
    // peers announce their writers once, as they connect: the writers of the view it leaves are
    // where the new bee starts looking
    const heads = []
    for await (const { key, length } of this.bee.system.list()) heads.push({ key, length })
    await Promise.allSettled(this._writes)
    await this._wipe()
    if (this.closing) return
    await this._boot({ land: false })
    this.bee.hintWakeup(heads)
    this._wire()
  }

  // the bee closes first: open, a batch it applied meanwhile would store what it applied again
  /** @private */
  async _wipe() {
    await this.bee.close()
    await this._onWriter(async (writer) => {
      await writer.setUserData('autobee/head', null)
      await writer.setUserData('cero/skipped', null)
    })
    this._skipped = null
  }

  // the lowest version skipped: the replay runs once this device reaches it, whoever sent the highest
  /** @private */
  _skip(version) {
    if (this._skipped !== null && version >= this._skipped) return
    this._skipped = version
    this.bee.local.setUserData('cero/skipped', c.encode(c.uint, version)).catch(this._onerror)
  }

  // behind while the version is past this build's contract, as the view says
  /** @private */
  _track(version) {
    const behind = version > this.version ? version : null
    if (behind === this._behind) return
    this._behind = behind
    if (behind !== null) this.emit('behind', behind)
  }

  // an owner's device moves the database to the version its build asks for, a batch of its own
  /** @private */
  async _raise() {
    if (this.closing || this.closed || !this.writable || this.behind !== null) return
    if (this.target <= (await this.dispatcher.version(this.view))) return
    const { data: me } = await this.get('members', this.identity.id)
    if (me?.role !== OWNER) return
    await this.write([['upgrade', { version: this.target }]])
  }

  // a device writes as the version, its own contract while it is behind
  /** @private */
  async _stamp(view) {
    return Math.min(this.version, await this.dispatcher.version(view))
  }

  // every op runs in a throwaway transaction with host effects stubbed; a throwing handler rejects the
  // write. Each is encoded and stamped as of the version it meets, an upgrade earlier in the batch
  // included, as apply will run it
  /** @private */
  async _dryRun(ops) {
    const tx = this.view.transaction()
    const host = {
      addWriter: async () => {},
      removeWriter: async () => {},
      genesis: this.bee.system.isGenesis()
    }
    const wrapped = []
    let stamp = 0
    try {
      for (const [op, payload] of ops) {
        stamp = await this._stamp(tx)
        // closed while it was stamped: Bare ends the process on a hash of no key, where Node throws
        const key = this.writerKey
        if (!key) throw CeroError.CLOSED('Database')
        const value = this.dispatcher.encode(`@${this.ns}/${op}`, payload, stamp)
        await this.dispatcher.dispatch(value, {
          host,
          view: tx,
          key,
          dbKey: this.key,
          seed: crypto.hash([key, value]),
          stamp
        })
        wrapped.push(wrap(stamp, value))
      }
      return { wrapped, changed: tx.updated(), stamp }
    } finally {
      // a failing close must not mask the handler's own rejection
      try {
        await tx.close()
      } catch (err) {
        safetyCatch(err)
      }
    }
  }

  // one hyperdb read per query: index, bounds and window pushed down, the rest filtered in memory
  /** @private */
  _plan(name, query = {}) {
    const ref = this.refs[name]
    const col = `@${this.ns}/${name}`
    const rest = { ...query }
    const eq = Object.keys(query).filter((k) => !QUERY_RESERVED.has(k))
    const bounded = [...RANGE].some((k) => query[k] !== undefined)
    const idx = eq.length ? matchIndex(ref?.indexes, eq) : null
    if (idx) {
      const point = {}
      for (const f of eq) point[f] = query[f]
      const range = { gte: point, lte: point }
      if (!query.search && !bounded) pushWindow(range, rest)
      return { path: `${col}-${idx}`, range, rest, sorted: true }
    }
    if (eq.length || query.search) return { path: col, range: {}, rest, sorted: false }
    // a range on the id reads in id order, so hyperdb serves the window and stops at the page
    if (bounded) {
      const range = {}
      for (const k of RANGE) if (query[k] !== undefined) range[k] = { id: query[k] }
      pushWindow(range, rest)
      return { path: col, range, rest, sorted: true }
    }
    if (ref?.orderIndex) {
      const range = {}
      pushWindow(range, rest)
      // a full read, and a count, scan the collection in about half the time the order index takes to walk
      if (range.limit !== undefined) {
        return { path: `${col}-index`, range, rest, sorted: true, count: col }
      }
      return { path: col, range: {}, rest: { ...rest, reverse: range.reverse }, sorted: false }
    }
    return { path: col, range: {}, rest, sorted: false }
  }

  // matched rows; unknown once a pushed-down limit filled the page
  /** @private */
  async _total(view, path, range, matched, query) {
    if (range.limit === undefined || matched.length < range.limit) return matched.length
    if (!query?.total) return null
    const { limit, reverse, ...bounds } = range
    return (await view.find(path, bounds).toArray()).length
  }

  // what `find` reads of this identity's place, read again on every update and once this device
  // writes, until there is something; its throw ends the wait
  /** @private */
  _member(timeout, find) {
    return new Promise((resolve, reject) => {
      const done = (err, found) => {
        clearTimeout(timer)
        this.off('update', check)
        this.off('writable', check)
        this.off('close', onclose)
        if (err) reject(err)
        else resolve(found)
      }
      const check = () => find().then((found) => found && done(null, found), done)
      const onclose = () => done(CeroError.CLOSED('Database'))
      const timer =
        timeout > 0
          ? setTimeout(() => done(CeroError.TIMEOUT('waiting for the member row')), timeout)
          : null
      this.on('update', check)
      this.on('writable', check)
      this.once('close', onclose)
      check()
    })
  }

  // the member's role, or that of the first promise made to the identity, as apply picks it, and
  // whether this device has a promise to keep
  /** @private */
  async _standing() {
    const { data: member } = await this.get('members', this.identity.id)
    const { data: requests } = await this.get('requests')
    // a core that wrote already, its join or an earlier claim, claims once the view holds what it
    // wrote: appended on a view still catching up with it, a claim is lost. Turned away, it hears.
    // What the view read and kept no row of, a claim refused where it landed, is made again
    const id = hid.encode(this.writerKey)
    const { data: device } = await this.get('devices', id)
    const landed = device || requests.some((row) => row.id === id)
    if (this.length > 0 && !landed) {
      await this._refused()
      const read = await this.bee.system.get(this.writerKey)
      if (!read || read.length < this.length) return null
    }
    const mine = (row) => row.promised && b4a.equals(row.identity, this.identity.publicKey)
    const made = requests.filter(mine)
    const [first] = made
    // a claim that left no row was refused: made again against the same member row and promises,
    // it would be refused again, a block at every launch
    const against = b4a.from(JSON.stringify([member?.role, made.map((row) => row.id)]))
    const claimed = device ? null : await this.bee.local.getUserData('cero/claim')
    if (claimed && b4a.equals(claimed, against)) return null
    // a member's device keeps what it was promised itself, once: its row is the promise kept
    const own = made.some((row) => b4a.equals(row.key, this.identity.device.publicKey))
    if (member) return { role: member.role, promised: own && !device, against }
    return first ? { role: first.role, promised: true, against } : null
  }

  // a claim kept: this device's seat, or its row at a role with none
  /** @private */
  async _kept(role) {
    await this._refused()
    if (can(role, WRITE)) return this.writable
    return (await this.get('devices', hid.encode(this.writerKey))).data
  }

  // a writer has a refusal only where it has no request: its join turned away, or what it was
  // promised withdrawn. One under another invite than the join its core carries answers a join
  // it made before, read while its view has yet to reach this one
  /** @private */
  async _refused() {
    const id = hid.encode(this.writerKey)
    const refusal = await this.view.get(`@${this.ns}/${REFUSALS}`, { id })
    if (!refusal) return
    const joined = refusal.invite && (await this.bee.local.getUserData('cero/join'))
    if (joined && b4a.toHex(joined) !== refusal.invite) return
    throw CeroError.DENIED(refusal.reason || null)
  }

  // the add-writer row for `writer`, appended by this device and proven by its device key
  /** @private */
  _admission(writer, ts = Date.now()) {
    const proof = this.identity.sign(admission(this.key, writer, this.writerKey))
    return { master: this.identity.publicKey, writer, proof, ts }
  }

  /** @private */
  async _admit(verb, publicKey) {
    this.guard()
    if (!b4a.isBuffer(publicKey)) throw CeroError.INVALID('publicKey must be a buffer')
    const writer = Hypercore.key({ version: this.store.manifestVersion, signers: [{ publicKey }] })
    await this.write([[verb, this._admission(writer)]])
  }
}

// an unbounded read of an old checkout wedges autobee's drain; null means untrusted
function bounded(promise, ms = 2000) {
  let timer = null
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
    timer.unref()
  })
  return Promise.race([promise.then((v) => ({ v })), bound]).finally(() => clearTimeout(timer))
}

// a point of a view: its core and how long it was
const point = {
  preencode(state, p) {
    c.fixed32.preencode(state, p.key)
    c.uint.preencode(state, p.length)
  },
  encode(state, p) {
    c.fixed32.encode(state, p.key)
    c.uint.encode(state, p.length)
  },
  decode(state) {
    return { key: c.fixed32.decode(state), length: c.uint.decode(state) }
  }
}

// a kept point, null when there is none or it does not read
function decodePoint(buf) {
  try {
    return buf ? c.decode(point, buf) : null
  } catch {
    return null
  }
}

// the rows of a collection that differ from a point of its view, all of them with none; null when
// the point's blocks do not come, as for one in a view this device never applied
async function rows(snap, col, from) {
  const stream = snap.diff(col, from ? { from } : {})
  const read = async () => {
    const changes = []
    for await (const { left, right } of stream) changes.push({ prev: left, next: right })
    return changes
  }
  if (!from) return read()
  const done = await bounded(read())
  if (!done) stream.destroy()
  return done ? done.v : null
}

const NO_HOOKS = []
const PUSH_RETRY = 5000

// the refs whose writes push, by the verb their ops carry
function pushes(refs) {
  const map = new Map()
  for (const [name, ref] of Object.entries(refs)) if (ref.push) map.set(ref.verb || name, name)
  return map
}

function addHook(map, op, fn) {
  if (typeof fn !== 'function') throw CeroError.INVALID('hook fn must be a function')
  let arr = map.get(op)
  if (!arr) map.set(op, (arr = []))
  arr.push(fn)
  return () => {
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
}

// verb and name both resolve to the ref, ops are named by verb
function verbMap(refs) {
  const map = new Map()
  for (const [name, info] of Object.entries(refs)) {
    map.set(info.verb || name, name)
    map.set(name, name)
  }
  return map
}

function leaving(ops, id) {
  return ops.length === 1 && ops[0][0] === 'del-member' && ops[0][1]?.id === id
}

// what a device without a writer seat may append: its leave, its ask for keys and the close of it
function seatless(ops, id) {
  return leaving(ops, id) || (ops.length === 1 && ['ask-key', 'del-owed'].includes(ops[0][0]))
}

const RANGE = new Set(['gt', 'gte', 'lt', 'lte'])

const byIndex = (a, b) => (a.index ?? 0) - (b.index ?? 0)

// the index whose fields are exactly the query's equality keys, or those and then `index`: that
// one reads the matches in list order
function matchIndex(indexes, fields) {
  for (const [name, keys] of Object.entries(indexes || {})) {
    const eq = keys.at(-1) === 'index' && !fields.includes('index') ? keys.slice(0, -1) : keys
    if (eq.length === fields.length && eq.every((f) => fields.includes(f))) return name
  }
  return null
}

// reverse and limit served by hyperdb, so the in-memory pass must not repeat them
function pushWindow(range, rest) {
  if (rest.reverse === true) range.reverse = true
  if (rest.limit !== undefined) range.limit = rest.limit
  delete rest.reverse
  delete rest.limit
}
