import ReadyResource from 'ready-resource';
import { encodeId, decodeId } from './codec.js';
export type BlobsOpts = {
    /**
     * Corestore (or compatible) used to host the blob core.
     */
    store: object;
    /**
     * Identity supplying the default encryption key.
     */
    identity?: import('../identity/index.js').Identity;
    /**
     * Optional network used to announce + replicate the core.
     */
    network?: import('../network/index.js').Network;
    /**
     * Pre-existing blob core key — joins an existing blob feed.
     */
    key?: Uint8Array;
    /**
     * Explicit encryption key, overrides `identity.encryptionKey`.
     */
    encryptionKey?: Uint8Array;
};
export type RawBlobId = import('./codec.js').RawBlobId;
/**
 * @typedef {object} BlobsOpts
 * @property {object} store                                           Corestore (or compatible) used to host the blob core.
 * @property {import('../identity/index.js').Identity} [identity]     Identity supplying the default encryption key.
 * @property {import('../network/index.js').Network} [network]        Optional network used to announce + replicate the core.
 * @property {Uint8Array} [key]                                       Pre-existing blob core key — joins an existing blob feed.
 * @property {Uint8Array} [encryptionKey]                             Explicit encryption key, overrides `identity.encryptionKey`.
 *
 * @typedef {import('./codec.js').RawBlobId} RawBlobId
 */
/** Thin wrapper over a single Hyperblobs core; deals only in raw blobIds. */
export declare class Blobs extends ReadyResource {
    store: object;
    identity: import("../index.js").Identity;
    network: import("../index.js").Network;
    encryptionKey: Uint8Array<ArrayBufferLike>;
    name: any;
    _coreKey: Uint8Array<ArrayBufferLike>;
    core: any;
    hyperblobs: any;
    _discovery: import("../network/discovery.js").Discovery;
    /** @param {BlobsOpts} [opts] */
    constructor({ store, identity, network, key, encryptionKey, name }?: BlobsOpts);
    /**
     * Canonical z32 id of the underlying core (null until ready).
     *
     * @returns {string | null}
     */
    get id(): string | null;
    /**
     * Public key of the underlying core.
     *
     * @returns {Uint8Array | null}
     */
    get key(): Uint8Array | null;
    /**
     * Discovery key derived from the core key, used for swarm topics.
     *
     * @returns {Uint8Array | null}
     */
    get discoveryKey(): Uint8Array | null;
    _open(): Promise<void>;
    _close(): Promise<void>;
    /**
     * Store a buffer or readable stream, returning its raw hyperblobs blobId.
     *
     * @param {Uint8Array | import('streamx').Readable} input
     * @returns {Promise<RawBlobId>}
     */
    put(input: Uint8Array | import('streamx').Readable): Promise<RawBlobId>;
    /**
     * Resolve the blob bytes for a raw blobId. Fetches from peers if not local.
     *
     * @param {RawBlobId} blobId
     * @param {object} [opts]
     * @returns {Promise<Uint8Array>}
     */
    get(blobId: RawBlobId, opts?: object): Promise<Uint8Array>;
    /**
     * Streaming counterpart of `get` — a Readable over the blob bytes.
     *
     * @param {RawBlobId} blobId
     * @param {object} [opts]
     * @returns {import('streamx').Readable}
     */
    createReadStream(blobId: RawBlobId, opts?: object): import('streamx').Readable;
    /**
     * Clear the blocks backing a raw blobId from the local core.
     *
     * @param {RawBlobId} blobId
     * @returns {Promise<void>}
     */
    clear(blobId: RawBlobId): Promise<void>;
    /**
     * @param {import('streamx').Readable} input
     * @returns {Promise<RawBlobId>}
     */
    _putStream(input: import('streamx').Readable): Promise<RawBlobId>;
    _guard(): void;
}
export { encodeId, decodeId };
