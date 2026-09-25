export { WRITE, INVITE, ASSIGN, REMOVE } from './constants.js';
/** @type {(dbKey: Uint8Array, writer: Uint8Array, appender: Uint8Array) => Uint8Array} */
export declare function admission(dbKey: Uint8Array<ArrayBufferLike>, writer: Uint8Array<ArrayBufferLike>, appender: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike>;
/** @type {(dbKey: Uint8Array, writer: Uint8Array) => Uint8Array} */
export declare function ownership(dbKey: Uint8Array<ArrayBufferLike>, writer: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike>;
/** @type {(dbKey: Uint8Array, invite: Uint8Array, writer: Uint8Array, reply: Uint8Array) => Uint8Array} */
export declare function joining(dbKey: Uint8Array<ArrayBufferLike>, invite: Uint8Array<ArrayBufferLike>, writer: Uint8Array<ArrayBufferLike>, reply: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike>;
/**
 * Whether `role` is granted `perm` under the default policy.
 *
 * @param {string} role
 * @param {string} perm
 * @returns {boolean}
 */
export declare function can(role: string, perm: string): boolean;
/** @type {(role: string) => boolean} */
export declare function isRank(role: string): boolean;
/** @type {(a: string, b: string) => boolean} */
export declare function grants(a: string, b: string): boolean;
/** @type {(a: string, b: string) => boolean} */
export declare function outranks(a: string, b: string): boolean;
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
/** @param {Record<string, unknown>} row @param {string} term @param {string[]} [fields] @returns {boolean} */
export declare function searchHit(row: Record<string, unknown>, term: string, fields?: string[]): boolean;
/**
 * The in-memory query grammar over rows: equality on any non-reserved field,
 * id ranges, `search`, then `reverse` and `limit`.
 *
 * @template {Record<string, unknown>} T
 * @param {T[]} rows
 * @param {Record<string, unknown>} [query]
 * @returns {T[]}
 */
export declare function filter<T extends Record<string, unknown>>(rows: T[], query?: Record<string, unknown>): T[];
/**
 * Run `cb` when `signal` aborts — or immediately if it already has.
 *
 * @param {AbortSignal | undefined} signal
 * @param {() => void} cb
 * @returns {(() => void) | undefined}
 */
export declare function onAbort(signal: AbortSignal | undefined, cb: () => void): (() => void) | undefined;
