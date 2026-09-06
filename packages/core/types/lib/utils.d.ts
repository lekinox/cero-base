export { WRITE, INVITE, ASSIGN, REMOVE } from './constants.js';
/**
 * Generate a short opaque id (z32-encoded 16 random bytes).
 *
 * @returns {string}
 */
export declare function genId(): string;
/** @type {(dbKey: Uint8Array, writer: Uint8Array, appender: Uint8Array) => Uint8Array} */
export declare function admission(dbKey: Uint8Array<ArrayBufferLike>, writer: Uint8Array<ArrayBufferLike>, appender: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike>;
/** @type {(dbKey: Uint8Array, writer: Uint8Array) => Uint8Array} */
export declare function ownership(dbKey: Uint8Array<ArrayBufferLike>, writer: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike>;
/**
 * Whether `role` is granted `perm` under the default policy.
 *
 * @param {string} role
 * @param {string} perm
 * @returns {boolean}
 */
export declare function can(role: string, perm: string): boolean;
export declare function isRank(role: any): boolean;
export declare function grants(a: any, b: any): boolean;
export declare function outranks(a: any, b: any): boolean;
/**
 * Stream-of-snapshots primitive. Couples a `get` (returns the latest value) with a `watch`
 * (re-fires on change) and emits the newest snapshot every time `watch` ticks.
 *
 * @template T
 * @param {object} args
 * @param {() => Promise<T> | T} args.get
 * @param {(fn: () => void) => (() => void) | void} args.watch
 * @returns {import('streamx').Readable<T>}
 */
export declare function subscribe<T>({ get, watch }: {
    get: () => Promise<T> | T;
    watch: (fn: () => void) => (() => void) | void;
}): import('streamx').Readable<T>;
export declare function searchHit(row: any, term: any, fields: any): boolean;
/**
 * The in-memory query grammar over rows: equality on any non-reserved field,
 * id ranges, `search`, then `reverse` and `limit`.
 *
 * @param {any[]} rows
 * @param {Record<string, any>} [query]
 * @returns {any[]}
 */
export declare function filter(rows: any[], query?: Record<string, any>): any[];
/**
 * Run `cb` when `signal` aborts — or immediately if it already has.
 *
 * @param {AbortSignal | undefined} signal
 * @param {() => void} cb
 * @returns {(() => void) | undefined}
 */
export declare function onAbort(signal: AbortSignal | undefined, cb: () => void): (() => void) | undefined;
