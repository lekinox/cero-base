import ReadyResource from 'ready-resource';
import { Identity } from '@cero-base/core/identity';
import { Database } from '@cero-base/core/database';
import { Mailbox } from '@cero-base/core/mailbox';
import { Blobs } from '@cero-base/core/blobs';
import { FileServer } from '@cero-base/core/blobs/server';
export { Ref } from '../lib/refs.js';
export type Network = import('@cero-base/core/network').Network;
export type Local = import('../local/index.js').Local;
export type Spec = import('../lib/spec.js').Spec;
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
    store?: import('corestore');
    /**
     * Built cero spec.
     */
    spec?: Spec;
    /**
     * Local store for per-handle keypairs.
     */
    local?: Local;
    /**
     * Owned HypercoreStorage to close on shutdown.
     */
    storage?: import('hypercore-storage');
    /**
     * Owned identity discovery to destroy on shutdown.
     */
    discovery?: {
        destroy(): Promise<void>;
    };
    /**
     * Data directory (root handles only).
     */
    dir?: string;
    /**
     * Pass-through cero(...) options.
     */
    opts?: import('../index.js').CeroOpts;
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
};
export type JoinChildOpts = {
    timeout?: number;
};
export type StaticJoinOpts = {
    parent?: Handle;
    network?: Network;
    identity?: Identity;
    store?: import('corestore');
    spec?: Spec;
    namespace?: string;
    /**
     * Writer keypair in the joined handle; a fresh one by default.
     */
    writer?: KeyPair;
    timeout?: number;
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
export type Context = Handle & Record<string, import('../lib/refs.js').Ref>;
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
export declare class Handle extends ReadyResource {
    /** @type {Identity} */
    identity: Identity;
    /** @type {Network} */
    network: Network;
    spec: import("../lib/spec.js").Spec;
    parent: Handle;
    local: import("../index.js").Local;
    /** @type {Mailbox} */
    mailbox: Mailbox;
    /** @private */
    _storage;
    /** @private */
    _discovery;
    /** @private */
    _dir;
    /** @private */
    _opts;
    /** @type {import('../extensions/index.js').Extension[]} */
    extensions: import('../extensions/index.js').Extension[];
    /** @private */
    _onerror;
    /** @type {Set<Handle> | null} */
    children: Set<Handle> | null;
    /** @private */
    _typeHooks;
    /** @private */
    _loading;
    /** @private */
    _joining;
    /** @private */
    _coreKeys;
    /** @private */
    _fileServer;
    /** @private */
    _blobs;
    /** @private */
    _epochBlobs;
    /** @private */
    _sus;
    /** @private */
    _owned;
    store: Database;
    /** @private */
    _pair;
    /** @private */
    _wantsPair;
    /** @private */
    _live;
    /** @private */
    _ac;
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
    get type(): string;
    /**
     * Canonical id: the identity id on the root, the database key on a room.
     *
     * @returns {string | null}
     */
    get id(): string | null;
    /**
     * This device's id and name. `null` on a room.
     *
     * @returns {{ id: string, name: string | null } | null}
     */
    get device(): {
        id: string;
        name: string | null;
    } | null;
    /** @private */
    private _open;
    /** @private */
    private _close;
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
    /** @private */
    private _link;
    /**
     * Initialise a fresh database: write the genesis claim, derive the writer.
     * Forwards to `Database.bootstrap`.
     *
     * @param {{ name?: string | null, isMobile?: boolean, recovering?: boolean, timeout?: number }} [opts]
     * @returns {Promise<{ id: Uint8Array, writer: KeyPair }>}
     */
    bootstrap(opts?: {
        name?: string | null;
        isMobile?: boolean;
        recovering?: boolean;
        timeout?: number;
    }): Promise<{
        id: Uint8Array;
        writer: KeyPair;
    }>;
    /**
     * Claim writer capability on an existing database (paired-device flow).
     * Forwards to `Database.claim`.
     *
     * @returns {Promise<void>}
     */
    claim(): Promise<void>;
    /** @private */
    private _invite;
    /** @private */
    private _revoke;
    /** @private */
    private _answer;
    /** @private */
    private _rotate;
    /** @private */
    private _tx;
    /** @private */
    private _pairing;
    /** @private */
    private _leave;
    /** @private */
    private _suspend;
    /** @private */
    private _resume;
    /** @private */
    private _lifecycle;
    /** @private */
    private _active;
    /** @private */
    private _status;
    /** @private */
    private _onStatus;
    /** @private */
    private _nearby;
    /** @private */
    private _peers;
    /** @private */
    private _onRadio;
    /** @private */
    private _joins;
    /** @private */
    private _onJoins;
    /** @private */
    private _phrase;
    /**
     * @param {Uint8Array} coreKey
     * @param {object} info
     * @returns {{ key: Uint8Array, encryptionKey: Uint8Array } | null}
     * @private
     */
    private _resolveCore;
    /** @private */
    private _baseBlobs;
    /** @private */
    private _makeBlobs;
    /**
     * Remember the blob-core key a file id points at so the file server can open the core.
     *
     * @param {string} id
     * @param {number} [stamp]
     * @private
     */
    private _registerBlobCore;
    /** @private */
    private _blobCoreKey;
    /**
     * Create a new child handle of `type`. Owner-flow — generates a fresh writer, adds it as a
     * writer + member, and registers the child on the parent's `handles` collection.
     *
     * @param {string} type
     * @param {CreateChildOpts} [opts]
     * @returns {Promise<Handle>}
     * @private
     */
    private _create;
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
    private _join;
    /** @private */
    private _start;
    /** @private */
    private _cancel;
    /** @private */
    private _joined;
    /**
     * Open a joined handle with the keys its reply delivered, once this writer is admitted.
     *
     * @param {string} type
     * @param {import('@cero-base/core/pairing').JoinResult} reply
     * @returns {Promise<Handle>}
     * @private
     */
    private _enter;
    /** @private */
    private _carryOn;
    /**
     * Get an open child by id, or re-open it. Concurrent calls for the same id share one
     * in-flight load, so the child is built — and `handle` emitted — exactly once.
     *
     * @param {string} type
     * @param {string} id
     * @returns {Promise<Handle>}
     * @private
     */
    private _load;
    /**
     * Reconstruct a child handle by id. Reuses the stored writer keypair if
     * available; otherwise generates a fresh one and claims writer capability.
     *
     * @param {string} type
     * @param {string} id
     * @returns {Promise<Handle>}
     * @private
     */
    private _reopen;
    /** @private */
    private _room;
    /** @private */
    private _sleep;
    /** @private */
    private _wake;
    /** @private */
    private _adopt;
    /** @private */
    private _hookType;
    /** @private */
    private _serve;
    /** @private */
    private _reserve;
    /**
     * @param {string} id
     * @param {KeyPair | { publicKey: Uint8Array, secretKey: Uint8Array } | null} keyPair
     * @returns {Promise<void>}
     * @private
     */
    private _saveKeyPair;
    /**
     * @param {string} id
     * @returns {Promise<{ publicKey: Uint8Array, secretKey: Uint8Array } | null>}
     * @private
     */
    private _loadKeyPair;
    /**
     * Pair into an existing handle via an invite, returning a brand-new `Handle` opened with the
     * delivered keys. A one-shot join: the root's `_join` is the one that survives restarts.
     *
     * @param {string} invite
     * @param {StaticJoinOpts} [opts]
     * @returns {Promise<Handle>}
     */
    static join(invite: string, { parent, network, identity, store, spec, namespace, writer, timeout }?: StaticJoinOpts): Promise<Handle>;
    /**
     * A handle opened with the keys a pairing reply delivered.
     *
     * @param {import('@cero-base/core/pairing').JoinResult} reply
     * @param {Omit<HandleOpts, 'key' | 'encryptionKey' | 'epochs' | 'keyPair'>} opts
     * @returns {Handle}
     */
    static fromReply(reply: import('@cero-base/core/pairing').JoinResult, opts: Omit<HandleOpts, 'key' | 'encryptionKey' | 'epochs' | 'keyPair'>): Handle;
}
