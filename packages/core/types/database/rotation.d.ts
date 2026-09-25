/**
 * Epoch key rotation for a database: mint a secret, seal it to every member, announce it
 * through the log, and on every peer learn the secrets addressed to it.
 */
export declare class Rotation {
    db: import("./index.js").Database;
    current: {
        entropy: Uint8Array<ArrayBufferLike>;
        stamp: number;
        epoch: number;
    };
    /** @private */
    _queue;
    /** @private */
    _timer;
    /** @private */
    _healedFor;
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
     * Safety net after boot: an epoch applied but never saved, e.g. a crash between a
     * rotation's append and its save, is learned from the epochs collection.
     */
    hydrate(): Promise<void>;
    /** Debounced audit, run after every update. */
    heal(): void;
    /** @private */
    private _rotate;
    /** @private */
    private _members;
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
    private _heal;
}
