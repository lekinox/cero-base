import ReadyResource from 'ready-resource';
import { EpochAutobee, Keyring } from './encryption.js';
import { Identity } from '../identity/index.js';
import { Rotation } from './rotation.js';
export type DatabaseOpts = {
    /**
     * Corestore (or compatible) used to materialize the autobee.
     */
    store: import('corestore');
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
        database: object;
        dispatch: {
            Router: new () => object;
            encode: (name: string, value: unknown) => Uint8Array;
            decode: (buf: Uint8Array) => {
                name: string;
                value: unknown;
            };
        };
        meta?: {
            ns?: string;
            version?: number;
            refs?: Record<string, {
                kind?: string;
                verb?: string;
            }>;
        };
    };
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
export type Row = Record<string, unknown>;
export type SingleResult = {
    data: Row | null;
};
export type ListResult = {
    data: Row[];
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
     * The writer's member id, null for a core no member owns yet (a join, a claim, genesis).
     */
    memberId: string | null;
    /**
     * The writer's role, null likewise.
     */
    role: string | null;
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
 * @property {import('corestore')} store                              Corestore (or compatible) used to materialize the autobee.
 * @property {import('../identity/index.js').Identity} identity       Long-lived member identity used to sign writer changes.
 * @property {import('../network/index.js').Network} [network]        Optional swarm; required for multi-writer replication.
 * @property {{ database: object, dispatch: { Router: new () => object, encode: (name: string, value: unknown) => Uint8Array, decode: (buf: Uint8Array) => { name: string, value: unknown } }, meta?: { ns?: string, version?: number, refs?: Record<string, { kind?: string, verb?: string }> } }} spec  Generated hyperdb + hyperdispatch spec.
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
    /** @type {import('corestore')} */
    store: import('corestore');
    identity: Identity;
    network: import("../index.js").Network;
    spec: {
        database: object;
        dispatch: {
            Router: new () => object;
            encode: (name: string, value: unknown) => Uint8Array;
            decode: (buf: Uint8Array) => {
                name: string;
                value: unknown;
            };
        };
        meta?: {
            ns?: string;
            version?: number;
            refs?: Record<string, {
                kind?: string;
                verb?: string;
            }>;
        };
    };
    meta: {
        ns?: string;
        version?: number;
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
    version: number;
    /** @type {number | null} */
    behind: number | null;
    namespace: string;
    encryptionKey: Uint8Array<ArrayBufferLike>;
    keyring: Keyring;
    rotation: Rotation;
    key: Uint8Array<ArrayBufferLike>;
    pinned: boolean;
    keyPair: import("../index.js").KeyPair;
    /** @private */
    _onerror;
    /** @private */
    _room;
    bee: EpochAutobee;
    dispatcher: {
        dispatch: (value: Buffer, ctx: object) => Promise<void>;
        apply: (nodes: Array<{
            value: Buffer;
            key: Buffer;
        }>, view: object, host: object) => Promise<void>;
    };
    /** @private */
    _presence;
    /** @private */
    _txChain;
    /** @private */
    _held;
    /** @private */
    _before;
    /** @private */
    _after;
    /** @private */
    _hooking;
    /** @private */
    _verbs;
    /** @private */
    _touched;
    /** @private */
    _seq;
    /** @type {Array<[string, unknown]> | null} */
    txQueue: Array<[string, unknown]> | null;
    /** @param {Partial<DatabaseOpts>} [opts] */
    constructor(opts?: Partial<DatabaseOpts>);
    /** @returns {Uint8Array | null} discovery key of the underlying bee */
    get discoveryKey(): Uint8Array | null;
    /** @returns {Uint8Array | null} where a join is sealed to: the address the encryption key owns */
    get address(): Uint8Array | null;
    /** @returns {Uint8Array | null} this device's local writer key */
    get writerKey(): Uint8Array | null;
    /** @returns {boolean} whether the bee accepts local writes */
    get writable(): boolean;
    /** @returns {number} number of ops in the local writer */
    get length(): number;
    /** @returns {object | null} the materialized HyperDB view */
    get view(): object | null;
    /** @private */
    private _open;
    /** @private */
    private _close;
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
     * @param {string} op  A write (`put`, `set`, `del`), or an action's name.
     * @param {HookFn} fn
     * @returns {() => void} disposer
     */
    before(op: string, fn: HookFn): () => void;
    /**
     * Register a post-op hook. It runs at apply on every peer, in the op's transaction, so it
     * may write derived rows through `ctx.put` / `ctx.set` / `ctx.del`. On an action it is what
     * the action does.
     *
     * @param {string} op  A write (`put`, `set`, `del`), or an action's name.
     * @param {HookFn} fn
     * @returns {() => void} disposer
     */
    after(op: string, fn: HookFn): () => void;
    /**
     * Insert (or overwrite by id) a row, stamping `id`/`createdAt`/`updatedAt`: an overwrite keeps
     * the row's `createdAt`, and timestamps the caller passes are ignored.
     *
     * @param {string} name
     * @param {Record<string, unknown>} row
     * @returns {Promise<SingleResult | null>}
     */
    put(name: string, row: Record<string, unknown>): Promise<SingleResult | null>;
    /**
     * Upsert by merging with the existing row, preserving `createdAt`.
     *
     * @param {string} name
     * @param {Record<string, unknown>} row
     * @param {{ upsert?: boolean }} [opts]
     * @returns {Promise<SingleResult | null>}
     */
    set(name: string, row: Record<string, unknown>, opts?: {
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
     * Run a declared action: what the `after` hooks on its name do, at apply on every peer.
     *
     * @param {string} op
     * @param {Record<string, unknown>} [data]
     * @returns {Promise<void>}
     */
    call(op: string, data?: Record<string, unknown>): Promise<void>;
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
    /** @private */
    private _chain;
    /**
     * Encode and append dispatch ops. Buffers into the active `tx` queue if one
     * is open.
     *
     * @param {Array<[string, unknown]>} ops
     * @returns {Promise<void>}
     */
    write(ops: Array<[string, unknown]>): Promise<void>;
    /**
     * Read a row. With no `query`: list all (collection) or fetch the one
     * record (single). With a string id: fetch that specific row.
     *
     * @param {string} name
     * @param {string | Query} [query]
     * @returns {Promise<SingleResult | ListResult>}
     */
    get(name: string, query?: string | Query): Promise<SingleResult | ListResult>;
    /** @private */
    private _read;
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
     * Admit another device of this identity as a writer. Another member's device seats itself.
     *
     * @param {Uint8Array} publicKey
     * @returns {Promise<void>}
     */
    addWriter(publicKey: Uint8Array): Promise<void>;
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
    /** @private */
    private _preload;
    /** @private */
    private _boot;
    /** @private */
    private _replay;
    /** @private */
    private _isTrusted;
    /** @private */
    private _apply;
    /** @private */
    private _update;
    /** @private */
    private _joinSwarm;
    /** @private */
    private _holdRoom;
    /** @private */
    private _hold;
    /** @private */
    private _hooks;
    /** @private */
    private _inHook;
    /** @param {string} name @param {() => void} fn @returns {() => void} */
    onUpdate(name: string, fn: () => void): () => void;
    /** @private */
    private _opOf;
    /** @private */
    private _notify;
    /** @private */
    private _merge;
    /** @private */
    private _prepare;
    /** @private */
    private _append;
    /** @private */
    private _done;
    /** @private */
    private _onfuture;
    /** @private */
    private _dryRun;
    /** @private */
    private _plan;
    /** @private */
    private _total;
    /** @private */
    private _optimistic;
    /** @private */
    private _backfilled;
    /** @private */
    private _admission;
    /** @private */
    private _admit;
}
