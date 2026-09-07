import AbortController from 'bare-abort-controller';
import ReadyResource from 'ready-resource';
import { Identity } from '@cero-base/core/identity';
import { Database } from '@cero-base/core/database';
import { Pairing } from '@cero-base/core/pairing';
import { Blobs } from '@cero-base/core/blobs';
import { FileServer } from '@cero-base/core/blobs/server';
export { Ref } from '../lib/refs.js';
export type Network = import('@cero-base/core/network').Network;
export type Local = import('../local/index.js').Local;
export type KeyPair = import('@cero-base/core/identity').KeyPair;
export type HandleOpts = {
    /**
     * Parent handle when this is a child slot.
     */
    parent?: Handle;
    /**
     * Long-lived user identity. Inherited from `parent` if omitted.
     */
    identity?: Identity;
    /**
     * Shared swarm. Inherited from `parent` if omitted.
     */
    network?: Network;
    /**
     * Pre-existing Corestore. Falls back to `parent.store.store`.
     */
    store?: any;
    /**
     * Built cero spec.
     */
    spec?: any;
    /**
     * Local store for per-handle keypairs.
     */
    local?: Local;
    /**
     * Owned HypercoreStorage to close on shutdown.
     */
    storage?: any;
    /**
     * Owned identity Discovery to destroy on shutdown.
     */
    discovery?: any;
    /**
     * Data directory (root handles only).
     */
    dir?: string;
    /**
     * Pass-through cero(...) options.
     */
    opts?: any;
    routes?: Record<string, Function>;
    /**
     * Existing database key.
     */
    key?: Uint8Array;
    /**
     * Existing encryption key.
     */
    encryptionKey?: Uint8Array;
    /**
     * Rotation epochs delivered at join.
     */
    epochs?: Array<{
        epoch: number;
        entropy: Uint8Array;
    }>;
    /**
     * Corestore namespace.
     */
    namespace?: string;
    /**
     * Writer keypair.
     */
    keyPair?: KeyPair;
    /**
     * When `false`, skips creating a `Pairing` session.
     */
    pair?: boolean;
};
export type CreateChildOpts = {
    name?: string | null;
    routes?: Record<string, Function>;
    role?: string;
    accept?: boolean;
};
export type JoinChildOpts = {
    routes?: Record<string, Function>;
    timeout?: number;
};
export type StaticJoinOpts = {
    parent?: Handle;
    network?: Network;
    identity?: Identity;
    store?: any;
    spec?: any;
    namespace?: string;
    routes?: Record<string, Function>;
    timeout?: number;
};
export type AcceptOpts = {
    /**
     * Role to grant the joining peer. Falls back to the invite's role, then `'member'`.
     */
    role?: string;
    name?: string | null;
};
export type HandleExtra = {
    /**
     * Display name; set on child handles by the owner flow.
     */
    name?: string | null;
    /**
     * `profile` ref, attached dynamically when the schema declares one.
     */
    profile?: import('../lib/refs.js').Ref;
    /**
     * `members` ref, attached dynamically when the schema declares one.
     */
    members?: import('../lib/refs.js').Ref;
};
export type Child = Handle & HandleExtra;
export type CeroHandle = Handle & Record<string, import('../lib/refs.js').Ref>;
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
export declare class Handle extends ReadyResource {
    identity: any;
    network: any;
    spec: any;
    parent: Handle;
    local: import("../index.js").Local;
    _storage: any;
    _discovery: any;
    _dir: string;
    _opts: any;
    extensions: any;
    operators: any;
    _onerror: any;
    children: Set<any>;
    _typeHooks: Set<any>;
    _loading: Map<any, any>;
    _joining: Map<any, any>;
    _coreKeys: Map<any, any>;
    _fileServer: FileServer;
    _blobs: Blobs;
    _epochBlobs: any;
    _sus: any;
    _owned: Set<any>;
    store: Database;
    pair: Pairing;
    _wantsPair: boolean;
    _ac: AbortController;
    _invitesSync: (touched: any) => void;
    /** @param {HandleOpts} [opts] */
    constructor(opts?: HandleOpts);
    /**
     * An `AbortSignal` that fires when this handle closes.
     *
     * @returns {AbortSignal}
     */
    get signal(): AbortSignal;
    /** The top-most handle in the parent chain — itself for a root handle. */
    get root(): this;
    /**
     * Lazily-built file server for this identity. Root-only — child handles
     * reach it through `this.root.fileServer`.
     *
     * @returns {FileServer}
     */
    get fileServer(): FileServer;
    /**
     * Lazily-built blob store for THIS handle's writing device, at the current rotation epoch.
     *
     * @returns {Blobs}
     */
    get blobs(): Blobs;
    /** The handle type of a child, null on the root. */
    get type(): any;
    /** Canonical id — identity id for the root handle, store key for children. */
    get id(): any;
    /** This device's id + name. `null` on child handles. */
    get device(): {
        id: any;
        name: any;
    };
    get suspended(): boolean;
    _open(): Promise<void>;
    _close(): Promise<void>;
    /**
     * Tie a destroyable resource (a `watch` stream, a timer, any `{ destroy }`) to this
     * handle's lifecycle — it's destroyed automatically on close, so callers don't track
     * cleanup.
     *
     * @template {{ destroy?: Function, once?: Function }} T
     * @param {T} resource
     * @returns {T}
     */
    own<T extends {
        destroy?: Function;
        once?: Function;
    }>(resource: T): T;
    /**
     * `EventEmitter.on` plus an optional `{ signal }` that removes the listener
     * when the signal aborts — e.g. `me.on('handle', fn, { signal: me.signal })`.
     *
     * @param {string} event
     * @param {(...args: any[]) => void} fn
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {this}
     */
    on(event: string, fn: (...args: any[]) => void, opts?: {
        signal?: AbortSignal;
    }): this;
    /**
     * Resolve a durable file id to an ephemeral download url via this identity's
     * file server.
     *
     * @param {string} id
     * @returns {string}
     */
    getLink(id: string): string;
    /**
     * Initialise a fresh database: write the genesis claim, derive the writer.
     * Forwards to `Database.bootstrap`.
     *
     * @param {any} [opts]
     * @returns {Promise<any>}
     */
    bootstrap(opts?: any): Promise<any>;
    /**
     * Claim writer capability on an existing database (paired-device flow).
     * Forwards to `Database.claim`.
     *
     * @returns {Promise<void>}
     */
    claim(): Promise<void>;
    /**
     * `true` ranks this handle as just touched, `false` takes it out of the swarm until the
     * next update lands in it.
     *
     * @param {boolean} active
     */
    setActive(active: boolean): void;
    /**
     * Mint a pairing invite for this handle.
     *
     * @param {{ role?: string, expiresIn?: number, data?: any }} [opts]
     * @returns {Promise<string>}  Z32-encoded invite string.
     */
    invite(opts?: {
        role?: string;
        expiresIn?: number;
        data?: any;
    }): Promise<string>;
    /**
     * Revoke a previously-minted invite by its string form.
     *
     * @param {string} invite
     * @returns {Promise<boolean>}  `true` if the invite was found and removed.
     */
    revoke(invite: string): Promise<boolean>;
    /**
     * Accept a paired candidate — adds them as a writer (or read-only member)
     * and confirms the pairing so they receive this handle's keys.
     *
     * @param {any} candidate
     * @param {AcceptOpts} [opts]
     * @returns {Promise<void>}
     */
    accept(candidate: any, { role, name }?: AcceptOpts): Promise<void>;
    /**
     * Leave a child handle — removes it from the parent's `handles` collection
     * and closes the session. No-op on root handles.
     *
     * @returns {Promise<void>}
     */
    leave(): Promise<void>;
    /**
     * Pause networking + storage. Idempotent; no-op on child handles.
     *
     * @returns {Promise<void>}
     */
    suspend(): Promise<void>;
    /**
     * Resume a suspended root handle. Idempotent; no-op on child handles.
     *
     * @returns {Promise<void>}
     */
    resume(): Promise<void>;
    /**
     * @param {Uint8Array} coreKey
     * @param {object} info
     * @returns {{ key: Uint8Array, encryptionKey: Uint8Array } | null}
     */
    _resolveCore(coreKey: Uint8Array, info: object): {
        key: Uint8Array;
        encryptionKey: Uint8Array;
    } | null;
    _baseBlobs(): Blobs;
    _makeBlobs(name: any, encryptionKey: any, stamp: any): Blobs;
    /**
     * Remember the blob-core key a file id points at so the file server can open the core.
     *
     * @param {string} id
     * @param {number} [stamp]
     */
    _registerBlobCore(id: string, stamp?: number): void;
    _blobCoreKey(stamp: any): Uint8Array<ArrayBufferLike>;
    _syncInvites(): Promise<void>;
    _checkGrant(role: any): Promise<void>;
    /**
     * Create a new child handle of `type`. Owner-flow — generates a fresh writer, adds it as a
     * writer + member, and registers the child on the parent's `handles` collection.
     *
     * @param {string} type
     * @param {CreateChildOpts} [opts]
     * @returns {Promise<Handle>}
     */
    _create(type: string, { name, routes, role, accept }?: CreateChildOpts): Promise<Handle>;
    /**
     * Join a child handle by invite (joiner-flow).
     *
     * @param {string} invite
     * @param {string} type
     * @param {JoinChildOpts} [opts]
     * @returns {Promise<Handle>}
     */
    _join(invite: string, type: string, opts?: JoinChildOpts): Promise<Handle>;
    /**
     * @param {string} invite
     * @param {string} type
     * @param {JoinChildOpts} [opts]
     * @param {Uint8Array | null} [target]
     * @returns {Promise<Handle>}
     */
    _pair(invite: string, type: string, { routes, timeout }?: JoinChildOpts, target?: Uint8Array | null): Promise<Handle>;
    /**
     * Get an open child by id, or re-open it. Concurrent calls for the same id share one
     * in-flight load, so the child is built — and `handle` emitted — exactly once.
     *
     * @param {string} type
     * @param {string} id
     * @returns {Promise<Handle>}
     */
    _load(type: string, id: string, opts: any): Promise<Handle>;
    /**
     * Reconstruct a child handle by id. Reuses the stored writer keypair if
     * available; otherwise generates a fresh one and claims writer capability.
     *
     * @param {string} type
     * @param {string} id
     * @returns {Promise<Handle>}
     */
    _reopen(type: string, id: string, opts: any): Promise<Handle>;
    _suspend(): Promise<void>;
    _resume(): Promise<void>;
    _adopt(child: any, info: any): void;
    _hookType(op: any, ref: any, fn: any, opts: any): () => void;
    /**
     * @param {Handle} child
     * @param {{ role?: string }} [opts]
     */
    _wireAccept(child: Handle, { role }?: {
        role?: string;
    }): void;
    /**
     * @param {string} id
     * @param {KeyPair | { publicKey: Uint8Array, secretKey: Uint8Array } | null} keyPair
     * @returns {Promise<void>}
     */
    _saveKeyPair(id: string, keyPair: KeyPair | {
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    } | null): Promise<void>;
    /**
     * @param {string} id
     * @returns {Promise<{ publicKey: Uint8Array, secretKey: Uint8Array } | null>}
     */
    _loadKeyPair(id: string): Promise<{
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    } | null>;
    /**
     * Pair into an existing handle via an invite, returning a brand-new
     * `Handle` already configured with the resolved key + encryption key.
     *
     * @param {string} invite
     * @param {StaticJoinOpts} [opts]
     * @returns {Promise<Handle>}
     */
    static join(invite: string, { parent, network, identity, store, spec, namespace, routes, timeout }?: StaticJoinOpts): Promise<Handle>;
}
