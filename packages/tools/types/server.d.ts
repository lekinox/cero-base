import { Framed } from './protocol.js';
export type ReqFrame = {
    id?: string;
    method?: string;
    ref?: string;
    handleId?: string;
    query?: object;
    cancelId?: string;
};
/**
 * A decoded request frame. Carries the correlation `id` and `method`, plus the
 * per-method fields a handler reads: `ref`, `handleId`, `query`, `cancelId`.
 * @typedef {{ id?: string, method?: string, ref?: string, handleId?: string, query?: object, cancelId?: string }} ReqFrame
 */
/**
 * Read-only inspection server over a local Duplex `stream`.
 *
 * @param {object} stream  A streamx Duplex carrying length-prefixed JSON frames.
 * @param {object} me  The live root cero handle.
 * @param {{ events?: { snapshot(): unknown, subscribe(fn: (e: object) => void): () => void }, stats?: { snapshot(): unknown, subscribe(fn: (s: object) => void): () => void }, redact?: (ref: string, row: Record<string, unknown>) => Record<string, unknown> }} [opts]
 * @returns {{ close(): void }}
 */
export declare function serve(stream: object, me: object, opts?: {
    events?: {
        snapshot(): unknown;
        subscribe(fn: (e: object) => void): () => void;
    };
    stats?: {
        snapshot(): unknown;
        subscribe(fn: (s: object) => void): () => void;
    };
    redact?: (ref: string, row: Record<string, unknown>) => Record<string, unknown>;
}): {
    close(): void;
};
export declare class TapServer {
    stream: any;
    me: any;
    redact: any;
    opts: {};
    tracked: Map<any, any>;
    _authed: boolean;
    wire: Framed;
    _cleanup: () => void;
    constructor(stream: any, me: any, opts?: {});
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
    _resolveRef(req: any): any;
    _source(req: any, src: any): void;
    _track(id: any, off: any): void;
    _drop(id: any): void;
    _send(obj: any): void;
    _teardown(): void;
}
