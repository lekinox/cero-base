import { RPCServer } from '@cero-base/core/rpc';
export type BaseRPCServer = import('@cero-base/core/rpc').RPCServer;
export type ServerOpts = {
    /**
     * Directory passed to `cero()` for the local store.
     */
    storage: string;
    /**
     * Optional display name forwarded to `cero()`.
     */
    name?: string;
    /**
     * Custom DHT bootstrap.
     */
    bootstrap?: Array<{
        host: string;
        port: number;
    }>;
    isMobile?: boolean;
    onerror?: (err: Error) => void;
};
export type Identity = {
    /**
     * Long-lived cero identity id.
     */
    id: string;
    /**
     * Per-device id.
     */
    deviceId: string;
    /**
     * This device's name, empty when it has none.
     */
    deviceName: string;
};
export type RefAndCodec = {
    ref: import('../lib/refs.js').Ref;
    codec: import('@cero-base/core/rpc').Codec;
    info?: import('../lib/spec.js').RefInfo;
};
export type Spec = import('../lib/spec.js').Spec;
export type Context = import('../handle/index.js').Context;
export type GetResult = {
    data: import('../lib/spec.js').Row | import('../lib/spec.js').Row[] | null;
    total?: number;
    size?: number;
};
/**
 * @typedef {import('@cero-base/core/rpc').RPCServer} BaseRPCServer
 *
 * @typedef {object} ServerOpts
 * @property {string} storage   Directory passed to `cero()` for the local store.
 * @property {string} [name]    Optional display name forwarded to `cero()`.
 * @property {Array<{ host: string, port: number }>} [bootstrap]  Custom DHT bootstrap.
 * @property {boolean} [isMobile]
 * @property {(err: Error) => void} [onerror]
 *
 * @typedef {object} Identity
 * @property {string} id        Long-lived cero identity id.
 * @property {string} deviceId  Per-device id.
 * @property {string} deviceName  This device's name, empty when it has none.
 *
 * @typedef {{ ref: import('../lib/refs.js').Ref, codec: import('@cero-base/core/rpc').Codec, info?: import('../lib/spec.js').RefInfo }} RefAndCodec
 *
 * @typedef {import('../lib/spec.js').Spec} Spec
 * @typedef {import('../handle/index.js').Context} Context
 *
 * @typedef {{ data: import('../lib/spec.js').Row | import('../lib/spec.js').Row[] | null, total?: number, size?: number }} GetResult  Single-ref get omits `total`/`size`; list/handle refs include them.
 */
/**
 * IPC-side RPC server for cero. Bridges an `hrpc` channel to a live `Handle` tree: boots the
 * root via `cero()` as soon as it opens, so the network is up while the UI still loads, then
 * exposes data ops, pairing, and handle lifecycle.
 */
export declare class Server extends RPCServer {
    storage: string;
    /** @private */
    _report;
    /** @type {Omit<Partial<ServerOpts>, 'storage'> & { onerror: (err: Error) => void }} */
    opts: Omit<Partial<ServerOpts>, 'storage'> & {
        onerror: (err: Error) => void;
    };
    /** @type {Set<object>} open error streams, one per connected client */
    _errors: Set<object>;
    /** @type {Context | null} */
    me: Context | null;
    /** @type {Map<string, Context>} */
    handles: Map<string, Context>;
    /** @type {Map<string, Set<object>>} handle id → its open watch streams */
    _watchStreams: Map<string, Set<object>>;
    /** @type {Map<string, number>} handle id → the opens the page holds on it, let go when it reloads */
    _held: Map<string, number>;
    /** @private */
    _booting;
    /** @private */
    _adopting;
    /**
     * @param {import('streamx').Duplex} ipc  Framed IPC stream (must be writable).
     * @param {Spec} spec
     * @param {Partial<ServerOpts>} [opts]
     */
    constructor(ipc: import('streamx').Duplex, spec: Spec, { storage, ...opts }?: Partial<ServerOpts>);
    /**
     * Root cero id (undefined until booted).
     *
     * @returns {string|undefined}
     */
    get id(): string | undefined;
    /**
     * Root identity object (undefined until booted).
     *
     * @returns {import('@cero-base/core/identity').Identity | undefined}
     */
    get identity(): import('@cero-base/core/identity').Identity | undefined;
    /** @private */
    private _open;
    /** @private */
    private _boot;
    /** @private */
    private _close;
    /**
     * The root a restore or a link resolves with is the one served from here on; with the server closing it closes.
     * @private
     */
    private _adopt;
    /**
     * End every watch stream bound to a handle (e.g. when it closes or leaves).
     * @private
     */
    private _endWatches;
    /** @private */
    private _onerror;
    /**
     * Wire the `errors` and `init` handlers: init waits for the boot and attaches the client.
     * @private
     */
    private _wireInit;
    /**
     * Wire the `restore` handler.
     * @private
     */
    private _wireRestore;
    /**
     * Wire the `link` handler: a stream, the request's id as it is sent, the identity once linked.
     * @private
     */
    private _wireLink;
    /**
     * Register the row-level RPC handlers (put/set/get/del/watch/call).
     * @private
     */
    private _wireData;
    /**
     * Register add/open/join/close/leave RPC handlers for child handles.
     * @private
     */
    private _wireHandles;
    /** @private one open the page holds on `id` */
    private _hold;
    /** @private one of the page's opens on `id` let go: the handle drops off the wire once nobody here holds it */
    private _release;
    /** @private every open the page holds let go: a reload, whose old page closes nothing */
    private _letGo;
    /**
     * Register the `verb` handler: the operator by its name, on the handle, as in the worker.
     * @private
     */
    private _wireVerbs;
    /**
     * Register a request handler whose error fails only its call.
     * @private
     */
    private _on;
    /**
     * Look up a live handle by id, throwing if unknown. Binds the handle's
     * codec on first use.
     *
     * @param {string} id
     * @returns {Context}
     * @private
     */
    private _resolve;
    /**
     * Resolve a `{ handle, ref }` pair to its `Ref` and codec.
     *
     * @param {string} id
     * @param {string} name
     * @param {boolean} [local]
     * @returns {RefAndCodec}
     * @private
     */
    private _refOf;
    /**
     * Snapshot the current identity for return to the client.
     *
     * @returns {Identity}
     * @private
     */
    private _identity;
}
/**
 * Construct a `Server`, wait for it to be ready, and return it.
 *
 * @param {import('streamx').Duplex} ipc
 * @param {Spec} spec
 * @param {ServerOpts} opts
 * @returns {Promise<Server>}
 */
export declare function serve(ipc: import('streamx').Duplex, spec: Spec, opts: ServerOpts): Promise<Server>;
