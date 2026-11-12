/**
 * Epoch key rotation for a database: mint a secret, seal it to every device, announce it
 * through the log, and on every peer learn the secrets addressed to it.
 */
export declare class Rotation {
    db: import("./index.js").Database;
    current: {
        entropy: Uint8Array<ArrayBufferLike>;
        stamp: number;
        epoch: number;
    };
    /** @type {Promise<void> | null} Pending while a removal and its rotation go in. */
    carrying: Promise<void> | null;
    /** @private */
    _queue;
    /** @private */
    _timer;
    /** @private */
    _healedFor;
    /** @private */
    _kept;
    /** @private */
    _aside;
    /** @private */
    _met;
    /** @param {import('./index.js').Database} db */
    constructor(db: import('./index.js').Database);
    close(): void;
    /**
     * One at a time: a rotation asked for during another runs after it, sealed to the members as
     * they stand then.
     *
     * @returns {Promise<{ epoch: number }>}
     */
    rotate(): Promise<{
        epoch: number;
    }>;
    /**
     * A removal by a device that may remove carries its rotation: the removal, then the key sealed
     * to the devices that stay and to those still promised a seat, with nothing else of this device
     * in between. The key is a block of its own, so it lands even when a reorder refuses the removal.
     *
     * @param {Array<[string, unknown]>} ops  A batch that takes a member or a device out.
     * @returns {Promise<number | undefined>}  What the removal's write resolves.
     */
    carry(ops: Array<[string, unknown]>): Promise<number | undefined>;
    /** @private */
    private _queued;
    /**
     * An applied rotation announcement: open our envelope, learn the secret, persist it.
     *
     * @param {{ epoch: number, stamp: number, wrapped: Uint8Array, commit: Uint8Array }} row
     */
    learn(row: {
        epoch: number;
        stamp: number;
        wrapped: Uint8Array;
        commit: Uint8Array;
    }): Promise<void>;
    /**
     * A block met under a key this device does not hold: a rotation its writer set aside is opened now.
     *
     * @param {number} stamp
     * @param {Uint8Array} [writer]  The writer of the block.
     * @returns {Uint8Array | null}
     */
    meet(stamp: number, writer?: Uint8Array): Uint8Array | null;
    /**
     * A secret handed over before its announcement landed here: kept, and checked against the
     * commitment when it does.
     *
     * @param {{ epoch: number, stamp: number, entropy: Uint8Array }} e
     * @param {string} [from]  The device that sent it: each sender has slots of its own.
     */
    keep(e: {
        epoch: number;
        stamp: number;
        entropy: Uint8Array;
    }, from?: string): void;
    /** @private */
    private _handed;
    /**
     * @returns {Promise<boolean>} Whether the log's newest key is one this device cannot open.
     */
    lacks(): Promise<boolean>;
    /**
     * Safety net after boot: an epoch applied but never saved, e.g. a crash between a
     * rotation's append and its save, is learned from the epochs collection.
     */
    hydrate(): Promise<void>;
    /**
     * The secret held for a row, if it meets the row's commitment.
     *
     * @param {{ stamp: number, commit: Uint8Array }} row
     * @returns {Uint8Array | null}
     */
    held(row: {
        stamp: number;
        commit: Uint8Array;
    }): Uint8Array | null;
    /**
     * Write under the newest landed epoch whose secret this device holds, so a rotation a reorder
     * dropped is never written under.
     *
     * @param {object} [view]
     */
    pick(view?: object): Promise<void>;
    /** Debounced key check, with the owner's raise beside it, run at open and after every update. */
    heal(): void;
    /** @private */
    private _carry;
    /** @private */
    private _staying;
    /** @private */
    private _rotate;
    /** @private */
    private _devices;
    /** @private */
    private _promised;
    /** @private */
    private _stands;
    /** @private */
    private _announce;
    /** @private */
    private _mint;
    /** @private */
    private _taken;
    /** @private */
    private _epochs;
    /** @private */
    private _unseal;
    /** @private */
    private _save;
    /** @private */
    private _audit;
    /** @private */
    private _due;
    /** @private */
    private _drift;
    /** @private */
    private _ask;
    /** @private */
    private _unnamed;
}
/**
 * @param {Array<[string, unknown]>} ops
 * @returns {boolean} Whether a batch takes a member or a device out.
 */
export declare function removes(ops: Array<[string, unknown]>): boolean;
