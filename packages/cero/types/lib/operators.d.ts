export type Ref = import('./refs.js').Ref;
export type CeroHandle = import('../handle/index.js').CeroHandle;
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
/**
 * @typedef {import('./refs.js').Ref} Ref
 * @typedef {import('../handle/index.js').CeroHandle} CeroHandle
 * @typedef {{ data: any }} SingleResult
 * @typedef {{ data: any[], total: number, size: number }} ListResult
 * @typedef {{ data: any | null }} GetByIdResult
 */
/**
 * Resolve a durable file id (+ optional name) to the read shape returned
 * everywhere: `{ id, name?, type, size, url }`.
 *
 * @param {object} handle
 * @param {string} id
 * @param {string} [name]
 * @returns {{ id: string, type: string, size: number, url: string, name?: string }}
 */
export declare function resolveFile(handle: object, id: string, name?: string): {
    id: string;
    type: string;
    size: number;
    url: string;
    name?: string;
};
/**
 * Insert (or overwrite by id) a row on `ref`.
 *
 * @param {Ref} ref
 * @param {Record<string, any>} row
 * @returns {Promise<SingleResult>}
 */
export declare function put(ref: Ref, row: Record<string, any>): Promise<SingleResult>;
/**
 * Upsert a row on `ref` — merges with the existing row and preserves `createdAt`.
 *
 * @param {Ref} ref
 * @param {Record<string, any>} row
 * @param {{ upsert?: boolean }} [opts]
 * @returns {Promise<SingleResult>}
 */
export declare function set(ref: Ref, row: Record<string, any>, opts?: {
    upsert?: boolean;
}): Promise<SingleResult>;
/**
 * Delete a row by id (collection refs), or wipe the row (single refs).
 *
 * @param {Ref} ref
 * @param {string} [id]
 * @returns {Promise<void>}
 */
export declare function del(ref: Ref, id?: string): Promise<void>;
/**
 * Count rows on `ref`, optionally filtered.
 *
 * @param {Ref} ref
 * @param {Record<string, any>} [q]
 * @returns {Promise<{ data: number }>}
 */
export declare function count(ref: Ref, q?: Record<string, any>): Promise<{
    data: number;
}>;
/**
 * Invoke an `action`-kind ref (a custom mutation declared in the schema).
 *
 * @param {Ref} ref
 * @param {Record<string, any>} [d]
 * @returns {Promise<any>}
 */
export declare function call(ref: Ref, d?: Record<string, any>): Promise<any>;
/**
 * Intercept writes to `ref` before they commit — `fn(ctx)` runs in-path (awaited).
 *
 * @param {Ref} ref
 * @param {(ctx: { op: string, name: string, row: any }) => any} fn
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {() => void}
 */
export declare function before(ref: Ref, fn: (ctx: {
    op: string;
    name: string;
    row: any;
}) => any, opts?: {
    signal?: AbortSignal;
}): () => void;
/**
 * Subscribe to writes on `ref` — fires after each committed write, non-blocking (observe
 * only).
 *
 * @param {Ref} ref
 * @param {(ctx: { op: string, name: string, row: any }) => void} fn
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {() => void}
 */
export declare function after(ref: Ref, fn: (ctx: {
    op: string;
    name: string;
    row: any;
}) => void, opts?: {
    signal?: AbortSignal;
}): () => void;
/**
 * Read from `ref`. For data refs, dispatches to the underlying store.
 *
 * @param {Ref} ref
 * @param {string | Record<string, any>} [q]
 * @returns {Promise<SingleResult | ListResult | GetByIdResult>}
 */
export declare function get(ref: Ref, q?: string | Record<string, any>): Promise<SingleResult | ListResult | GetByIdResult>;
/**
 * Live snapshot stream on `ref` — re-emits the latest `get()` result on every underlying
 * mutation.
 *
 * @param {Ref} ref
 * @param {Record<string, any>} [q]
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {import('streamx').Readable}
 */
export declare function watch(ref: Ref, q?: Record<string, any>, opts?: {
    signal?: AbortSignal;
}): import('streamx').Readable;
/**
 * Delta subscription: batches of `{ prev, next }` row pairs instead of full snapshots —
 * lossless under backpressure, self-contained (the first batch, and any batch after a view
 * swap, replays current.
 */
export declare function changes(ref: any, q: any, opts: any): any;
/**
 * Open (or create / join / load) a child handle through a `handle`-kind ref.
 *
 * @param {Ref} ref
 * @param {string | { invite?: string, id?: string, name?: string, routes?: any, role?: string, accept?: boolean } | undefined} [arg]
 * @returns {Promise<CeroHandle>}  The resolved child handle.
 */
export declare function open(ref: Ref, arg?: string | {
    invite?: string;
    id?: string;
    name?: string;
    routes?: any;
    role?: string;
    accept?: boolean;
} | undefined): Promise<CeroHandle>;
/**
 * Rotate a handle's encryption epoch. A fresh secret is sealed to every current member and
 * announced through the log — members removed before the rotation cannot decrypt anything
 * written after it.
 *
 * @param {any} handle
 * @returns {Promise<{ epoch: number }>}
 */
export declare function rotate(handle: any): Promise<{
    epoch: number;
}>;
/**
 * Put custom operators on `handle`, currying it as their first argument so
 * `handle.ns.fn(args)` calls `fn(handle, args)`.
 *
 * @param {any} handle
 * @param {Record<string, any> | string | null} arg
 * @returns {any} handle
 */
export declare function bind(handle: any, arg: Record<string, any> | string | null): any;
/**
 * Register custom operators by scope. A bare key binds on the root handle; a key that
 * names a child-handle type binds on every handle of that type.
 *
 * @param {Record<string, any>} map
 */
export declare function define(map: Record<string, any>): void;
/** Test seam: clear all registered operators. */
export declare function _clearDefined(): void;
