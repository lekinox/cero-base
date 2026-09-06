import Autobee from 'autobee';
import c from 'compact-encoding';
declare const WriterEncryption: any;
/**
 * Encryption key for a rotation epoch's blob cores.
 *
 * @param {Uint8Array} entropy
 * @returns {Uint8Array}
 */
export declare function blobEpochKey(entropy: Uint8Array): Uint8Array;
/** Prime a keyring from a local core's persisted epoch stash. */
export declare function loadEpochs(keyring: any, local: any): Promise<void>;
/**
 * Wire codec for a rotation announcement's envelope list — one sealed box
 * per remaining member, addressed by member id.
 */
export declare const wraps: c.Encoder<any[], {
    id: string;
    box: Uint8Array<ArrayBufferLike>;
}[]>;
/**
 * Wire codec for locally persisted / pairing-delivered epoch secrets.
 */
export declare const epochEntries: c.Encoder<any[], {
    epoch: number;
    stamp: number;
    entropy: Uint8Array<ArrayBufferLike>;
}[]>;
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
 * foreign cores, ActiveWriters) picks the epochs up through the patched base class and
 * this `keyring` property.
 */
export declare class EpochAutobee extends Autobee {
    keyring: any;
    _epochStalled: Set<any>;
    _epochRetry: number;
    _epochRetryDelay: number;
    _epochRetrySeen: number;
    constructor(store: any, key: any, handlers?: {});
    _close(): Promise<any>;
    _bumpPendingWriters(...args: any[]): Promise<any>;
    _applyWakeupHints(): Promise<any>;
    _scheduleEpochRetry(): void;
}
export {};
