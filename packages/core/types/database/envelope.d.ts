/**
 * Prefix an encoded op with the app's contract version.
 *
 * @param {number} version
 * @param {Uint8Array} body
 * @returns {Uint8Array}
 */
export declare function wrap(version: number, body: Uint8Array): Uint8Array;
/**
 * Split an op into contract version and payload. Ops written before the
 * envelope existed carry no sentinel and read as version 0.
 *
 * @param {Uint8Array} buf
 * @returns {{ version: number, body: Uint8Array }}
 */
export declare function unwrap(buf: Uint8Array): {
    version: number;
    body: Uint8Array;
};
