export type Ref = import('./refs.js').Ref;
export type HookContext = import('@cero-base/core/database').HookContext;
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
 * @typedef {import('@cero-base/core/database').HookContext} HookContext
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
 * Invoke an `action`-kind ref (a custom mutation declared in the schema).
 *
 * @param {Ref} ref
 * @param {Record<string, any>} [d]
 * @returns {Promise<any>}
 */
export declare function call(ref: Ref, d?: Record<string, any>): Promise<any>;
/**
 * Rule that runs before a write to `ref` lands — at apply, on every peer, inside the op's
 * transaction. Return `false` to refuse it: the writer's own call rejects with `REFUSED`.
 * `ctx` is `{ op, name, row, existing, id, memberId, role, get, put, set, del }`; mutate
 * `ctx.row` to rewrite what is stored. `op` is the op as it applies, so an upsert on a
 * collection is a `put`. The four operators on `ctx` read and write the room as it stands at
 * this op, inside the transaction. Must be deterministic — read only `ctx`, never a clock or
 * local state — and registered before any op applies, in the process that owns the data. The
 * imported operators throw inside a hook; use the ones on `ctx`. Not available over RPC.
 *
 * @param {Ref} ref
 * @param {(ctx: HookContext) => unknown} fn
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {() => void}
 */
export declare function before(ref: Ref, fn: (ctx: HookContext) => unknown, opts?: {
    signal?: AbortSignal;
}): () => void;
/**
 * Rule that runs after a write to `ref` lands — at apply, on every peer, inside the op's
 * transaction. Write derived rows through `ctx.put` / `ctx.set` / `ctx.del`; a throw refuses
 * the whole op. Same `ctx` and the same determinism and registration rules as `before`. Use
 * `changes(ref)` instead to observe writes locally.
 *
 * @param {Ref} ref
 * @param {(ctx: HookContext) => unknown} fn
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {() => void}
 */
export declare function after(ref: Ref, fn: (ctx: HookContext) => unknown, opts?: {
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
