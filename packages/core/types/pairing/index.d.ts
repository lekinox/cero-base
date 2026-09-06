import ReadyResource from 'ready-resource';
export type PairingOpts = {
    /**
     * Network to host the BlindPairing member.
     */
    network: import('../network/index.js').Network;
    /**
     * Identity used to sign invites and derive the topic.
     */
    identity: import('../identity/index.js').Identity;
    /**
     * Optional override topic; defaults to `identity.publicKey`.
     */
    topic?: Uint8Array;
    /**
     * Register the member listener that serves invites (default `true`). Join-only pairings pass `false` — a listener is one-per-topic, so a joiner registering one collides with any concurrent join.
     */
    host?: boolean;
    /**
     * compact-encoding type for the invite payload `data`.
     */
    inviteEncoding?: any;
    /**
     * compact-encoding type for the joiner-supplied `userData`.
     */
    joinerEncoding?: any;
    /**
     * Called when a background candidate fails to process.
     */
    onerror?: (err: Error) => void;
};
export type CreateInviteOpts = {
    /**
     * Role tag bound into the invite.
     */
    role?: string;
    /**
     * TTL in ms; `0`/omitted = no expiry.
     */
    expiresIn?: number;
    /**
     * Arbitrary payload (encoded via `inviteEncoding` when set).
     */
    data?: any;
    /**
     * Reusable until expiry/revoke; default `false` (consumed on first settle).
     */
    reuse?: boolean;
};
export type JoinOpts = {
    /**
     * Payload sent with the candidate request. Required: blind-pairing derives the handshake token from it, so a candidate without one is never served.
     */
    userData: any;
    /**
     * Deadline for the handshake, in ms. Defaults to 30000.
     */
    timeout?: number;
};
export type JoinResult = {
    key: Uint8Array;
    encryptionKey: Uint8Array | null;
    additional: Uint8Array | null;
};
/**
 * @typedef {object} PairingOpts
 * @property {import('../network/index.js').Network} network         Network to host the BlindPairing member.
 * @property {import('../identity/index.js').Identity} identity      Identity used to sign invites and derive the topic.
 * @property {Uint8Array} [topic]                                    Optional override topic; defaults to `identity.publicKey`.
 * @property {boolean} [host]                                        Register the member listener that serves invites (default `true`). Join-only pairings pass `false` — a listener is one-per-topic, so a joiner registering one collides with any concurrent join.
 * @property {any} [inviteEncoding]                                  compact-encoding type for the invite payload `data`.
 * @property {any} [joinerEncoding]                                  compact-encoding type for the joiner-supplied `userData`.
 * @property {(err: Error) => void} [onerror]                        Called when a background candidate fails to process.
 *
 * @typedef {object} CreateInviteOpts
 * @property {string} [role]                                         Role tag bound into the invite.
 * @property {number} [expiresIn]                                    TTL in ms; `0`/omitted = no expiry.
 * @property {any} [data]                                            Arbitrary payload (encoded via `inviteEncoding` when set).
 * @property {boolean} [reuse]                                       Reusable until expiry/revoke; default `false` (consumed on first settle).
 *
 * @typedef {object} JoinOpts
 * @property {any} userData                                          Payload sent with the candidate request. Required: blind-pairing derives the handshake token from it, so a candidate without one is never served.
 * @property {number} [timeout]                                      Deadline for the handshake, in ms. Defaults to 30000.
 *
 * @typedef {{ key: Uint8Array, encryptionKey: Uint8Array | null, additional: Uint8Array | null }} JoinResult
 */
/**
 * Blind-pairing membership wrapper. Hosts invites, dispatches incoming candidates to the
 * application for accept/deny, and provides the joiner side of the handshake.
 */
export declare class Pairing extends ReadyResource {
    network: import("../index.js").Network;
    identity: import("../index.js").Identity;
    topic: Uint8Array<ArrayBufferLike>;
    host: boolean;
    inviteEncoding: any;
    joinerEncoding: any;
    _onerror: (err: Error) => void;
    onconsume: any;
    _blind: any;
    _member: any;
    _invites: Map<any, any>;
    _candidates: Set<any>;
    /** @param {PairingOpts} [opts] */
    constructor({ network, identity, topic, host, inviteEncoding, joinerEncoding, onerror, onconsume }?: PairingOpts);
    /**
     * Whether the underlying blind-pairing layer is suspended.
     *
     * @returns {boolean}
     */
    get suspended(): boolean;
    _open(): Promise<void>;
    _close(): Promise<void>;
    /**
     * Mint a new pairing invite. Returns its canonical wire form (z32 string).
     *
     * @param {CreateInviteOpts} [opts]
     * @returns {Promise<string>}
     */
    createInvite({ role, expiresIn, data, reuse }?: CreateInviteOpts): Promise<string>;
    /**
     * Look up the in-memory record for a minted invite by its string form.
     *
     * @param {string} inviteStr
     * @returns {{ id: Uint8Array, seed: Uint8Array, publicKey: Uint8Array, invite: import('./invite.js').Invite, reuse: boolean } | null}
     */
    recordOf(inviteStr: string): {
        id: Uint8Array;
        seed: Uint8Array;
        publicKey: Uint8Array;
        invite: import('./invite.js').Invite;
        reuse: boolean;
    } | null;
    /**
     * Reconcile the served-invite set with persisted rows (the room's `invites` collection).
     *
     * @param {Array<{ id: string, invite: Uint8Array, publicKey: Uint8Array, seed: Uint8Array, reuse?: boolean }>} rows
     */
    syncRows(rows: Array<{
        id: string;
        invite: Uint8Array;
        publicKey: Uint8Array;
        seed: Uint8Array;
        reuse?: boolean;
    }>): void;
    /**
     * Forget a previously-minted invite. New candidates carrying it will be
     * dropped silently.
     *
     * @param {string} inviteStr
     * @returns {boolean}
     */
    revoke(inviteStr: string): boolean;
    /**
     * Joiner side — start a pairing handshake against `inviteStr` and resolve
     * with the host's response when the host confirms.
     *
     * @param {string} inviteStr
     * @param {JoinOpts} [opts]
     * @returns {Promise<JoinResult>}
     */
    join(inviteStr: string, { userData, timeout }?: JoinOpts): Promise<JoinResult>;
    /**
     * Pause blind-pairing — keeps state, drops sockets. Idempotent.
     *
     * @returns {Promise<void>}
     */
    suspend(): Promise<void>;
    /**
     * Resume a suspended blind-pairing layer. Idempotent.
     *
     * @returns {Promise<void>}
     */
    resume(): Promise<void>;
    _oncandidate(req: any): Promise<void>;
    /**
     * Resolve the resource discovery key an invite targets — without pairing.
     *
     * @param {string} invite
     * @returns {Uint8Array | null}
     */
    static inviteTopic(invite: string): Uint8Array | null;
    /**
     * Cheap structural test for a candidate invite string.
     *
     * @param {unknown} str
     * @returns {boolean}
     */
    static isInvite(str: unknown): boolean;
}
