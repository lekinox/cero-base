export declare const STATUS_ACCEPTED = 0;
export declare const STATUS_DENIED = 1;
export declare const Response: {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        key: any;
        length: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        invite: any;
        reply: any;
        proof: any;
        identity: any;
        signature: any;
        ts: any;
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
     * The record of the invite the joiner used.
     */
    invite: {
        id: string;
        role: string;
        expires?: number;
    };
    /**
     * The waiting join, as the database keeps it.
     */
    row: {
        id: string;
        identity: Uint8Array;
        reply: Uint8Array;
    };
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
 * @property {{ id: string, role: string, expires?: number }} invite  The record of the invite the joiner used.
 * @property {{ id: string, identity: Uint8Array, reply: Uint8Array }} row  The waiting join, as the database keeps it.
 *
 * @typedef {object} AcceptOpts
 * @property {string} [role]                                         Role granted: the invite's by default, at most the invite's.
 */
/**
 * A join on a `confirm` invite, waiting in the database for a member to accept or deny it.
 */
export declare class Request {
    pairing: import("./index.js").Pairing;
    invite: {
        id: string;
        role: string;
        expires?: number;
    };
    id: string;
    identity: Uint8Array<ArrayBufferLike>;
    writer: any;
    _reply: Uint8Array<ArrayBufferLike>;
    _settled: boolean;
    /** @param {RequestOpts} opts */
    constructor({ pairing, invite, row }: RequestOpts);
    /**
     * Admit the joiner. Every device of an inviter then replies with the keys. Idempotent.
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
}
