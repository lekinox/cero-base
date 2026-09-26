import { RPCClient } from '@cero-base/core/rpc';
import * as verbs from '../lib/operators.js';
import { t, schema } from '../lib/spec.js';
export declare const put: typeof verbs.put, set: typeof verbs.set, get: typeof verbs.get, del: typeof verbs.del, watch: typeof verbs.watch, call: typeof verbs.call, open: typeof verbs.open, invite: typeof verbs.invite, revoke: typeof verbs.revoke, rotate: typeof verbs.rotate, accept: typeof verbs.accept, deny: typeof verbs.deny, leave: typeof verbs.leave, close: typeof verbs.close, cancel: typeof verbs.cancel, suspend: typeof verbs.suspend, resume: typeof verbs.resume, activate: typeof verbs.activate, deactivate: typeof verbs.deactivate, phrase: typeof verbs.phrase, nearby: typeof verbs.nearby;
export { t, schema };
export type BaseRPCClient = import('@cero-base/core/rpc').RPCClient;
export type RefInfo = import('../lib/spec.js').RefInfo;
export type Spec = import('../lib/spec.js').Spec;
export type Row = import('../lib/spec.js').Row;
export type SingleResult = import('../lib/operators.js').SingleResult;
export type ListResult = import('../lib/operators.js').ListResult;
export type HandleStub = {
    id: string;
    type: string;
    name: string | null;
};
/**
 * Re-initialize a `Client` from a recovery phrase. Closes the existing
 * local state and reseeds identity from the phrase.
 *
 * @param {Client} me
 * @param {string} phrase
 * @returns {Promise<Client>}
 */
export declare function restore(me: Client, phrase: string): Promise<Client>;
/**
 * Per-device `local`-namespace surface on a Client.
 */
declare class LocalRefs {
    parent: Client;
    spec: import("@cero-base/core").Spec;
    store: this;
    /** @private */
    _local;
    /** @param {Client} client */
    constructor(client: Client);
    /** Underlying RPC channel borrowed from the parent. */
    get rpc(): object;
    /**
     * The root's id: local ops resolve against the root's local store.
     *
     * @returns {string | null}
     */
    get id(): string | null;
}
/**
 * IPC-side RPC client for cero. Wraps an `hrpc` channel and exposes the same
 * handle/ref/row API as a local cero instance, transparently routing every operation
 * across the wire.
 */
export declare class Client extends RPCClient {
    /** @private */
    _onerror;
    /** @type {string | null} */
    id: string | null;
    /** @type {{ id: string, name: string | null } | null} */
    device: {
        id: string;
        name: string | null;
    } | null;
    store: this;
    local: LocalRefs;
    /** @private */
    _fileBase;
    /** @private */
    _fileToken;
    /**
     * @param {import('streamx').Duplex} ipc  Framed IPC stream (must be writable).
     * @param {Spec} spec  Compiled cero spec (schema + rpc + handles).
     * @param {{ onerror?: (err: Error) => void }} [opts]  Where the worker's background errors go; the console without one.
     */
    constructor(ipc: import('streamx').Duplex, spec: Spec, { onerror }?: {
        onerror?: (err: Error) => void;
    });
    /** @private */
    private _pumpErrors;
    /** @private */
    private _open;
    /**
     * Create a new child handle of the given type.
     *
     * @param {string} type
     * @param {{ name?: string | null }} [opts]
     * @returns {Promise<Handle>}
     * @private
     */
    private _create;
    /**
     * Load an existing child handle by id.
     *
     * @param {string} type
     * @param {string} id
     * @returns {Promise<Handle>}
     * @private
     */
    private _load;
    /**
     * Join a child handle via invite.
     *
     * @param {string} invite
     * @param {string} type
     * @returns {Promise<Handle>}
     * @private
     */
    private _join;
}
/**
 * Construct a `Client`, wait for `init` to complete, and return it.
 *
 * @param {import('streamx').Duplex} ipc
 * @param {Spec} spec
 * @param {{ onerror?: (err: Error) => void }} [opts]
 * @returns {Promise<Client>}
 */
export declare function connect(ipc: import('streamx').Duplex, spec: Spec, opts?: {
    onerror?: (err: Error) => void;
}): Promise<Client>;
/**
 * Symmetric client entry. Mirrors the main `cero`, but `cero(ipc, spec)` connects to a
 * server (via `connect`) instead of opening a local store.
 *
 * @param {import('streamx').Duplex} ipc  Framed IPC duplex stream.
 * @param {Spec} spec  Built cero spec.
 * @param {{ onerror?: (err: Error) => void }} [opts]
 * @returns {Promise<Client>}
 */
export declare function cero(ipc: import('streamx').Duplex, spec: Spec, opts?: {
    onerror?: (err: Error) => void;
}): Promise<Client>;
