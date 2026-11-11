export declare const STATUS_ACCEPTED = 0;
export declare const STATUS_DENIED = 1;
export type Answer = {
    status: number;
    reason?: string;
    key?: Uint8Array | null;
    encryptionKey?: Uint8Array | null;
    epochs?: Array<{
        epoch: number;
        stamp: number;
        entropy: Uint8Array;
    }> | null;
    proof?: Uint8Array | null;
    tag?: Uint8Array | null;
};
/**
 * @typedef {{ status: number, reason?: string, key?: Uint8Array | null, encryptionKey?: Uint8Array | null, epochs?: Array<{ epoch: number, stamp: number, entropy: Uint8Array }> | null, proof?: Uint8Array | null, tag?: Uint8Array | null }} Answer
 */
/** @type {import('compact-encoding').Encoder<Answer>} */
export declare const Response: import('compact-encoding').Encoder<Answer>;
/**
 * An answer's tag, keyed by what the invite's address and the joiner's reply address share: each
 * end makes it from its own secret key and the other's address, and nobody else can.
 *
 * @param {Answer} answer
 * @param {Uint8Array} secretKey  This end's secret key.
 * @param {Uint8Array} publicKey  The other end's address.
 * @returns {Uint8Array | null}   Null for an address that shares nothing.
 */
export declare function tag(answer: Answer, secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array | null;
/**
 * Whether an answer carries the tag its two ends make.
 *
 * @param {Answer | null} answer
 * @param {Uint8Array} secretKey
 * @param {Uint8Array} publicKey
 * @returns {boolean}
 */
export declare function proven(answer: Answer | null, secretKey: Uint8Array, publicKey: Uint8Array): boolean;
