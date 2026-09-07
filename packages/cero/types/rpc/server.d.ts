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
};
export type RefAndCodec = {
    ref: any;
    codec: any;
};
export type GetResult = {
    data: any;
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
 *
 * @typedef {{ ref: any, codec: any }} RefAndCodec
 *
 * @typedef {{ data: any, total?: number, size?: number }} GetResult  Single-ref get omits `total`/`size`; list/handle refs include them.
 */
/**
 * IPC-side RPC server for cero. Bridges an `hrpc` channel to a live `Handle` tree:
 * lazy-initializes the root via `cero()` on the first `init` call, then exposes data ops,
 * pairing, and handle lifecycle.
 */
export declare class Server extends RPCServer {
    storage: string;
    opts: {
        name?: string;
        bootstrap?: Array<{
            host: string;
            port: number;
        }>;
        isMobile?: boolean;
        onerror?: (err: Error) => void;
    };
    me: import("../handle/index.js").CeroHandle;
    handles: Map<any, any>;
    /** @type {Map<string, Set<object>>} handle id → its open watch streams */
    _watchStreams: Map<string, Set<object>>;
    /**
     * @param {any} ipc                Framed IPC stream (must be writable).
     * @param {object} spec
     * @param {Partial<ServerOpts>} [opts]
     */
    constructor(ipc: any, spec: object, { storage, ...opts }?: Partial<ServerOpts>);
    /**
     * Root cero id (null until `init` has run).
     *
     * @returns {string|undefined}
     */
    get id(): string | undefined;
    /**
     * Root identity object (null until `init` has run).
     *
     * @returns {any}
     */
    get identity(): any;
    _close(): Promise<void>;
    /** End every watch stream bound to a handle (e.g. when it closes or leaves). */
    _endWatches(handle: any): void;
    /** Wire the `init` handler that lazily constructs the root cero handle. */
    _wireInit(): void;
    /** Wire the `restore` handler that rebuilds the local store from a phrase. */
    _wireRestore(): void;
    /** Register the row-level RPC handlers (put/set/get/del/watch/call). */
    _wireData(): void;
    /** Register invite/revoke/join RPC handlers. */
    _wirePairing(): void;
    /** Register add/open/close/leave RPC handlers for child handles. */
    _wireHandles(): void;
    /**
     * Look up a live handle by id, throwing if unknown. Binds the handle's
     * codec on first use.
     *
     * @param {string} id
     * @returns {any}
     */
    _resolve(id: string): any;
    /**
     * Resolve a `{ handle, ref }` pair to its `Ref` and codec.
     *
     * @param {string} id
     * @param {string} name
     * @param {boolean} [local]
     * @returns {RefAndCodec}
     */
    _refOf(id: string, name: string, local?: boolean): RefAndCodec;
    /**
     * Snapshot the current identity for return to the client.
     *
     * @returns {Identity}
     */
    _identity(): Identity;
    /** Wire the on-demand `seed` handler — surfaces the recovery phrase only when asked. */
    _wireSeed(): void;
}
/**
 * Construct a `Server`, wait for it to be ready, and return it.
 *
 * @param {any} ipc
 * @param {object} spec
 * @param {ServerOpts} opts
 * @returns {Promise<Server>}
 */
export declare function serve(ipc: any, spec: object, opts: ServerOpts): Promise<Server>;
