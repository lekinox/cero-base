export type RawBlobId = {
    blockOffset: number;
    blockLength: number;
    byteOffset: number;
    byteLength: number;
};
/**
 * Encode a coreKey + raw hyperblobs blobId + type into a durable string id.
 *
 * @param {Uint8Array} coreKey
 * @param {RawBlobId} blobId
 * @param {string} type
 * @returns {string}
 */
export declare function encodeId(coreKey: Uint8Array, blobId: RawBlobId, type: string): string;
/**
 * Decode a string id back into its coreKey, raw blobId and type.
 *
 * @param {string} id
 * @returns {{ coreKey: Uint8Array, blobId: RawBlobId, type: string }}
 */
export declare function decodeId(id: string): {
    coreKey: Uint8Array;
    blobId: RawBlobId;
    type: string;
};
