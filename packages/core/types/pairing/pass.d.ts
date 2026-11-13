export type PassFields = {
    /**
     * An invite into the database.
     */
    invite: string;
    /**
     * The database's key, the one its invite opens.
     */
    key: Uint8Array;
    /**
     * The database's encryption key.
     */
    encryptionKey: Uint8Array;
    /**
     * Its rotation epochs.
     */
    epochs?: Array<{
        epoch: number;
        stamp: number;
        entropy: Uint8Array;
    }>;
    /**
     * The sealer's own bytes, read only by a device that opens the pass.
     */
    data?: Uint8Array | null;
};
/**
 * @typedef {object} PassFields
 * @property {string} invite                       An invite into the database.
 * @property {Uint8Array} key                      The database's key, the one its invite opens.
 * @property {Uint8Array} encryptionKey            The database's encryption key.
 * @property {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} [epochs]  Its rotation epochs.
 * @property {Uint8Array | null} [data]            The sealer's own bytes, read only by a device that opens the pass.
 */
/**
 * An invite into a database with the keys that read it, sealed to devices: one that opens its box
 * joins with the keys in hand and waits for no answer. Unsigned, so whoever opens one holds what
 * it carries to the database's own log.
 */
export declare const Pass: {
    seal: typeof seal;
    open: typeof open;
};
/**
 * One box per device, under its device key. A key nothing can be sealed to gets none.
 *
 * @param {Array<{ key: Uint8Array }>} devices
 * @param {PassFields} fields
 * @returns {Uint8Array}
 */
declare function seal(devices: Array<{
    key: Uint8Array;
}>, fields: PassFields): Uint8Array;
/**
 * What a pass carries, read from this device's own box.
 *
 * @param {import('../identity/index.js').Identity} identity
 * @param {Uint8Array} pass
 * @returns {PassFields | null}  Null when no box is this device's.
 */
declare function open(identity: import('../identity/index.js').Identity, pass: Uint8Array): PassFields | null;
export {};
