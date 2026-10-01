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
