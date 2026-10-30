/**
 * The address a secret owns: share it, anyone can send to it, only the secret opens.
 *
 * @param {Uint8Array} secret
 * @returns {string}
 */
export declare function address(secret: Uint8Array): string;
/**
 * @param {string} address
 * @returns {Uint8Array}
 */
export declare function decodeAddress(address: string): Uint8Array;
/**
 * A value signed by `identity` for the address `to`, so it cannot be redirected elsewhere.
 *
 * @param {import('@cero-base/core/identity').Identity} identity
 * @param {Uint8Array} to
 * @param {unknown} value
 * @returns {Uint8Array}
 */
export declare function seal(identity: import('@cero-base/core/identity').Identity, to: Uint8Array, value: unknown): Uint8Array;
/**
 * The value and who sent it, or null for anything unsigned, tampered or signed for another address.
 *
 * @param {Uint8Array} to
 * @param {Uint8Array} bytes
 * @returns {{ value: unknown, from: string, device: string } | null}
 */
export declare function unseal(to: Uint8Array, bytes: Uint8Array): {
    value: unknown;
    from: string;
    device: string;
} | null;
