export type Handle = {
    id: string;
    key: Uint8Array;
};
export type Hit = Handle & {
    length: number;
    newer: boolean;
    ref: string | null;
};
/**
 * @typedef {{ id: string, key: Uint8Array }} Handle  A handle this device holds: its id and its database key.
 * @typedef {Handle & { length: number, newer: boolean, ref: string | null }} Hit  The handle a push is about, the length it proves, whether this device is behind it, and the ref the write was on.
 */
/**
 * Verify a push payload against this device's storage: the one the gateway sent, decoded from the
 * platform's message. Null when it is about no handle given, is forged, or does not decode.
 *
 * @param {import('hypercore-storage')} storage  The corestore's storage; may be opened read-only.
 * @param {Uint8Array} payload
 * @param {Handle[]} handles
 * @returns {Promise<Hit | null>}
 */
export declare function receive(storage: import('hypercore-storage'), payload: Uint8Array, handles: Handle[]): Promise<Hit | null>;
