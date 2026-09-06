/**
 * Internal — the joiner side: a candidate's handshake state machine (this *is* the
 * blind-pairing `addCandidate`).
 *
 * @property {any} _candidate                         blind-pairing addCandidate handle (null until started).
 * @property {ReturnType<typeof setTimeout> | null} _timer   Pending timeout, if any.
 * @property {((result: any) => void) | null} _resolve   Promise resolver, set in `start`.
 * @property {((err: Error) => void) | null} _reject           Promise rejecter, set in `start`.
 * @property {boolean} _settled                       Whether the handshake has already settled.
 */
export declare class Candidate {
    pairing: import("./index.js").Pairing;
    invite: import("./invite.js").Invite;
    userData: Uint8Array<ArrayBufferLike>;
    timeout: number;
    _candidate: any;
    _timer: number;
    _resolve: (value: import("./index.js").JoinResult | PromiseLike<import("./index.js").JoinResult>) => void;
    _reject: (reason?: any) => void;
    _settled: boolean;
    /**
     * @param {import('./index.js').Pairing} pairing
     * @param {import('./invite.js').Invite} invite
     * @param {Uint8Array | null} userData
     * @param {number} timeout
     */
    constructor(pairing: import('./index.js').Pairing, invite: import('./invite.js').Invite, userData: Uint8Array | null, timeout: number);
    /**
     * Kick off the handshake; returns a promise that settles with the host response.
     *
     * @returns {Promise<import('./index.js').JoinResult>}
     */
    start(): Promise<import('./index.js').JoinResult>;
    _done(result: any): void;
    _fail(err: any): void;
}
