import ReadyResource from 'ready-resource';
import { EpochAutobee, Keyring } from './encryption.js';
import { Identity } from '../identity/index.js';
import { Rotation } from './rotation.js';
export type DatabaseOpts = {
    /**
     * Corestore (or compatible) used to materialize the autobee.
     */
    store: any;
    /**
     * Long-lived member identity used to sign writer changes.
     */
    identity: import('../identity/index.js').Identity;
    /**
     * Optional swarm; required for multi-writer replication.
     */
    network?: import('../network/index.js').Network;
    /**
     * Generated hyperdb + hyperdispatch spec.
     */
    spec: {
        database: any;
        dispatch: any;
        meta?: {
            ns?: string;
            refs?: Record<string, {
                kind?: string;
                verb?: string;
            }>;
        };
    };
    /**
     * Custom action handlers keyed by route name.
     */
    routes?: Record<string, Function>;
    /**
     * Corestore namespace; defaults to `cero`.
     */
    namespace?: string;
    /**
     * Optional encryption key; falls back to identity's key.
     */
    encryptionKey?: Uint8Array | null;
    /**
     * Rotation epochs to prime the keyring with (delivered at join).
     */
    epochs?: Array<{
        epoch: number;
        entropy: Uint8Array;
    }> | null;
    /**
     * Existing autobee key to reopen.
     */
    key?: Uint8Array | null;
    /**
     * Always search and announce, outside the network's presence budget. The root.
     */
    pinned?: boolean;
    /**
     * This device's writer keypair; a fresh random one by default. Never the identity's, never the database key.
     */
    keyPair?: import('../identity/index.js').KeyPair;
    /**
     * Called when a node is skipped or refused, or the bee errors.
     *
     * Events: `update` (touched refs, a Set, after each applied batch), `apply` (one per applied
     * op: `{ op, name, row, writerKey, seq }`, local and replicated), `writable`, `unwritable`,
     * `behind` (an op from a newer app version was skipped).
     */
    onerror?: (err: Error) => void;
};
export type SingleResult = {
    data: any | null;
};
export type ListResult = {
    data: any[];
    total: number | null;
    size: number;
};
export type Query = {
    gt?: string;
    gte?: string;
    lt?: string;
    lte?: string;
    reverse?: boolean;
    limit?: number;
    search?: string;
    fields?: string[];
    total?: boolean;
};
export type Ref = {
    kind: string;
    verb: string;
    name: string;
};
export type HookContext = {
    /**
     * One of `put`, `set`, `del`, or an action name.
     */
    op: string;
    /**
     * The ref the op targets.
     */
    name: string;
    /**
     * The incoming row; mutate it in `before` to change what lands.
     */
    row: Record<string, unknown> | null;
    /**
     * The stored row, or null.
     */
    existing: Record<string, unknown> | null;
    /**
     * The row id for a `del`.
     */
    id: string | null;
    /**
     * The writer's member id.
     */
    memberId: string;
    /**
     * The writer's role.
     */
    role: string;
    get: (ref: string | {
        name: string;
    }, query?: string | Record<string, unknown>) => Promise<{
        data: unknown;
    }>;
    put: (ref: string | {
        name: string;
    }, row: Record<string, unknown>) => Promise<void>;
    set: (ref: string | {
        name: string;
    }, row: Record<string, unknown>) => Promise<void>;
    del: (ref: string | {
        name: string;
    }, id?: string) => Promise<void>;
};
export type HookFn = (ctx: HookContext) => unknown;
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
 * @property {boolean} [pinned]                                       Always search and announce, outside the network's presence budget. The root.
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
export declare class Database extends ReadyResource {
    store: any;
    identity: Identity;
    network: import("../index.js").Network;
    spec: {
        database: any;
        dispatch: any;
        meta?: {
            ns?: string;
            refs?: Record<string, {
                kind?: string;
                verb?: string;
            }>;
        };
    };
    meta: {
        ns?: string;
        refs?: Record<string, {
            kind?: string;
            verb?: string;
        }>;
    };
    ns: string;
    refs: Record<string, {
        kind?: string;
        verb?: string;
    }>;
    version: any;
    behind: any;
    routes: Record<string, Function>;
    namespace: string;
    encryptionKey: Uint8Array<ArrayBufferLike>;
    keyring: Keyring;
    rotation: Rotation;
    key: Uint8Array<ArrayBufferLike>;
    pinned: boolean;
    keyPair: import("../index.js").KeyPair;
    _onerror: any;
    bee: EpochAutobee;
    dispatcher: {
        dispatch: (value: Buffer, ctx: object) => Promise<void>;
        apply: (nodes: Array<{
            value: Buffer;
            key: Buffer;
        }>, view: object, host: object) => Promise<void>;
    };
    _presence: import("../network/presence.js").Slot;
    _txChain: any;
    _before: Map<any, any>;
    _after: Map<any, any>;
    _hooking: number;
    _verbs: Map<any, any>;
    _touched: Set<any>;
    _seq: number;
    txQueue: any;
    /** @param {Partial<DatabaseOpts>} [opts] */
    constructor(opts?: Partial<DatabaseOpts>);
    /** @returns {Uint8Array | null} discovery key of the underlying bee */
    get discoveryKey(): Uint8Array | null;
    /** @returns {Uint8Array | null} this device's local writer key */
    get writerKey(): Uint8Array | null;
    /** @returns {boolean} whether the bee accepts local writes */
    get writable(): boolean;
    /** @returns {number} number of ops in the local writer */
    get length(): number;
    /** @returns {object | null} the materialized HyperDB view */
    get view(): object | null;
    _open(): Promise<void>;
    _close(): Promise<void>;
    /**
     * `true` ranks this database as just touched, `false` takes it out of the swarm until the
     * next update lands in it.
     *
     * @param {boolean} active
     */
    setActive(active: boolean): void;
    /**
     * Register a pre-op hook. It runs at apply on every peer, inside the op's transaction;
     * returning `false` (or throwing) refuses the op everywhere.
     *
     * @param {string} op
     * @param {HookFn} fn
     * @returns {() => void} disposer
     */
    before(op: string, fn: HookFn): () => void;
    /**
     * Register a post-op hook. It runs at apply on every peer, in the op's transaction, so it
     * may write derived rows through `ctx.put` / `ctx.set` / `ctx.del`.
     *
     * @param {string} op
     * @param {HookFn} fn
     * @returns {() => void} disposer
     */
    after(op: string, fn: HookFn): () => void;
    /**
     * Insert (or overwrite by id) a row, stamping `id`/`createdAt`/`updatedAt`.
     *
     * @param {string} name
     * @param {Record<string, any>} row
     * @returns {Promise<SingleResult | null>}
     */
    put(name: string, row: Record<string, any>): Promise<SingleResult | null>;
    /**
     * Upsert by merging with the existing row, preserving `createdAt`.
     *
     * @param {string} name
     * @param {Record<string, any>} row
     * @param {{ upsert?: boolean }} [opts]
     * @returns {Promise<SingleResult | null>}
     */
    set(name: string, row: Record<string, any>, opts?: {
        upsert?: boolean;
    }): Promise<SingleResult | null>;
    /**
     * Delete by id (collection) or wipe the whole single-row table.
     *
     * @param {string} name
     * @param {string} [id]
     * @returns {Promise<void | null>}
     */
    del(name: string, id?: string): Promise<void | null>;
    /**
     * Dispatch a custom action route by name.
     *
     * @param {string} op
     * @param {Record<string, any>} [data]
     * @returns {Promise<void>}
     */
    call(op: string, data?: Record<string, any>): Promise<void>;
    /**
     * Rotate the encryption epoch: generate a fresh 32-byte secret, seal it to every current
     * member's identity key, and announce it through the log.
     *
     * @returns {Promise<{ epoch: number }>}
     */
    rotate(): Promise<{
        epoch: number;
    }>;
    /**
     * Batch every write made through the transaction handle passed to `fn` into a single
     * autobee append.
     *
     * @template T
     * @param {(tx: Database) => Promise<T> | T} fn
     * @returns {Promise<T>}
     */
    tx<T>(fn: (tx: Database) => Promise<T> | T): Promise<T>;
    /**
     * Encode and append dispatch ops. Buffers into the active `tx` queue if one
     * is open.
     *
     * @param {Array<[string, any]>} ops
     * @returns {Promise<void>}
     */
    write(ops: Array<[string, any]>): Promise<void>;
    /**
     * Read a row. With no `query`: list all (collection) or fetch the one
     * record (single). With a string id: fetch that specific row.
     *
     * @param {string} name
     * @param {string | Query} [query]
     * @returns {Promise<SingleResult | ListResult>}
     */
    get(name: string, query?: string | Query): Promise<SingleResult | ListResult>;
    _read(view: any, name: any, query: any): Promise<{
        data: any;
        total?: undefined;
        size?: undefined;
    } | {
        data: any[];
        total: any;
        size: number;
    }>;
    /**
     * Live snapshot stream — re-emits the latest `get()` result on every
     * underlying mutation. Destroy the stream to stop watching.
     *
     * @param {string} name
     * @param {Query} [query]
     * @returns {import('streamx').Readable}
     */
    watch(name: string, query?: Query): import('streamx').Readable;
    /**
     * Delta subscription: batches of `{ prev, next }` row pairs instead of full snapshots.
     *
     * @param {string} name
     * @param {Query} [query]
     * @returns {import('streamx').Readable}
     */
    changes(name: string, query?: Query): import('streamx').Readable;
    /**
     * Provision this device. Its writer core was minted when the database opened and this
     * device is its only author, ever.
     *
     * @param {{ name?: string | null, isMobile?: boolean, recovering?: boolean, timeout?: number }} [opts]
     * @returns {Promise<{ id: Uint8Array, writer: import('../identity/index.js').KeyPair }>}
     */
    bootstrap({ name, isMobile, recovering, timeout }?: {
        name?: string | null;
        isMobile?: boolean;
        recovering?: boolean;
        timeout?: number;
    }): Promise<{
        id: Uint8Array;
        writer: import('../identity/index.js').KeyPair;
    }>;
    /**
     * Claim writership on an existing room by signing our writer key with the member identity;
     * the claim rides in the device core as an optimistic node.
     *
     * @returns {Promise<void>}
     */
    claim(): Promise<void>;
    /**
     * Resolve once the bee becomes writable, or reject after `timeout` ms.
     *
     * @param {{ timeout?: number }} [opts]
     * @returns {Promise<void>}
     */
    whenWritable({ timeout }?: {
        timeout?: number;
    }): Promise<void>;
    /**
     * Admit a device as a writer for `memberId`, an existing member. Omit it to
     * admit another device of this identity.
     *
     * @param {Uint8Array} publicKey
     * @param {string} [memberId]
     * @returns {Promise<void>}
     */
    addWriter(publicKey: Uint8Array, memberId?: string): Promise<void>;
    /**
     * Remove a peer's writer key from the indexer set.
     *
     * @param {Uint8Array} publicKey
     * @returns {Promise<void>}
     */
    removeWriter(publicKey: Uint8Array): Promise<void>;
    /**
     * Throw if the handle is closing/closed or the bee isn't ready yet.
     *
     * @returns {void}
     */
    guard(): void;
    /**
     * Resolve a table name to its normalized `{ name, kind, verb }` ref.
     *
     * @param {string} name
     * @returns {Ref}
     */
    ref(name: string): Ref;
    /**
     * Namespaced collection path for a ref.
     *
     * @param {Ref} ref
     * @returns {string}
     */
    col(ref: Ref): string;
    _preload(): Promise<void>;
    _boot(): Promise<void>;
    _replay(): Promise<boolean>;
    _isTrusted(writer: any, view: any): Promise<any>;
    _apply(nodes: any, view: any, host: any): Promise<void>;
    _update(db: any): Promise<void>;
    _joinSwarm(bee: any, discoveryKey: any): void;
    _hooks(phase: any, op: any): any;
    _inHook(fn: any): (ctx: any) => Promise<any>;
    onUpdate(name: any, fn: any): () => this;
    _opOf(node: any): {
        op: any;
        name: any;
        value: any;
    };
    _notify(nodes: any): void;
    _merge(name: any, row: any, { upsert }?: {
        upsert?: boolean;
    }): Promise<{
        row: any;
    }>;
    _prepare(name: any, row: any): Ref;
    _append(stored: any, verb: any): Promise<{
        row: any;
    }>;
    _done(ctx: any): {
        data: any;
    };
    _onfuture(version: any): void;
    _dryRun(encoded: any): Promise<any>;
    _plan(name: any, query?: {}): {
        path: string;
        range: {
            gte: {};
            lte: {};
        };
        rest: {};
        sorted: boolean;
    } | {
        path: string;
        range: {};
        rest: {};
        sorted: boolean;
    };
    _total(view: any, path: any, range: any, matched: any, query: any): Promise<any>;
    _optimistic(op: any, opts: any): Promise<void>;
    _backfilled(timeout: any): Promise<void>;
    _admission(writer: any, ts?: number): {
        master: Uint8Array<ArrayBufferLike>;
        writer: any;
        sig: Uint8Array<ArrayBufferLike>;
        ts: number;
    };
    _checkFields(name: any, row: any): void;
    _admit(verb: any, publicKey: any, memberId: any): Promise<void>;
}
