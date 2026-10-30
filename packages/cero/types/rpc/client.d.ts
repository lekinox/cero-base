import { Readable } from 'streamx';
import { RPCClient } from '@cero-base/core/rpc';
import { Ref } from '../lib/refs.js';
import * as verbs from '../lib/operators.js';
import { t, schema } from '../lib/spec.js';
declare const remote: {
    put(ref: verbs.Ref, row: verbs.Row): Promise<verbs.SingleResult>;
    set(ref: verbs.Ref, row: verbs.Row, opts?: {
        upsert?: boolean;
    }): Promise<verbs.SingleResult | null>;
    del(ref: verbs.Ref, id?: string): Promise<void>;
    call(ref: verbs.Ref, d?: verbs.Row): Promise<void>;
    get(ref: verbs.Ref, q?: string | Record<string, unknown>): Promise<verbs.SingleResult | verbs.ListResult>;
    watch(ref: verbs.Ref, query?: string | (Record<string, unknown> & {
        changes?: boolean;
    }), opts?: {
        signal?: AbortSignal;
    }): import('streamx').Readable;
    open(ref: verbs.Ref, arg?: string | {
        invite?: string;
        id?: string;
        name?: string;
    } | undefined): Promise<verbs.Context>;
    invite(ctx: verbs.Context, opts?: import("@cero-base/core").InviteOpts): Promise<string>;
    revoke(ctx: verbs.Context, code: string): Promise<boolean>;
    rotate(ctx: verbs.Context): Promise<{
        epoch: number;
    }>;
    accept(ctx: verbs.Context, request: {
        id: string;
    }, { role }?: {
        role?: string;
    }): Promise<void>;
    deny(ctx: verbs.Context, request: {
        id: string;
    }, reason?: string): Promise<void>;
    leave(ctx: verbs.Context): Promise<void>;
    close(ctx: verbs.Context): Promise<void>;
    cancel(me: verbs.Context, code: string): Promise<boolean>;
    suspend(me: verbs.Context): Promise<void>;
    resume(me: verbs.Context): Promise<void>;
    activate(ctx: verbs.Context): Promise<void>;
    deactivate(ctx: verbs.Context): Promise<void>;
    receive(me: verbs.Context, payload: Uint8Array): Promise<{
        id: string;
        type: string;
        name: string | null;
        newer: boolean;
        ref: string | null;
        row: object | null;
    } | null>;
    send(me: verbs.Context, address: string, data: unknown, opts?: {
        keep?: boolean;
    }): Promise<void>;
    inbox(me: verbs.Context, secret: Uint8Array, fn: (data: unknown, sender: {
        from: string;
        device: string;
    }) => unknown, opts?: {
        keep?: boolean;
    }): () => Promise<void>;
    phrase(me: verbs.Context): Promise<string>;
    nearby(ctx: verbs.Context, on: boolean, opts?: {
        topic?: string;
    }): Promise<void>;
};
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
export type Context = (Client | Handle) & Record<string, Ref>;
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
 * Link the app to the identity behind a device invite, as `cero.link` does in the worker: the
 * client is then that identity. `onrequest` gets the request's id as it is sent.
 *
 * @param {Client} me
 * @param {string} invite
 * @param {{ onrequest?: (id: string) => void }} [opts]
 * @returns {Promise<Client>}
 */
export declare function link(me: Client, invite: string, { onrequest }?: {
    onrequest?: (id: string) => void;
}): Promise<Client>;
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
    _push;
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
    _unfollow: () => void;
    /** @private */
    _fileBase;
    /** @private */
    _fileToken;
    /**
     * @param {import('streamx').Duplex} ipc  Framed IPC stream (must be writable).
     * @param {Spec} spec  Compiled cero spec (schema + rpc + handles).
     * @param {{ onerror?: (err: Error) => void, push?: import('./push.js').Messaging }} [opts]  Where the worker's background errors go, the console without one; `push`: the platform's messaging service, to follow the handles' push topics.
     */
    constructor(ipc: import('streamx').Duplex, spec: Spec, { onerror, push }?: {
        onerror?: (err: Error) => void;
        push?: import('./push.js').Messaging;
    });
    /** @private */
    private _pumpErrors;
    /** @private */
    private _open;
    /** @private */
    private _close;
    /** @private */
    private _identify;
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
 * Client-side proxy for a remote handle. Exposes the same row-ops surface as `Client` but
 * scoped to a single child handle id, and routes every call through the parent's RPC
 * channel.
 */
declare class Handle {
    parent: Client;
    id: string;
    type: string;
    name: string;
    spec: import("../lib/spec.js").Spec;
    store: this;
    /**
     * @param {Client} parent
     * @param {string} id
     * @param {string} type
     * @param {string|null} name
     */
    constructor(parent: Client, id: string, type: string, name: string | null);
    /** Underlying RPC channel borrowed from the parent. */
    get rpc(): object;
    close(): any;
}
/**
 * Construct a `Client`, wait for `init` to complete, and return it.
 *
 * @param {import('streamx').Duplex} ipc
 * @param {Spec} spec
 * @param {{ onerror?: (err: Error) => void, push?: import('./push.js').Messaging }} [opts]
 * @returns {Promise<Client>}
 */
export declare function connect(ipc: import('streamx').Duplex, spec: Spec, opts?: {
    onerror?: (err: Error) => void;
    push?: import('./push.js').Messaging;
}): Promise<Client>;
/**
 * Symmetric client entry. Mirrors the main `cero`, but `cero(ipc, spec)` connects to a
 * server (via `connect`) instead of opening a local store.
 *
 * @param {import('streamx').Duplex} ipc  Framed IPC duplex stream.
 * @param {Spec} spec  Built cero spec.
 * @param {{ onerror?: (err: Error) => void, push?: import('./push.js').Messaging }} [opts]
 * @returns {Promise<Context>}
 */
declare function start(ipc: import('streamx').Duplex, spec: Spec, opts?: {
    onerror?: (err: Error) => void;
    push?: import('./push.js').Messaging;
}): Promise<Context>;
/** @type {typeof start & typeof remote & { connect: typeof connect, restore: typeof restore, link: typeof link, t: typeof t, schema: typeof schema }} */
export declare const cero: typeof start & typeof remote & {
    connect: typeof connect;
    restore: typeof restore;
    link: typeof link;
    t: typeof t;
    schema: typeof schema;
};
