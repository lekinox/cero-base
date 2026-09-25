export type Ref = import('./refs.js').Ref;
export type HookContext = import('@cero-base/core/database').HookContext;
export type Context = import('../handle/index.js').Context;
export type Row = import('@cero-base/core/database').Row;
export type SingleResult = import('@cero-base/core/database').SingleResult;
export type ListResult = import('@cero-base/core/database').ListResult;
/**
 * Insert (or overwrite by id) a row on `ref`.
 *
 * @param {Ref} ref
 * @param {Row} row
 * @returns {Promise<SingleResult>}
 */
export declare function put(ref: Ref, row: Row): Promise<SingleResult>;
/**
 * Upsert a row on `ref` — merges with the existing row and preserves `createdAt`.
 *
 * @param {Ref} ref
 * @param {Row} row
 * @param {{ upsert?: boolean }} [opts]
 * @returns {Promise<SingleResult>}
 */
export declare function set(ref: Ref, row: Row, opts?: {
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
 * @param {Row} [d]
 * @returns {Promise<void>}
 */
export declare function call(ref: Ref, d?: Row): Promise<void>;
/**
 * Rule that runs before a write to `ref` lands, or before an action does: at apply, on every
 * peer, inside the op's transaction. Return `false` to refuse it: the writer's own call rejects
 * with `REFUSED`. `ctx` is `{ op, name, row, existing, id, memberId, role, get, put, set, del }`;
 * mutate `ctx.row` to rewrite what is stored. `op` is the op as it applies, so an upsert on a
 * collection is a `put`. The four operators on `ctx` read and write the room as it stands at this
 * op, inside the transaction. Must be deterministic: read only `ctx`, never a clock or local
 * state. On a type ref (`me.room.notes`) it reaches every room of the type before the room
 * opens; register in an extension's `setup` to see every op the root applies too. The imported
 * operators throw inside a hook; use the ones on `ctx`. Not available over RPC.
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
 * Rule that runs after a write to `ref` lands, at apply, on every peer, inside the op's
 * transaction. On an action it is what the action does. Write derived rows through `ctx.put` /
 * `ctx.set` / `ctx.del`; a throw refuses the whole op. Same `ctx`, determinism and reach as
 * `before`. Use `watch(ref)` instead to observe writes locally.
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
 * @param {string | Record<string, unknown>} [q]
 * @returns {Promise<SingleResult | ListResult>}
 */
export declare function get(ref: Ref, q?: string | Record<string, unknown>): Promise<SingleResult | ListResult>;
/**
 * Read a ref as it changes. Each item is what `get(ref, query)` returns now; a slow reader gets
 * only the newest. With `changes: true` in the query each item also carries `changes`, the
 * `{ prev, next }` rows that changed since the item before, so a slow reader gets fewer items,
 * never fewer changes, and `reset`, set on the first item, whose changes list every row with
 * `prev: null`.
 *
 * @param {Ref} ref
 * @param {Record<string, unknown> & { changes?: boolean }} [query]
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {import('streamx').Readable}
 */
export declare function watch(ref: Ref, query?: Record<string, unknown> & {
    changes?: boolean;
}, opts?: {
    signal?: AbortSignal;
}): import('streamx').Readable;
/**
 * Open (or create / join / load) a child handle through a `handle`-kind ref.
 *
 * @param {Ref} ref
 * @param {string | { invite?: string, id?: string, name?: string } | undefined} [arg]
 * @returns {Promise<Context>}  The resolved child handle.
 */
export declare function open(ref: Ref, arg?: string | {
    invite?: string;
    id?: string;
    name?: string;
} | undefined): Promise<Context>;
/**
 * Mint an invite code into a room.
 *
 * @param {Context} ctx
 * @param {import('@cero-base/core/pairing').InviteOpts} [opts]
 * @returns {Promise<string>}
 */
export declare function invite(ctx: Context, opts?: import('@cero-base/core/pairing').InviteOpts): Promise<string>;
/**
 * Kill an invite, for every member.
 *
 * @param {Context} ctx
 * @param {string} code
 * @returns {Promise<boolean>}  Whether it was live.
 */
export declare function revoke(ctx: Context, code: string): Promise<boolean>;
/**
 * Re-key a room now: a new epoch sealed to its members, so one removed before it reads nothing
 * written after. Needs the remove permission. A removal also re-keys on its own shortly after it
 * lands; this is the one to await.
 *
 * @param {Context} ctx
 * @returns {Promise<{ epoch: number }>}
 */
export declare function rotate(ctx: Context): Promise<{
    epoch: number;
}>;
/**
 * Write atomically: every write `fn` makes through `tx`, the context it is handed, lands as one
 * batch, or none does. Reads through `tx` see the room as it was before the batch. Not available
 * over RPC.
 *
 * @template T
 * @param {Context} ctx
 * @param {(tx: Context) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export declare function tx<T>(ctx: Context, fn: (tx: Context) => Promise<T>): Promise<T>;
/**
 * Let in a join waiting on a `confirm` invite. `role` is the invite's by default, never above it.
 *
 * @param {Context} ctx
 * @param {{ id: string }} request  A row of `ctx.requests`.
 * @param {{ role?: string }} [opts]
 * @returns {Promise<void>}
 */
export declare function accept(ctx: Context, request: {
    id: string;
}, { role }?: {
    role?: string;
}): Promise<void>;
/**
 * Turn away a join waiting on a `confirm` invite. The joiner's `open` rejects with `DENIED`.
 *
 * @param {Context} ctx
 * @param {{ id: string }} request  A row of `ctx.requests`.
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
export declare function deny(ctx: Context, request: {
    id: string;
}, reason?: string): Promise<void>;
/**
 * Quit a room for good: it leaves your list and closes on this device.
 *
 * @param {Context} ctx
 * @returns {Promise<void>}
 */
export declare function leave(ctx: Context): Promise<void>;
/**
 * Stop using a context on this device; everything stays. Closing the root closes it all.
 *
 * @param {Context} ctx
 * @returns {Promise<void>}
 */
export declare function close(ctx: Context): Promise<void>;
/**
 * Give up a join still waiting for an answer, for good: it is not resumed on the next boot.
 *
 * @param {Context} me
 * @param {string} code
 * @returns {Promise<boolean>}  Whether a join was waiting.
 */
export declare function cancel(me: Context, code: string): Promise<boolean>;
/**
 * The app goes to the background: networking, storage and the Bluetooth radio pause together,
 * and every context reports `status.suspended`. On `me` only.
 *
 * @param {Context} me
 * @returns {Promise<void>}
 */
export declare function suspend(me: Context): Promise<void>;
/**
 * The app is back in the foreground: everything `suspend` paused resumes. On `me` only.
 *
 * @param {Context} me
 * @returns {Promise<void>}
 */
export declare function resume(me: Context): Promise<void>;
/**
 * Mark a room as the one in use: it ranks first on the swarm, searching and announcing. Rooms are
 * otherwise ranked by their last update.
 *
 * @param {Context} room
 * @returns {Promise<void>}
 */
export declare function activate(room: Context): Promise<void>;
/**
 * Take a room off the swarm until something lands in it.
 *
 * @param {Context} room
 * @returns {Promise<void>}
 */
export declare function deactivate(room: Context): Promise<void>;
/**
 * Reveal the recovery phrase.
 *
 * @param {Context} me
 * @returns {Promise<string>}
 */
export declare function phrase(me: Context): Promise<string>;
/**
 * Choose what the device's Bluetooth radio does: find the mesh (`true`), nothing (`false`), or
 * hold one invite's rendezvous (its code) so a joiner in range finds this device with no internet,
 * until the next call or the invite expires.
 *
 * @param {Context} ctx
 * @param {boolean | string} mode
 * @returns {Promise<void>}
 */
export declare function nearby(ctx: Context, mode: boolean | string): Promise<void>;
