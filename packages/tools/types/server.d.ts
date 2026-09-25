import { Framed } from './protocol.js';
export type ReqFrame = {
    id?: number;
    method?: string;
    ref?: string;
    handleId?: string;
    query?: object;
    cancelId?: number;
};
export type ServeOpts = {
    events?: {
        snapshot(): unknown;
        subscribe(fn: (e: object) => void): () => void;
    };
    stats?: {
        snapshot(): unknown;
        subscribe(fn: (s: object) => void): () => void;
    };
    redact?: (ref: string, row: Record<string, unknown>) => Record<string, unknown>;
    token?: string | null;
};
/**
 * A decoded request frame. Carries the correlation `id` and `method`, plus the
 * per-method fields a handler reads: `ref`, `handleId`, `query`, `cancelId`.
 * @typedef {{ id?: number, method?: string, ref?: string, handleId?: string, query?: object, cancelId?: number }} ReqFrame
 *
 * @typedef {{ events?: { snapshot(): unknown, subscribe(fn: (e: object) => void): () => void }, stats?: { snapshot(): unknown, subscribe(fn: (s: object) => void): () => void }, redact?: (ref: string, row: Record<string, unknown>) => Record<string, unknown>, token?: string | null }} ServeOpts
 */
/**
 * Read-only inspection server over a local Duplex `stream`.
 *
 * @param {import('streamx').Duplex} stream  A streamx Duplex carrying length-prefixed JSON frames.
 * @param {import('@cero-base/cero').Context} me  The live root cero handle.
 * @param {ServeOpts} [opts]
 * @returns {{ close(): void }}
 */
export declare function serve(stream: import('streamx').Duplex, me: import('@cero-base/cero').Context, opts?: ServeOpts): {
    close(): void;
};
export declare class TapServer {
    stream: import("streamx").Duplex<import("streamx").DuplexEvents>;
    /** @type {import('@cero-base/cero').Context} */
    me: import('@cero-base/cero').Context;
    /** @type {(ref: string, row: Record<string, unknown>) => Record<string, unknown>} */
    redact: (ref: string, row: Record<string, unknown>) => Record<string, unknown>;
    opts: ServeOpts;
    /** @type {Map<number, () => void>} */
    tracked: Map<number, () => void>;
    /** @private */
    _authed;
    wire: Framed;
    /** @private */
    _cleanup;
    /**
     * @param {import('streamx').Duplex} stream
     * @param {import('@cero-base/cero').Context} me
     * @param {ServeOpts} [opts]
     */
    constructor(stream: import('streamx').Duplex, me: import('@cero-base/cero').Context, opts?: ServeOpts);
    /**
     * Dispatch an inbound request frame to its named method handler.
     * @param {ReqFrame} req  A decoded request frame, expected to carry `id` and `method`.
     * @returns {Promise<void>}
     */
    onRequest(req: ReqFrame): Promise<void>;
    /**
     * Reply with the root handle and its direct children as `{ id, type }` rows.
     * @param {ReqFrame} req  A request frame carrying `id`.
     * @returns {void}
     */
    handles(req: ReqFrame): void;
    /**
     * Read a ref once and reply with the redacted result.
     * @param {ReqFrame} req  A request frame carrying `id`, `ref`, `handleId` and `query`.
     * @returns {Promise<void>}
     */
    get(req: ReqFrame): Promise<void>;
    /**
     * Stream redacted live updates for a ref until cancelled or the stream ends.
     * @param {ReqFrame} req  A request frame carrying `id`, `ref`, `handleId` and `query`.
     * @returns {void}
     */
    watch(req: ReqFrame): void;
    /**
     * Stream the events source snapshot then live events.
     * @param {ReqFrame} req  A request frame carrying `id`.
     * @returns {void}
     */
    events(req: ReqFrame): void;
    /**
     * Stream the stats source snapshot then live stats.
     * @param {ReqFrame} req  A request frame carrying `id`.
     * @returns {void}
     */
    stats(req: ReqFrame): void;
    /**
     * Stop a tracked stream by id and release its resources.
     * @param {ReqFrame} req  A request frame carrying `cancelId`.
     * @returns {void}
     */
    cancel(req: ReqFrame): void;
    /**
     * Tear down all tracked streams and destroy the underlying stream.
     * @returns {void}
     */
    close(): void;
    /** @private */
    private _resolveRef;
    /** @private */
    private _source;
    /** @private */
    private _track;
    /** @private */
    private _drop;
    /** @private */
    private _send;
    /** @private */
    private _teardown;
}
