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
     * Per-device id (empty when no `local` spec).
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
 * @property {string} deviceId  Per-device id (empty when no `local` spec).
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
    /** @private */
    _booting;
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
     * Wire the `restore` handler. The phrase becomes a seed here: the UI cannot load the crypto it takes.
     * @private
     */
    private _wireRestore;
    /**
     * Register the row-level RPC handlers (put/set/get/del/watch/call).
     * @private
     */
    private _wireData;
    /**
     * Register invite/revoke/join RPC handlers.
     * @private
     */
    private _wirePairing;
    /**
     * Register add/open/close/leave RPC handlers for child handles.
     * @private
     */
    private _wireHandles;
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
    /**
     * Wire the on-demand `seed` handler — surfaces the recovery phrase only when asked.
     * @private
     */
    private _wireSeed;
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
