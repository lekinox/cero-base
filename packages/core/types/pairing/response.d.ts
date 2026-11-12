export declare const STATUS_ACCEPTED = 0;
export declare const STATUS_DENIED = 1;
/** @type {import('compact-encoding').Encoder<{ status: number, reason?: string, key?: Uint8Array | null, encryptionKey?: Uint8Array | null, epochs?: Array<{ epoch: number, stamp: number, entropy: Uint8Array }> | null }>} */
export declare const Response: import('compact-encoding').Encoder<{
    status: number;
    reason?: string;
    key?: Uint8Array | null;
    encryptionKey?: Uint8Array | null;
    epochs?: Array<{
        epoch: number;
        stamp: number;
        entropy: Uint8Array;
    }> | null;
}>;
/**
 * The tag of an encoded answer, keyed by what the invite's address and the joiner's reply address
 * share: each end makes it from its own secret key and the other's address, and nobody else can.
 *
 * @param {Uint8Array} answer     The answer as it is sent.
 * @param {Uint8Array} secretKey  This end's secret key.
 * @param {Uint8Array} publicKey  The other end's address.
 * @returns {Uint8Array | null}   Null for an address that shares nothing.
 */
export declare function tag(answer: Uint8Array, secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array | null;
/**
 * The answer in a message that starts with its tag: the bytes after it, null when the tag is not
 * the one its two ends make over them.
 *
 * @param {Uint8Array} message
 * @param {Uint8Array} secretKey
 * @param {Uint8Array} publicKey
 * @returns {Uint8Array | null}
 */
export declare function proven(message: Uint8Array, secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array | null;
/**
 * Keys sent to a device that asked, as they are sent: the sender's writer key, then its device's
 * signature over the room, the writer they go to and the answer, then the answer.
 *
 * @param {Uint8Array} answer
 * @param {{ room: Uint8Array, to: Uint8Array, writer: Uint8Array, secretKey: Uint8Array }} opts
 * @returns {Uint8Array}
 */
export declare function signed(answer: Uint8Array, { room, to, writer, secretKey }: {
    room: Uint8Array;
    to: Uint8Array;
    writer: Uint8Array;
    secretKey: Uint8Array;
}): Uint8Array;
/**
 * The sender and the answer of signed keys, null unless the device key `keyOf` gives for the
 * sender's writer signed them for this room and this writer.
 *
 * @param {Uint8Array} message
 * @param {{ room: Uint8Array, to: Uint8Array }} opts
 * @param {(writer: Uint8Array) => Uint8Array | null | undefined} keyOf
 * @returns {{ writer: Uint8Array, answer: Uint8Array } | null}
 */
export declare function signer(message: Uint8Array, { room, to }: {
    room: Uint8Array;
    to: Uint8Array;
}, keyOf: (writer: Uint8Array) => Uint8Array | null | undefined): {
    writer: Uint8Array;
    answer: Uint8Array;
} | null;
