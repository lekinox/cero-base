import { RPCClient } from '@cero-base/core/rpc';
import { put, set, get, del, count, watch, changes, call, open, rotate, bind, define } from '../lib/operators.js';
import { t, schema } from '../lib/spec.js';
export { put, set, get, del, count, watch, changes, call, open, rotate, bind, define, t, schema };
export type BaseRPCClient = import('@cero-base/core/rpc').RPCClient;
export type RefInfo = {
    kind?: 'single' | 'collection' | 'action' | 'handle';
    schema?: string;
    type?: string;
    internal?: boolean;
};
export type Spec = import('@cero-base/core/rpc').Spec & {
    meta: {
        ns?: string;
        refs: Record<string, RefInfo>;
        local?: {
            refs: Record<string, RefInfo>;
        };
        handles?: Record<string, Spec>;
    };
    handles: Record<string, Spec>;
};
export type SingleResult = {
    data: any;
};
export type ListResult = {
    data: any[];
    total: number;
    size: number;
};
export type GetByIdResult = {
    data: any | null;
};
export type ClientIdentity = {
    id: string;
    toPhrase: () => string | null;
};
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
    _local: boolean;
    /** @param {Client} client */
    constructor(client: Client);
    /** Underlying RPC channel borrowed from the parent. */
    get rpc(): any;
    /** Root handle id (local ops are resolved against the root's local store). */
    get id(): any;
}
/**
 * IPC-side RPC client for cero. Wraps an `hrpc` channel and exposes the same
 * handle/ref/row API as a local cero instance, transparently routing every operation
 * across the wire.
 */
export declare class Client extends RPCClient {
    id: any;
    deviceId: any;
    store: this;
    local: LocalRefs;
    _fileBase: any;
    _fileToken: any;
    identity: {
        id: any;
        toPhrase: () => Promise<any>;
    };
    /**
     * @param {any} ipc   Framed IPC stream (must be writable).
     * @param {Spec} spec  Compiled cero spec (schema + rpc + handles).
     */
    constructor(ipc: any, spec: Spec);
    _open(): Promise<void>;
    /**
     * Create a new child handle of the given type.
     *
     * @param {string} type
     * @param {Record<string, any>} [opts]
     * @returns {Promise<Handle>}
     */
    _create(type: string, opts?: Record<string, any>): Promise<Handle>;
    /**
     * Load an existing child handle by id.
     *
     * @param {string} type
     * @param {string} id
     * @returns {Promise<Handle>}
     */
    _load(type: string, id: string): Promise<Handle>;
    /**
     * Join a child handle via invite.
     *
     * @param {string} invite
     * @param {string} type
     * @returns {Promise<Handle>}
     */
    _join(invite: string, type: string): Promise<Handle>;
}
/**
 * Client-side proxy for a remote handle. Exposes the same row-ops surface as `Client` but
 * scoped to a single child handle id, and routes every call through the parent's RPC
 * channel.
 */
declare class Handle {
    parent: Client;
    id: string;
    type: string;
    name: string;
    spec: Spec;
    store: this;
    /**
     * @param {Client} parent
     * @param {string} id
     * @param {string} type
     * @param {string|null} name
     */
    constructor(parent: Client, id: string, type: string, name: string | null);
    /** Underlying RPC channel borrowed from the parent. */
    get rpc(): any;
    /** Tear down the remote handle without leaving the room. */
    close(): any;
    /** Tear down the remote handle and drop membership. */
    leave(): any;
}
/**
 * Construct a `Client`, wait for `init` to complete, and return it.
 *
 * @param {any} ipc
 * @param {object} spec
 * @returns {Promise<Client>}
 */
export declare function connect(ipc: any, spec: object): Promise<Client>;
/**
 * Symmetric client entry. Mirrors the main `cero`, but `cero(ipc, spec)` connects to a
 * server (via `connect`) instead of opening a local store.
 *
 * @param {any} ipc    Framed IPC duplex stream.
 * @param {any} spec   Built cero spec.
 * @returns {Promise<Client>}
 */
export declare function cero(ipc: any, spec: any): Promise<Client>;
export declare namespace cero {
    export { connect };
    export { restore };
    export { t };
    export { put };
    export { set };
    export { get };
    export { del };
    export { count };
    export { watch };
    export { changes };
    export { call };
    export { open };
    export { rotate };
    export { bind };
    export { define };
    export { schema };
}
