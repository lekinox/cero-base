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
     * Optional swarm; required for multi-writer replication; `store` is its store or a session of it.
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
            rules?: number;
            start?: number;
            target?: number;
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
     * Encrypts it; a join hands it out, so never the identity's on a database you pair.
     */
    encryptionKey: Uint8Array;
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
     * Push a notification through the mirrors after a local write to a ref whose meta declares `push`, naming the ref, so members learn of it while their app is dead.
     */
    push?: boolean;
    /**
     * This device's writer keypair; a fresh random one by default. Never the identity's, never the database key.
     */
    keyPair?: import('../identity/index.js').KeyPair;
    /**
     * A database whose members this one follows: behind there, it is behind here too.
     */
    parent?: Database | null;
    /**
     * Called when a node is skipped or refused, or the bee errors.
     *
     * Events: `update` (touched refs, a Set, after each applied batch that changed a row), `apply`
     * (one per applied op: `{ op, name, row, writerKey, seq }`, local and replicated), `writable`,
     * `unwritable`, `behind` (the database's version passed this build's contract).
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
    /**
     * On removing a member or changing her rank: whether the writer's rank alone allows it. A rule answers `'grant'` to allow what rank refuses, `false` to refuse.
     */
    ranked?: boolean;
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
            rules?: number;
            start?: number;
            target?: number;
            refs?: Record<string, {
                kind?: string;
                verb?: string;
            }>;
        };
    };
    meta: {
        ns?: string;
        version?: number;
        rules?: number;
        start?: number;
        target?: number;
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
    rules: number;
    start: number;
    target: number;
    /** @type {Database | null} */
    parent: Database | null;
    /** @private */
    _behind;
    /** @private */
    _skipped;
    /** @private */
    _applied;
    /** @private */
    _landed;
    /** @private */
    _rebuilding;
    /** @private */
    _writes;
    namespace: string;
    _writable: boolean;
    encryptionKey: Uint8Array<ArrayBufferLike>;
    keyring: Keyring;
    /** @private */
    _delivered;
    rotation: Rotation;
    key: Uint8Array<ArrayBufferLike>;
    pinned: boolean;
    push: boolean;
    /** @private */
    _pushes;
    keyPair: import("../index.js").KeyPair;
    /** @private */
    _onerror;
    /** @private */
    _room;
    bee: EpochAutobee;
    dispatcher: {
        encode: (route: string, value: unknown, stamp: number) => Uint8Array;
        cut: (route: string, value: Record<string, unknown>, stamp: number) => Record<string, unknown>;
        dispatch: (value: Buffer, ctx: object) => Promise<void>;
        role: (view: object, writer: Uint8Array) => Promise<string | null>;
        version: (view: object) => Promise<number>;
        built: (view: object) => Promise<Array<number | null> | null>;
        apply: (nodes: Array<{
            value: Buffer;
            key: Buffer;
            version: number;
        }>, view: object, host: object) => Promise<{
            landed: Array<{
                value: Buffer;
                key: Buffer;
                version: number;
            }>;
            changed: boolean;
        }>;
    };
    /** @private */
    _presence;
    /** @private */
    _pushing;
    /** @private */
    _pushAgain;
    /** @private */
    _pushed;
    /** @private */
    _pushRef;
    /** @private */
    _onResume;
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
    /** @returns {number | null} the database's version, or its parent's, while it is past this build's contract */
    get behind(): number | null;
    /** @returns {boolean} whether the bee accepts local writes */
    get writable(): boolean;
    /** @returns {number} number of ops in the local writer */
    get length(): number;
    /** @returns {object | null} the materialized HyperDB view */
    get view(): object | null;
    /** @private */
    private _open;
    /** @private */
    private _wire;
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
     * @returns {Promise<number | undefined>}  The stamp the last op was appended with; nothing when queued or when nothing changed.
     */
    write(ops: Array<[string, unknown]>): Promise<number | undefined>;
    /** @private */
    private _frozen;
    /** @private */
    private _write;
    /** @private */
    private _commit;
    /** @returns {boolean} Whether a push notification is on its way to the mirrors. */
    get pushing(): boolean;
    /** @private */
    private _push;
    /** @private */
    private _ref;
    /** @private */
    private _send;
    /**
     * Read a row. With no `query`: list all (collection) or fetch the one
     * record (single). With a string id: fetch that specific row.
     *
     * @param {string} name
     * @param {string | Query} [query]
     * @returns {Promise<SingleResult | ListResult>}
     */
    get(name: string, query?: string | Query): Promise<SingleResult | ListResult>;
    /**
     * Whether a member is out for good, as this device has seen it: `'removed'` by another member, `'left'` on her
     * own, or null while she is a member, never was one, or her going has not reached this device. A member let in
     * again after is a member: null.
     *
     * @param {string} memberId
     * @returns {Promise<'removed' | 'left' | null>}
     */
    removed(memberId: string): Promise<'removed' | 'left' | null>;
    /**
     * Who removed a member, from the record of her removal: null while none reached this device, and
     * for one who left on her own.
     *
     * @param {string} memberId
     * @returns {Promise<{ by: string | null } | null>}
     */
    removal(memberId: string): Promise<{
        by: string | null;
    } | null>;
    /**
     * Resolves once another device or a mirror holds every block this device wrote.
     *
     * @returns {Promise<void>}
     */
    held(): Promise<void>;
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
     * The rows of a collection that changed since `settle` was last called under `mark`, a name of the
     * caller's, so what follows a collection row by row goes on after a restart where it stopped. With no
     * point to start from, `reset` is true and `changes` holds every row. A caller that takes changes and
     * does not settle starts over at its next call. The point is kept on this device only.
     *
     * @param {string} name
     * @param {string} mark
     * @returns {Promise<{ changes: Array<{ prev: Row | null, next: Row | null }>, reset: boolean, settle: () => Promise<void> }>}
     */
    since(name: string, mark: string): Promise<{
        changes: Array<{
            prev: Row | null;
            next: Row | null;
        }>;
        reset: boolean;
        settle: () => Promise<void>;
    }>;
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
     * Seat this device's writer where its identity is a member, or was promised to be one: wait
     * for the member row or the promise, append the add-writer the identity signs from this
     * device's own core, and resolve once it writes. A member whose role cannot write takes no
     * seat; a promise made to her is kept all the same, and resolves at this device's row. Rejects
     * `DENIED`, with the reason, once the room shows this writer turned away: its promise withdrawn.
     *
     * @param {{ timeout?: number }} [opts]
     * @returns {Promise<void>}
     */
    claim({ timeout }?: {
        timeout?: number;
    }): Promise<void>;
    /**
     * Resolve once the bee becomes writable, or reject after `timeout` ms.
     *
     * @param {{ timeout?: number }} [opts]
     * @returns {Promise<void>}
     */
    whenWritable({ timeout }?: {
        timeout?: number;
    }): Promise<void>;
    /** @private */
    private _onwritable;
    /**
     * Learn epochs handed over after the open, as a root carries them for a handle. One is kept
     * once its announcement applied here and the secret meets the commitment it carries: hand them
     * over again when an announcement applies.
     *
     * @param {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} epochs
     * @returns {Promise<void>}
     */
    learn(epochs: Array<{
        epoch: number;
        stamp: number;
        entropy: Uint8Array;
    }>): Promise<void>;
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
    private _onWriter;
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
    private _joins;
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
    private _build;
    /** @private */
    private _foreign;
    /** @private */
    private _onmove;
    /** @private */
    private _rebuild;
    /** @private */
    private _wipe;
    /** @private */
    private _skip;
    /** @private */
    private _track;
    /** @private */
    private _raise;
    /** @private */
    private _stamp;
    /** @private */
    private _dryRun;
    /** @private */
    private _plan;
    /** @private */
    private _total;
    /** @private */
    private _member;
    /** @private */
    private _standing;
    /** @private */
    private _kept;
    /** @private */
    private _refused;
    /** @private */
    private _admission;
    /** @private */
    private _admit;
}
