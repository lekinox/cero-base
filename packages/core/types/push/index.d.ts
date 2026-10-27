export type Handle = {
    id: string;
    key: Uint8Array;
};
export type Block = {
    index: number;
    value: Uint8Array;
    writer: Uint8Array;
};
export type Hit = Handle & {
    length: number;
    newer: boolean;
    ref: string | null;
    block: Block | null;
};
/**
 * @typedef {{ id: string, key: Uint8Array }} Handle  A handle this device holds: its id and its database key.
 * @typedef {{ index: number, value: Uint8Array, writer: Uint8Array }} Block  The block a push carries when it fits: its index, its bytes as the writer's core holds them, and the writer's key.
 * @typedef {Handle & { length: number, newer: boolean, ref: string | null, block: Block | null }} Hit  The handle a push is about, the length it proves, whether this device is behind it, the ref the write was on, and the block when it rode along.
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
export declare function verify(storage: import('hypercore-storage'), payload: Uint8Array, handles: Handle[]): Promise<Hit | null>;
/**
 * The op a push's block holds, for a device with the handle's keys: decrypted as the writer's
 * core would, under the epoch the block names, and stripped of its envelope. Null when the push
 * carried no block, the writer is not stored here, or the epoch is not among `epochs`.
 *
 * @param {import('hypercore-storage')} storage  The same storage `verify` read.
 * @param {Hit} hit
 * @param {{ encryptionKey: Uint8Array, epochs?: Array<{ epoch: number, stamp: number, entropy: Uint8Array }> }} keys  The handle's encryption key and the rotation epochs it has learned.
 * @returns {Promise<Uint8Array | null>}
 */
export declare function decrypt(storage: import('hypercore-storage'), hit: Hit, { encryptionKey, epochs }: {
    encryptionKey: Uint8Array;
    epochs?: Array<{
        epoch: number;
        stamp: number;
        entropy: Uint8Array;
    }>;
}): Promise<Uint8Array | null>;
