import Autobee from 'autobee';
/** @type {typeof import('autobee/lib/encryption.js').WriterEncryption} */
declare const WriterEncryption: typeof import('autobee/lib/encryption.js').WriterEncryption;
/**
 * Encryption key for a rotation epoch's blob cores.
 *
 * @param {Uint8Array} entropy
 * @returns {Uint8Array}
 */
export declare function blobEpochKey(entropy: Uint8Array): Uint8Array;
/**
 * Prime a keyring from a local core's persisted epoch stash.
 *
 * @param {Keyring} keyring
 * @param {import('hypercore')} local
 * @returns {Promise<void>}
 */
export declare function loadEpochs(keyring: Keyring, local: import('hypercore')): Promise<void>;
/**
 * Wire codec for a rotation announcement's envelope list — one sealed box
 * per remaining member, addressed by member id.
 *
 * @param {Array<{ id: string }>} members
 * @param {Uint8Array} secret
 * @returns {Array<{ id: string, box: Uint8Array }>}
 */
export declare function seal(members: Array<{
    id: string;
}>, secret: Uint8Array): Array<{
    id: string;
    box: Uint8Array;
}>;
/**
 * @param {import('../identity/index.js').Identity} identity
 * @param {Uint8Array} wrapped
 * @returns {Generator<Uint8Array, void, unknown>}
 */
export declare function opened(identity: import('../identity/index.js').Identity, wrapped: Uint8Array): Generator<Uint8Array, void, unknown>;
/** @type {import('compact-encoding').Encoder<Array<{ id: string, box: Uint8Array }>>} */
export declare const wraps: import('compact-encoding').Encoder<Array<{
    id: string;
    box: Uint8Array;
}>>;
/**
 * Wire codec for locally persisted / pairing-delivered epoch secrets.
 *
 * @type {import('compact-encoding').Encoder<Array<{ epoch: number, stamp: number, entropy: Uint8Array }>>}
 */
export declare const epochEntries: import('compact-encoding').Encoder<Array<{
    epoch: number;
    stamp: number;
    entropy: Uint8Array;
}>>;
/**
 * Per-database registry of rotation epochs.
 */
export declare class Keyring {
    /** @type {Map<number, Uint8Array>} stamp → entropy */
    entropies: Map<number, Uint8Array>;
    /** @type {Map<number, number>} stamp → apply-order sequence */
    seqs: Map<number, number>;
    /** stamp used for new blocks — the adopted epoch with the highest seq */
    current: number;
    /** highest adopted apply-order sequence (0 = base era) */
    seq: number;
    /** bumped on every add/remove — cheap change detection for retries */
    version: number;
    constructor();
    /** @returns {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} ascending by seq */
    all(): Array<{
        epoch: number;
        stamp: number;
        entropy: Uint8Array;
    }>;
    /**
     * @param {number} stamp
     * @param {Uint8Array} entropy
     * @param {number} [seq]  Apply-order sequence; drives `current` selection.
     */
    add(stamp: number, entropy: Uint8Array, seq?: number): void;
    /**
     * @param {number} stamp
     * @returns {Uint8Array | null}
     */
    entropy(stamp: number): Uint8Array | null;
    /**
     * Forget an epoch (used to undo an add whose persistence failed).
     *
     * @param {number} stamp
     */
    remove(stamp: number): void;
}
/**
 * The epoch-aware provider — the class itself is upstream WriterEncryption; the epoch
 * behavior lives on the (patched) base prototype above.
 */
export declare class EpochEncryption extends WriterEncryption {
}
/**
 * Autobee with a rotation keyring. Every provider autobee constructs (view/system factory,
 * foreign cores, ActiveWriters) picks the epochs up through the patched base class, which asks
 * this instance for `keyId` and `getEntropy`.
 */
export declare class EpochAutobee extends Autobee {
    /** @type {Keyring | null} */
    keyring: Keyring | null;
    /** @private */
    _epochStalled;
    /** @private */
    _epochRetry;
    /** @private */
    _epochRetryDelay;
    /** @private */
    _epochRetrySeen;
    /**
     * @param {import('corestore')} store
     * @param {Uint8Array | null} key
     * @param {{ keyring?: Keyring } & Record<string, unknown>} [handlers]  Autobee's options, plus the keyring.
     */
    constructor(store: import('corestore'), key: Uint8Array | null, handlers?: {
        keyring?: Keyring;
    } & Record<string, unknown>);
    /** @returns {number} the key id new blocks are written with */
    get keyId(): number;
    /** @param {number} id @param {{ key?: Uint8Array }} [ctx] @returns {Promise<Uint8Array>} */
    getEntropy(id: number, ctx?: {
        key?: Uint8Array;
    }): Promise<Uint8Array>;
    /** @private */
    private _close;
    /** @private */
    private _bumpPendingWriters;
    /** @private */
    private _applyWakeupHints;
    /** @private */
    private _scheduleEpochRetry;
}
export {};
