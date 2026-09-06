export declare const STATUS_ACCEPTED = 0;
export declare const STATUS_DENIED = 1;
export declare const Response: {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        status: any;
        reason: any;
        key: any;
        encryptionKey: any;
        extra: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        data: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        id: any;
        name: any;
        role: any;
        noAccept: boolean;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        coreKey: any;
        blockOffset: any;
        blockLength: any;
        byteOffset: any;
        byteLength: any;
        type: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        prev: any;
        next: any;
    };
};
export type ConfirmOpts = {
    /**
     * 32-byte resource key delivered to the joiner; required at runtime.
     */
    key?: Uint8Array;
    /**
     * Optional 32-byte symmetric key.
     */
    encryptionKey?: Uint8Array | null;
    /**
     * Extra opaque bytes piggybacked on the response.
     */
    additional?: Uint8Array | null;
};
export type RequestOpts = {
    /**
     * Owning Pairing instance.
     */
    pairing: import('./index.js').Pairing;
    /**
     * blind-pairing candidate request being answered.
     */
    req: any;
    /**
     * Invite the candidate paired against.
     */
    invite: import('./invite.js').Invite;
    /**
     * Per-invite seed used to sign the response.
     */
    seed: Uint8Array;
    /**
     * Decoded joiner payload (raw bytes when no encoding).
     */
    userData: any;
    /**
     * Called once when the candidate is confirmed or denied.
     */
    onsettle: () => void;
};
/**
 * @typedef {object} ConfirmOpts
 * @property {Uint8Array} [key]                                      32-byte resource key delivered to the joiner; required at runtime.
 * @property {Uint8Array | null} [encryptionKey]                     Optional 32-byte symmetric key.
 * @property {Uint8Array | null} [additional]                        Extra opaque bytes piggybacked on the response.
 *
 * @typedef {object} RequestOpts
 * @property {import('./index.js').Pairing} pairing                  Owning Pairing instance.
 * @property {any} req                                               blind-pairing candidate request being answered.
 * @property {import('./invite.js').Invite} invite                   Invite the candidate paired against.
 * @property {Uint8Array} seed                                       Per-invite seed used to sign the response.
 * @property {any} userData                                          Decoded joiner payload (raw bytes when no encoding).
 * @property {() => void} onsettle                                   Called once when the candidate is confirmed or denied.
 */
/**
 * Internal — a pairing request from an incoming candidate, awaiting the host's
 * accept/deny.
 *
 * @property {boolean} _settled                       Whether confirm/deny has already run.
 */
export declare class Request {
    pairing: import("./index.js").Pairing;
    _req: any;
    _seed: Uint8Array<ArrayBufferLike>;
    _settled: boolean;
    _onsettle: () => void;
    invite: import("./invite.js").Invite;
    userData: any;
    publicKey: any;
    /** @param {RequestOpts} opts */
    constructor(opts: RequestOpts);
    /**
     * Accept the candidate and reveal the resource key. Idempotent.
     *
     * @param {ConfirmOpts} opts
     * @returns {Promise<void>}
     */
    confirm({ key, encryptionKey, additional }?: ConfirmOpts): Promise<void>;
    /**
     * Reject the candidate with an optional reason. Idempotent.
     *
     * @param {string} [reason]
     * @returns {Promise<void>}
     */
    deny(reason?: string): Promise<void>;
    _respond(envelope: any): void;
}
