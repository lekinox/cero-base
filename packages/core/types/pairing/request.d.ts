export declare const STATUS_ACCEPTED = 0;
export declare const STATUS_DENIED = 1;
export declare const Response: {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        id: any;
        reply: any;
        proof: any;
        identity: any;
        writer: any;
        signature: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        epoch: any;
        stamp: any;
        entropy: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        status: any;
        reason: any;
        key: any;
        encryptionKey: any;
        epochs: any;
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
        prev: any;
        next: any;
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
};
export type RequestOpts = {
    /**
     * Owning Pairing instance.
     */
    pairing: import('./index.js').Pairing;
    /**
     * Invite the joiner knocked with.
     */
    invite: import('./index.js').Served;
    /**
     * The joiner's reply address.
     */
    reply: Uint8Array;
    /**
     * The joiner's identity key.
     */
    identity: Uint8Array;
    /**
     * The joiner's writer key in the database.
     */
    writer: Uint8Array;
    /**
     * Called once when the request is accepted or denied.
     */
    onsettle: () => unknown;
};
export type AcceptOpts = {
    /**
     * Role granted: the invite's by default, at most the invite's.
     */
    role?: string;
};
/**
 * @typedef {object} RequestOpts
 * @property {import('./index.js').Pairing} pairing                  Owning Pairing instance.
 * @property {import('./index.js').Served} invite                    Invite the joiner knocked with.
 * @property {Uint8Array} reply                                      The joiner's reply address.
 * @property {Uint8Array} identity                                   The joiner's identity key.
 * @property {Uint8Array} writer                                     The joiner's writer key in the database.
 * @property {() => unknown} onsettle                                Called once when the request is accepted or denied.
 *
 * @typedef {object} AcceptOpts
 * @property {string} [role]                                         Role granted: the invite's by default, at most the invite's.
 */
/**
 * A joiner's knock, waiting to be accepted or denied.
 */
export declare class Request {
    pairing: import("./index.js").Pairing;
    _replyTo: Uint8Array<ArrayBufferLike>;
    _settled: boolean;
    _onsettle: () => unknown;
    invite: import("./index.js").Served;
    identity: Uint8Array<ArrayBufferLike>;
    writer: Uint8Array<ArrayBufferLike>;
    /** @param {RequestOpts} opts */
    constructor(opts: RequestOpts);
    /**
     * Admit the joiner, then send it the database's keys and epochs, so it reads the history from
     * before it joined. The keys go out only once the admission landed. Idempotent.
     *
     * @param {AcceptOpts} [opts]
     * @returns {Promise<void>}
     */
    accept({ role }?: AcceptOpts): Promise<void>;
    /**
     * Refuse the joiner, with an optional reason. Idempotent.
     *
     * @param {string} [reason]
     * @returns {Promise<void>}
     */
    deny(reason?: string): Promise<void>;
    _respond(envelope: any): Promise<void>;
}
