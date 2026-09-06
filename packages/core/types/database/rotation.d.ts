/**
 * Epoch key rotation for a database: mint a secret, seal it to every member, announce it
 * through the log, and on every peer learn the secrets addressed to it.
 */
export declare class Rotation {
    db: import("./index.js").Database;
    current: {
        entropy: Uint8Array<ArrayBufferLike>;
        stamp: any;
        epoch: number;
    };
    _timer: number;
    _healedFor: any;
    /** @param {import('./index.js').Database} db */
    constructor(db: import('./index.js').Database);
    close(): void;
    /** @returns {Promise<{ epoch: number }>} */
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
    _rotate(retried: any): any;
    _members(): Promise<any[]>;
    _seal(members: any, entropy: any): any;
    _announce(stamp: any, entropy: any, wrapped: any): Promise<number>;
    _mint(): any;
    _taken(stamp: any): Promise<any>;
    _epochs(): any;
    _unseal(row: any): Uint8Array<ArrayBufferLike>;
    _save(): any;
    _audit(): Promise<void>;
}
