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
  ACTIVE,
  PASSIVE,
  QUERY_RESERVED
} from '../lib/constants.js'
import { genId, subscribe, admission, ownership, filter } from '../lib/utils.js'
import { wrap, unwrap } from './envelope.js'
import { EpochAutobee, Keyring, loadEpochs } from './encryption.js'
import { CeroError } from '../lib/errors.js'
import { Identity } from '../identity/index.js'
import { Rotation } from './rotation.js'
import { makeChanges } from './changes.js'
import { makeDispatcher } from './dispatch.js'

/**
 * @typedef {object} DatabaseOpts
 * @property {any} store                                              Corestore (or compatible) used to materialize the autobee.
 * @property {import('../identity/index.js').Identity} identity       Long-lived member identity used to sign writer changes.
 * @property {import('../network/index.js').Network} [network]        Optional swarm; required for multi-writer replication.
 * @property {{ database: any, dispatch: any, meta?: { ns?: string, refs?: Record<string, { kind?: string, verb?: string }> } }} spec  Generated hyperdb + hyperdispatch spec.
 * @property {Record<string, Function>} [routes]                      Custom action handlers keyed by route name.
 * @property {string} [namespace]                                     Corestore namespace; defaults to `cero`.
 * @property {Uint8Array | null} [encryptionKey]                      Optional encryption key; falls back to identity's key.
 * @property {Array<{ epoch: number, entropy: Uint8Array }> | null} [epochs]  Rotation epochs to prime the keyring with (delivered at join).
 * @property {Uint8Array | null} [key]                                Existing autobee key to reopen.
 * @property {boolean} [passive]                                      Join discovery server-only (reachable but not searching). Flip at runtime with `setActive`.
 * @property {import('../identity/index.js').KeyPair} [keyPair]       This device's writer keypair; a fresh random one by default. Never the identity's, never the database key.
 * @property {(err: Error) => void} [onerror]                         Called when a node is skipped or refused, or the bee errors.
 *
 * Events: `update` (touched refs, a Set, after each applied batch), `apply` (one per applied
 * op: `{ op, name, row, writerKey, seq }`, local and replicated), `writable`, `unwritable`,
 * `behind` (an op from a newer app version was skipped).
 *
 * @typedef {{ data: any | null }} SingleResult
 * @typedef {{ data: any[], total: number | null, size: number }} ListResult  `total` is null when a limited read skipped the full count — pass `{ total: true }` to force it.
 * @typedef {{ gt?: string, gte?: string, lt?: string, lte?: string, reverse?: boolean, limit?: number, search?: string, fields?: string[], total?: boolean }} Query
 * @typedef {{ kind: string, verb: string, name: string }} Ref
 * @typedef {object} HookContext
 * @property {string} op                                One of `put`, `set`, `del`, or an action name.
 * @property {string} name                              The ref the op targets.
 * @property {Record<string, unknown> | null} row       The incoming row; mutate it in `before` to change what lands.
 * @property {Record<string, unknown> | null} existing  The stored row, or null.
 * @property {string | null} id                         The row id for a `del`.
 * @property {string} memberId                          The writer's member id.
 * @property {string} role                              The writer's role.
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

    this.store = opts.store
    this.identity = opts.identity
    this.network = opts.network || null
    this.spec = opts.spec
    this.meta = opts.spec.meta || { ns: NAMESPACE, refs: {} }
    this.ns = this.meta.ns || NAMESPACE
    this.refs = this.meta.refs || {}
    this.version = this.meta.version || 1
    this.behind = null
    this.routes = opts.routes || {}
    this.namespace = opts.namespace || NAMESPACE
    this.encryptionKey = opts.encryptionKey || opts.identity.encryptionKey || null
    this.keyring = new Keyring()
    if (opts.epochs) for (const e of opts.epochs) this.keyring.add(e.stamp, e.entropy, e.epoch)
    this.rotation = new Rotation(this)
    this.key = opts.key || null
    this.passive = opts.passive === true
    this.keyPair = opts.keyPair || Identity.randomKeyPair()
    if (b4a.equals(this.keyPair.publicKey, this.identity.publicKey)) {
      throw CeroError.INVALID('the identity keypair is never a writer — use a device keypair')
    }

    this._onerror = opts.onerror || safetyCatch
    this.bee = null
    this.dispatcher = null
    this._discovery = null
    this._txChain = null

    this._before = new Map()
    this._after = new Map()
    this._hooking = 0
    this._verbs = verbMap(this.refs)
    this._touched = new Set()
    this._seq = 0
    // every watch and changes stream is an 'update' listener
    this.setMaxListeners(0)
    this.txQueue = null
  }

  /** @returns {Uint8Array | null} discovery key of the underlying bee */
  get discoveryKey() {
    return this.bee?.discoveryKey || null
  }

  /** @returns {Uint8Array | null} this device's local writer key */
  get writerKey() {
    return this.bee?.local?.key || null
  }

  /** @returns {boolean} whether the bee accepts local writes */
  get writable() {
    return this.bee?.writable === true
  }

  /** @returns {number} number of ops in the local writer */
  get length() {
    return this.bee?.local?.length || 0
  }

  /** @returns {object | null} the materialized HyperDB view */
  get view() {
    return this.bee?.view || null
  }

  async _open() {
    await this.store.ready()
    if (this.network) await this.network.ready()
    await this._preload()
    this.dispatcher = makeDispatcher({
      spec: this.spec,
      ns: this.ns,
      routes: this.routes,
      onerror: this._onerror,
      key: () => this.key,
      onepoch: (row) => this.rotation.learn(row),
      hooks: (phase, op) => this._hooks(phase, op),
      inHook: (fn) => this._inHook(fn),
      touch: (name) => this._touched.add(name),
      read: (view, name, query) => this._read(view, name, query)
    })

    const known = !!this.key
    await this._boot()
    const replayed = await this._replay()
    if (replayed) await this._boot()

    // before replication can deliver blocks at epochs we haven't learned yet
    await this.rotation.hydrate()

    // REMOVE-capable devices re-key when the epoch drifts from the member set
    this.on('update', () => this.rotation.heal())
    this.bee.on('writable', () => this.emit('writable'))
    // falling edge: apps freeze the UI the moment access ends
    this.bee.on('unwritable', () => this.emit('unwritable'))
    // without a listener autobee escalates apply/view errors to a process crash
    this.bee.on('error', this._onerror)

    // a fresh db has no key until boot mints it
    if (this.network && !known) this._joinSwarm(this.bee, this.bee.discoveryKey)
  }

  async _close() {
    this.rotation.close()
    if (this._discovery) {
      // unannounce in the background, the DHT round-trip would block close for seconds
      this._discovery.destroy().catch(safetyCatch)
      this._discovery = null
    }
    if (this.bee) {
      // detach first, else the closed bee replicates into every new connection
      if (this.network) this.network.detach(this.bee)
      await this.bee.close()
      this.bee = null
    }
  }

  /**
   * Flip announce mode at runtime — passive stays reachable (server) but
   * stops actively looking (client). Cheap; use it to demote idle rooms.
   *
   * @param {boolean} active
   * @returns {Promise<void>}
   */
  async setActive(active) {
    if (!this._discovery) return
    await (active ? this._discovery.activate() : this._discovery.deactivate())
  }

  /**
   * Register a pre-op hook. It runs at apply on every peer, inside the op's transaction;
   * returning `false` (or throwing) refuses the op everywhere.
   *
   * @param {string} op
   * @param {HookFn} fn
   * @returns {() => void} disposer
   */
  before(op, fn) {
    return addHook(this._before, op, fn)
  }

  /**
   * Register a post-op hook. It runs at apply on every peer, in the op's transaction, so it
   * may write derived rows through `ctx.put` / `ctx.set` / `ctx.del`.
   *
   * @param {string} op
   * @param {HookFn} fn
   * @returns {() => void} disposer
   */
  after(op, fn) {
    return addHook(this._after, op, fn)
  }

  /**
   * Insert (or overwrite by id) a row, stamping `id`/`createdAt`/`updatedAt`.
   *
   * @param {string} name
   * @param {Record<string, any>} row
   * @returns {Promise<SingleResult | null>}
   */
  async put(name, row) {
    const ref = this._prepare(name, row)
    const ts = Date.now()
    const stored = { createdAt: ts, updatedAt: ts, ...row, id: row.id || genId() }
    return this._done(await this._append(stored, `add-${ref.verb}`))
  }

  /**
   * Upsert by merging with the existing row, preserving `createdAt`.
   *
   * @param {string} name
   * @param {Record<string, any>} row
   * @param {{ upsert?: boolean }} [opts]
   * @returns {Promise<SingleResult | null>}
   */
  async set(name, row, opts) {
    return this._done(await this.tx((tx) => tx._merge(name, row, opts)))
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
   * Dispatch a custom action route by name.
   *
   * @param {string} op
   * @param {Record<string, any>} [data]
   * @returns {Promise<void>}
   */
  async call(op, data = {}) {
    this.guard()
    // a declared action with no local route applies as a silent no-op (builtins pass)
    if (this.refs[op]?.kind === ACTION && typeof this.routes[op] !== 'function') {
      throw CeroError.INVALID(
        `action '${op}' has no route — pass { routes: { ${op} } } when opening the handle`
      )
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
    // queued in tx() the epoch is unobservable, and a batched rekey blurs the epoch
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
    // outer transactions serialize so their appends land in call order
    const run = async () => {
      const batch = Object.create(this)
      batch.txQueue = []
      try {
        const result = await fn(batch)
        if (batch.txQueue.length) await this.write(batch.txQueue)
        return result
      } catch (err) {
        if (this.closing || this.closed) throw CeroError.CLOSED('Database')
        throw err
      }
    }
    const prev = this._txChain || Promise.resolve()
    // chain past prev's outcome so one failure doesn't wedge later transactions
    this._txChain = prev.then(run, run)
    return this._txChain
  }

  /**
   * Encode and append dispatch ops. Buffers into the active `tx` queue if one
   * is open.
   *
   * @param {Array<[string, any]>} ops
   * @returns {Promise<void>}
   */
  async write(ops) {
    if (this.txQueue) {
      for (const op of ops) this.txQueue.push(op)
      return
    }
    this.guard()
    if (!this.bee.writable) throw CeroError.NOT_WRITABLE('Database')
    const encoded = ops.map(([op, payload]) =>
      this.spec.dispatch.encode(`@${this.ns}/${op}`, payload)
    )
    // the dry run refuses what apply would; a no-op never reaches the log, an action always does
    const action = ops.some(([op]) => this.refs[op]?.kind === ACTION)
    try {
      if (!(await this._dryRun(encoded)) && !action) return
      const wrapped = encoded.map((value) => wrap(this.version, value))
      await this.bee.append(wrapped.length === 1 ? wrapped[0] : wrapped)
    } catch (err) {
      if (this.closing || this.closed) throw CeroError.CLOSED('Database')
      throw err
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
    return this._read(this.view, name, query)
  }

  // the same read against any view: hooks read the transaction they run in
  async _read(view, name, query) {
    const ref = this.ref(name)
    const col = this.col(ref)

    if (ref.kind === SINGLE) {
      return { data: await view.findOne(col, {}) }
    }

    if (typeof query === 'string') {
      return { data: await view.get(col, { id: query }) }
    }

    const { path, range, rest, sorted } = this._plan(name, query)
    const rows = await view.find(path, range).toArray()
    if (!sorted) rows.sort(byIndex)
    const matched = filter(rows, { ...rest, limit: undefined })
    const data = rest.limit === undefined ? matched : matched.slice(0, rest.limit)
    return { data, total: await this._total(view, path, range, matched, query), size: data.length }
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
   * Provision this device. Its writer core was minted when the database opened and this
   * device is its only author, ever.
   *
   * @param {{ name?: string | null, isMobile?: boolean, recovering?: boolean, timeout?: number }} [opts]
   * @returns {Promise<{ id: Uint8Array, writer: import('../identity/index.js').KeyPair }>}
   */
  async bootstrap({ name, isMobile, recovering = false, timeout = 30000 } = {}) {
    this.guard()
    const ts = Date.now()
    const writer = this._admission(this.writerKey, ts)
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
      await this._backfilled(timeout)
      await this._optimistic(this.spec.dispatch.encode(`@${this.ns}/add-writer`, writer), {
        timeout
      })
      await this.write([device])
    } else {
      // one batch: a writer is never on the log without its member row
      const member = {
        id: this.identity.id,
        key: this.writerKey,
        role: 'owner',
        name: name || null,
        createdAt: ts,
        updatedAt: ts
      }
      await this.write([['add-writer', writer], ['add-member', member], device])
    }
    return { id: this.writerKey, writer: this.keyPair }
  }

  /**
   * Claim writership on an existing room by signing our writer key with the member identity;
   * the claim rides in the device core as an optimistic node.
   *
   * @returns {Promise<void>}
   */
  async claim() {
    this.guard()
    if (this.bee.writable) return
    const writer = this.writerKey
    const op = this.spec.dispatch.encode(`@${this.ns}/claim-writer`, {
      identity: this.identity.publicKey,
      writer,
      sig: this.identity.sign(ownership(this.key, writer)),
      ts: Date.now()
    })
    await this._optimistic(op)
  }

  /**
   * Resolve once the bee becomes writable, or reject after `timeout` ms.
   *
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<void>}
   */
  async whenWritable({ timeout = 30000 } = {}) {
    this.guard()
    const { bee } = this
    if (bee.writable) return
    return new Promise((resolve, reject) => {
      const done = (err) => {
        clearTimeout(timer)
        bee.off('writable', done)
        this.off('close', onclose)
        if (err) reject(err)
        else resolve()
      }
      const onclose = () => done(CeroError.CLOSED('Database'))
      const timer =
        timeout > 0 ? setTimeout(() => done(CeroError.TIMED_OUT('whenWritable')), timeout) : null
      bee.once('writable', done)
      this.once('close', onclose)
    })
  }

  /**
   * Admit a device as a writer for `memberId`, an existing member. Omit it to
   * admit another device of this identity.
   *
   * @param {Uint8Array} publicKey
   * @param {string} [memberId]
   * @returns {Promise<void>}
   */
  async addWriter(publicKey, memberId) {
    return this._admit('add-writer', publicKey, memberId)
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
  async _preload() {
    const local = this.store.namespace(this.namespace).get({
      keyPair: this.keyPair,
      manifest: {
        version: this.store.manifestVersion,
        signers: [{ publicKey: this.keyPair.publicKey }]
      },
      active: false
    })
    await local.ready()
    await loadEpochs(this.keyring, local)
    await local.close()
  }

  async _boot() {
    const bee = new EpochAutobee(this.store.namespace(this.namespace), this.key, {
      keyPair: this.keyPair,
      encryptionKey: this.encryptionKey,
      keyring: this.keyring,
      optimistic: true,
      wakeup: this.network?.wakeup || undefined,
      open: (b) => HyperDB.bee2(b, this.spec.database, { autoUpdate: true }),
      isTrusted: this._isTrusted.bind(this),
      apply: this._apply.bind(this),
      update: this._update.bind(this)
    })
    // swarm BEFORE boot so the boot has peers to pull from, not a cold open
    if (this.network && this.key) this._joinSwarm(bee, crypto.discoveryKey(this.key))
    await bee.ready()
    // apply-time hooks (rotation.learn, _onfuture) must never see this.bee null mid-drain
    this.bee = bee
    this.key = bee.key
    await bee.update()
  }

  // ops skipped as too new apply once this version caught up: wipe the boot record and reboot
  async _replay() {
    const behind = await this.bee.local.getUserData('cero/behind')
    this.behind = behind ? c.decode(c.uint, behind) : null
    if (this.behind === null || this.behind > this.version) return false
    await this.bee.local.setUserData('autobee/head', null)
    await this.bee.local.setUserData('cero/behind', null)
    await this.bee.close()
    this.behind = null
    return true
  }

  // without this hook autobee trusts every fast-forward candidate, a removed device's fork included
  async _isTrusted(writer, view) {
    try {
      const row = await bounded(view.get(`@${this.ns}/devices`, { id: hid.encode(writer) }))
      if (!row) return false
      if (row.v) return true
      // only a provably empty view lets the genesis writer vouch: its core is the db key
      const any = await bounded(view.find(`@${this.ns}/devices`, { limit: 1 }).toArray())
      if (!any) return false
      return any.v.length === 0 && !!this.key && b4a.equals(writer, this.key)
    } catch {
      return false
    }
  }

  // unwrap once so the dispatcher sees op bytes. Skipping a newer version is deterministic
  async _apply(nodes, view, host) {
    const ready = []
    for (const node of nodes) {
      const { version, body } = unwrap(node.value)
      if (version > this.version) {
        this._onfuture(version)
        continue
      }
      ready.push(version === 0 ? node : { ...node, value: body })
    }
    const result = await this.dispatcher.apply(ready, view, host)
    this._notify(ready)
    return result
  }

  // 'update' carries the refs the batch touched; '*' means any, so a scoped watcher can skip
  async _update(db) {
    await db.update()
    const touched = this._touched
    this._touched = new Set()
    this.emit('update', touched.size === 0 ? new Set(['*']) : touched)
  }

  // a writer swap re-opens the bee on the SAME topic, join first so destroy is a detach
  _joinSwarm(bee, discoveryKey) {
    this.network.attach(bee)
    const prev = this._discovery
    this._discovery = this.network.join(discoveryKey, {
      mode: this.passive ? PASSIVE : ACTIVE
    })
    if (prev) prev.destroy().catch(safetyCatch)
  }

  // wrapped so an operator called from inside a hook fails instead of appending its own op
  _hooks(phase, op) {
    const fns = (phase === 'before' ? this._before : this._after).get(op)
    return fns?.length ? fns.map((fn) => this._inHook(fn)) : NO_HOOKS
  }

  _inHook(fn) {
    return async (ctx) => {
      this._hooking++
      try {
        return await fn(ctx)
      } finally {
        this._hooking--
      }
    }
  }

  // an 'update' listener for one ref; the disposer detaches it
  onUpdate(name, fn) {
    const tick = (touched) => {
      if (touched.has('*') || touched.has(name)) fn()
    }
    this.on('update', tick)
    return () => this.off('update', tick)
  }

  // '@cero/set-messages' → { op: 'set', name: 'messages' }; an action has no dash
  _opOf(node) {
    const { name, value } = this.spec.dispatch.decode(node.value)
    const verb = name.slice(name.indexOf('/') + 1)
    const dash = verb.indexOf('-')
    if (dash < 0) return { op: verb, name: verb, value }
    return { op: verb.slice(0, dash), name: verb.slice(dash + 1), value }
  }

  // marks the refs a batch touched and emits 'apply' per op, local and replicated alike
  _notify(nodes) {
    const listened = this.listenerCount('apply') > 0
    for (const node of nodes) {
      let op
      try {
        op = this._opOf(node)
      } catch (err) {
        this._touched.add('*')
        safetyCatch(err)
        continue
      }
      const ref = this._verbs.get(op.name)
      // an action's route handler writes wherever it wants, widen to all
      this._touched.add(ref && this.refs[ref].kind !== ACTION ? ref : '*')
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

  async _merge(name, row, { upsert = true } = {}) {
    const ref = this._prepare(name, row)
    const existing = ref.kind === SINGLE || row?.id ? (await this.get(name, row?.id)).data : null
    if (!upsert && !existing) return null
    const ts = Date.now()
    const stored = { ...existing, ...row, createdAt: existing?.createdAt ?? ts, updatedAt: ts }
    if (ref.kind === COLLECTION && !stored.id) stored.id = genId()
    const insert = ref.kind === COLLECTION && upsert && !BESPOKE.has(ref.verb)
    return this._append(stored, `${insert ? 'add' : 'set'}-${ref.verb}`)
  }

  _prepare(name, row) {
    this.guard()
    const ref = this.ref(name)
    this._checkFields(name, row)
    return ref
  }

  async _append(stored, verb) {
    await this.write([[verb, stored]])
    return { row: stored }
  }

  _done(ctx) {
    return ctx ? { data: ctx.row } : null
  }

  // ops from a newer app version: emit behind once per version, the marker survives restarts
  _onfuture(version) {
    if (this.behind !== null && version <= this.behind) return
    this.behind = version
    this.bee.local.setUserData('cero/behind', c.encode(c.uint, version)).catch(this._onerror)
    this.emit('behind', version)
  }

  // every op runs in a throwaway transaction with host effects stubbed; a throwing handler rejects the write
  async _dryRun(encoded) {
    const tx = this.view.transaction()
    const host = { addWriter: async () => {}, removeWriter: async () => {} }
    try {
      for (const value of encoded) {
        await this.dispatcher.dispatch(value, {
          host,
          view: tx,
          key: this.writerKey,
          dbKey: this.key,
          seed: crypto.hash([this.writerKey, value]),
          dryRun: true
        })
      }
      return tx.updated()
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
    if (bounded) {
      const range = {}
      for (const k of RANGE) if (query[k] !== undefined) range[k] = { id: query[k] }
      return { path: col, range, rest, sorted: false }
    }
    if (ref?.orderIndex) {
      const range = {}
      pushWindow(range, rest)
      return { path: `${col}-index`, range, rest, sorted: true }
    }
    return { path: col, range: {}, rest, sorted: false }
  }

  // matched rows; unknown once a pushed-down limit filled the page
  async _total(view, path, range, matched, query) {
    if (range.limit === undefined || matched.length < range.limit) return matched.length
    if (!query?.total) return null
    const { limit, reverse, ...bounds } = range
    return (await view.find(path, bounds).toArray()).length
  }

  // an append by a core not yet admitted: apply verifies the signature and admits it
  async _optimistic(op, opts) {
    await this.bee.append(wrap(this.version, op), { optimistic: true })
    await this.bee.update()
    if (!this.bee.writable) await this.whenWritable(opts)
  }

  // the genesis device row is the first write of every database, so any device row means backfilled
  async _backfilled(timeout) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (this.closing || this.closed) throw CeroError.CLOSED('Database')
      if ((await this.get('devices')).data.length > 0) return
      await this.bee.update()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw CeroError.TIMED_OUT('recovery — no peer replicated')
  }

  // the add-writer row for `writer`, appended by this device and signed by the identity
  _admission(writer, ts = Date.now()) {
    const sig = this.identity.sign(admission(this.key, writer, this.writerKey))
    return { master: this.identity.publicKey, writer, sig, ts }
  }

  // the encoder silently drops an undeclared field, so the returned row would lie
  _checkFields(name, row) {
    const declared = this.refs[name]?.fields
    if (!declared || !row) return
    for (const key of Object.keys(row)) {
      if (declared.includes(key) || SYSTEM_FIELDS.has(key)) continue
      throw CeroError.INVALID(
        `unknown field '${key}' on '${name}' — declared: ${declared.join(', ') || '(none)'}`
      )
    }
  }

  async _admit(verb, publicKey, memberId) {
    this.guard()
    if (!b4a.isBuffer(publicKey)) throw CeroError.INVALID('publicKey must be a buffer')
    const writer = Hypercore.key({ version: this.store.manifestVersion, signers: [{ publicKey }] })
    await this.write([[verb, { ...this._admission(writer), memberId }]])
  }
}

// an unbounded read of an old checkout wedges autobee's drain; null means untrusted
function bounded(promise, ms = 2000) {
  return Promise.race([
    promise.then((v) => ({ v })),
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ])
}

const NO_HOOKS = []

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

// member and device have their own set handlers, every other collection upserts via add-
const BESPOKE = new Set(['member', 'device'])

// fields the write path stamps itself, always allowed
const SYSTEM_FIELDS = new Set(['id', 'memberId', 'index', 'createdAt', 'updatedAt'])

const RANGE = new Set(['gt', 'gte', 'lt', 'lte'])

const byIndex = (a, b) => (a.index ?? 0) - (b.index ?? 0)

// the index whose fields are exactly the query's equality keys
function matchIndex(indexes, fields) {
  for (const [name, keys] of Object.entries(indexes || {})) {
    if (keys.length === fields.length && keys.every((f) => fields.includes(f))) return name
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
