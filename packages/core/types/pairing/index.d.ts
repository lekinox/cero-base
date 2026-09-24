import ReadyResource from 'ready-resource';
import { Request } from './request.js';
import { Mailbox } from '../mailbox/index.js';
export type KeyPair = {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
};
export type PairingOpts = {
    /**
     * The device's mailbox: replies are sent from there.
     */
    mailbox: Mailbox;
    /**
     * The database the invites open. Its `invites` collection holds them, and apply admits their joins.
     */
    db: import('../database/index.js').Database;
};
export type InviteOpts = {
    /**
     * Role granted, at most your own.
     */
    role?: string;
    /**
     * How long it is valid: ms, or `'12h'`, `'2d'`… Never expires when omitted.
     */
    ttl?: number | string;
    /**
     * Admit more than one joiner. Otherwise spent by the first.
     */
    reuse?: boolean;
    /**
     * Its joins wait for a member to accept them, as `candidate`s.
     */
    confirm?: boolean;
    /**
     * The app's payload in the invite, readable before joining: `Invite.parse(invite).data`.
     */
    data?: Uint8Array | null;
};
export type JoinOpts = {
    /**
     * Who joins: the member they become, and who signs the join.
     */
    identity: import('../identity/index.js').Identity;
    /**
     * The database's spec: the join is one of its ops.
     */
    spec: {
        dispatch: {
            encode: Function;
        };
        meta?: {
            ns?: string;
            version?: number;
        };
    };
    /**
     * Their writer keypair in the database, a fresh one by default. The join is its first block and its secret key owns the reply address: pass the same one to resume a join after a restart.
     */
    writer?: KeyPair;
    /**
     * Deadline for the reply, in ms; `0` waits until the invite expires, or for good. Defaults to 30000.
     */
    timeout?: number;
    /**
     * Stops the join, rejecting it with `CLOSED`, as closing the mailbox does.
     */
    signal?: AbortSignal;
};
export type JoinResult = {
    key: Uint8Array;
    encryptionKey: Uint8Array | null;
    epochs: Array<{
        epoch: number;
        stamp: number;
        entropy: Uint8Array;
    }>;
    /**
     * The writer the join admitted: open the database with it.
     */
    writer: KeyPair;
};
/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array }} KeyPair
 *
 * @typedef {object} PairingOpts
 * @property {Mailbox} mailbox                      The device's mailbox: replies are sent from there.
 * @property {import('../database/index.js').Database} db  The database the invites open. Its `invites` collection holds them, and apply admits their joins.
 *
 * @typedef {object} InviteOpts
 * @property {string} [role]                        Role granted, at most your own.
 * @property {number | string} [ttl]                How long it is valid: ms, or `'12h'`, `'2d'`… Never expires when omitted.
 * @property {boolean} [reuse]                      Admit more than one joiner. Otherwise spent by the first.
 * @property {boolean} [confirm]                    Its joins wait for a member to accept them, as `candidate`s.
 * @property {Uint8Array | null} [data]             The app's payload in the invite, readable before joining: `Invite.parse(invite).data`.
 *
 * @typedef {object} JoinOpts
 * @property {import('../identity/index.js').Identity} identity  Who joins: the member they become, and who signs the join.
 * @property {{ dispatch: { encode: Function }, meta?: { ns?: string, version?: number } }} spec  The database's spec: the join is one of its ops.
 * @property {KeyPair} [writer]                     Their writer keypair in the database, a fresh one by default. The join is its first block and its secret key owns the reply address: pass the same one to resume a join after a restart.
 * @property {number} [timeout]                     Deadline for the reply, in ms; `0` waits until the invite expires, or for good. Defaults to 30000.
 * @property {AbortSignal} [signal]                 Stops the join, rejecting it with `CLOSED`, as closing the mailbox does.
 *
 * @typedef {object} JoinResult
 * @property {Uint8Array} key
 * @property {Uint8Array | null} encryptionKey
 * @property {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} epochs
 * @property {KeyPair} writer                       The writer the join admitted: open the database with it.
 */
/**
 * Invites into a database. An invite is a record in the database; a joiner writes one signed
 * `join` op into its own writer core and announces it to the database's peers, and apply admits
 * it. Every device of a member that may invite then replies with the keys. A `confirm` invite's
 * joins wait as `candidate`s until a member accepts or denies them.
 * `Pairing.join` is the other side: write the join, wait for the reply.
 */
export declare class Pairing extends ReadyResource {
    mailbox: Mailbox;
    db: import("../index.js").Database;
    /** @type {Set<Request>} candidates not settled yet: whoever attaches after one fired goes through these first */
    pending: Set<Request>;
    /** Whether this device answers the database's joins: it may invite and invites exist. */
    serving: boolean;
    _requests: Map<any, any>;
    _welcomed: Set<any>;
    _expiry: number;
    _onupdate: (touched: any) => void;
    _onjoin: (join: any) => Promise<void>;
    /** @param {PairingOpts} [opts] */
    constructor({ mailbox, db }?: PairingOpts);
    _open(): Promise<void>;
    _close(): Promise<void>;
    /**
     * Mint an invite. Returns its wire form, a z32 string.
     *
     * @param {InviteOpts} [opts]
     * @returns {Promise<string>}
     */
    invite({ role, ttl, reuse, confirm, data }?: InviteOpts): Promise<string>;
    /**
     * Revoke an invite, for every member. Needs the remove permission.
     *
     * @param {string} invite
     * @returns {Promise<boolean>}  Whether it was live.
     */
    revoke(invite: string): Promise<boolean>;
    _sync(): Promise<void>;
    _arm(invites: any): void;
    _candidates(invites: any): Promise<void>;
    _welcome({ writer, reply, expires }: {
        expires: any;
        reply: any;
        writer: any;
    }): Promise<void>;
    _me(): Promise<any>;
    _checkGrant(role: any): Promise<void>;
    /**
     * Join with an invite: write the join into the writer's own core, announce it to the
     * database's peers, and resolve with the database's keys once a member replies.
     *
     * @param {Mailbox} mailbox
     * @param {string} invite
     * @param {JoinOpts} opts
     * @returns {Promise<JoinResult>}
     */
    static join(mailbox: Mailbox, invite: string, { identity, spec, writer, timeout, signal }?: JoinOpts): Promise<JoinResult>;
}
