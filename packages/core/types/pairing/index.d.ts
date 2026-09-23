import ReadyResource from 'ready-resource';
import { Request } from './request.js';
import { Mailbox } from '../mailbox/index.js';
import { Identity } from '../identity/index.js';
export type KeyPair = {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
};
export type PairingOpts = {
    /**
     * The device's mailbox: knocks are received there, replies sent from there.
     */
    mailbox: Mailbox;
    /**
     * The database the invites open. Its `invites` collection holds them, so every member serves them.
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
     * Admit more than one joiner. Otherwise consumed by the first.
     */
    reuse?: boolean;
    /**
     * The app's payload in the invite, readable before joining: `Invite.parse(invite).data`.
     */
    data?: Uint8Array | null;
};
export type Served = {
    /**
     * The invite's id, hex.
     */
    id: string;
    /**
     * Owns the address knocks arrive at; never the seed that proves one.
     */
    secret: Uint8Array;
    role: string;
    /**
     * Absolute expiry; `0` never.
     */
    expires: number;
    reuse: boolean;
    expired: boolean;
    /**
     * Where its knocks arrive, on this member.
     */
    inbox: {
        close: () => Promise<void>;
    };
};
export type JoinOpts = {
    /**
     * Who joins: the member they become, and who signs the knock.
     */
    identity: Identity;
    /**
     * Their writer keypair in the database, a fresh one by default. Its secret key owns the reply address: pass the same one to resume a join after a restart.
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
     * The writer the member admitted: open the database with it.
     */
    writer: KeyPair;
};
/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array }} KeyPair
 *
 * @typedef {object} PairingOpts
 * @property {Mailbox} mailbox                      The device's mailbox: knocks are received there, replies sent from there.
 * @property {import('../database/index.js').Database} db  The database the invites open. Its `invites` collection holds them, so every member serves them.
 *
 * @typedef {object} InviteOpts
 * @property {string} [role]                        Role granted, at most your own.
 * @property {number | string} [ttl]                How long it is valid: ms, or `'12h'`, `'2d'`… Never expires when omitted.
 * @property {boolean} [reuse]                      Admit more than one joiner. Otherwise consumed by the first.
 * @property {Uint8Array | null} [data]             The app's payload in the invite, readable before joining: `Invite.parse(invite).data`.
 *
 * @typedef {object} Served                         An invite as the database keeps it.
 * @property {string} id                            The invite's id, hex.
 * @property {Uint8Array} secret                    Owns the address knocks arrive at; never the seed that proves one.
 * @property {string} role
 * @property {number} expires                       Absolute expiry; `0` never.
 * @property {boolean} reuse
 * @property {boolean} expired
 * @property {{ close: () => Promise<void> }} inbox  Where its knocks arrive, on this member.
 *
 * @typedef {object} JoinOpts
 * @property {Identity} identity                    Who joins: the member they become, and who signs the knock.
 * @property {KeyPair} [writer]                     Their writer keypair in the database, a fresh one by default. Its secret key owns the reply address: pass the same one to resume a join after a restart.
 * @property {number} [timeout]                     Deadline for the reply, in ms; `0` waits until the invite expires, or for good. Defaults to 30000.
 * @property {AbortSignal} [signal]                 Stops the join, rejecting it with `CLOSED`, as closing the mailbox does.
 *
 * @typedef {object} JoinResult
 * @property {Uint8Array} key
 * @property {Uint8Array | null} encryptionKey
 * @property {Array<{ epoch: number, stamp: number, entropy: Uint8Array }>} epochs
 * @property {KeyPair} writer                       The writer the member admitted: open the database with it.
 */
/**
 * Invites into a database. It keeps them in the database, so every member serves them; each
 * invite has its own address, and a knock there that proves both the invite and the joiner's
 * identity becomes a `candidate`, kept in the mailbox until it is accepted or denied.
 * `Pairing.join` is the other side: knock with an invite, wait for the reply.
 */
export declare class Pairing extends ReadyResource {
    mailbox: Mailbox;
    db: import("../index.js").Database;
    /** @type {Set<Request>} candidates not settled yet: whoever attaches after one fired goes through these first */
    pending: Set<Request>;
    _invites: Map<any, any>;
    _onupdate: (touched: any) => void;
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
    invite({ role, ttl, reuse, data }?: InviteOpts): Promise<string>;
    /**
     * Stop serving an invite, on every member. Needs the remove permission.
     *
     * @param {string} invite
     * @returns {Promise<boolean>}  Whether it was served.
     */
    revoke(invite: string): Promise<boolean>;
    _sync(): Promise<void>;
    _drop(id: any): void;
    _onknock(message: any): Promise<void>;
    _consume(id: any): Promise<void>;
    _me(): Promise<any>;
    _checkGrant(role: any): Promise<void>;
    /**
     * Knock with an invite and resolve with the database's keys once a member accepts.
     *
     * @param {Mailbox} mailbox
     * @param {string} invite
     * @param {JoinOpts} opts
     * @returns {Promise<JoinResult>}
     */
    static join(mailbox: Mailbox, invite: string, { identity, writer, timeout, signal }?: JoinOpts): Promise<JoinResult>;
}
