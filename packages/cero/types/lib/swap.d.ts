/**
 * Where the incoming identity opens.
 *
 * @param {string} dir
 * @returns {string}
 */
export declare const nextOf: (dir: string) => string;
/**
 * The store a launch of `dir` opens, without moving anything: `main`, or with a swap killed between its renames,
 * the identity `settle` will keep.
 *
 * @param {string} dir
 * @returns {Promise<string>}
 */
export declare function current(dir: string): Promise<string>;
/**
 * A swap killed part way, finished or undone before anything opens `dir`: past its first rename the incoming
 * identity had opened, so it takes main's place; without it the old one comes back.
 *
 * @param {string} dir
 */
export declare function settle(dir: string): Promise<void>;
/**
 * The lock on `dir`, a file beside the stores, held from before a store closes or opens until the one in `main` is
 * open: a store's own lock goes with its close and moves with its directory. Another holder is waited for, a try
 * every few ms; a kill frees it.
 *
 * @param {string} dir
 * @param {number} [timeout]  The longest wait in ms, 0 for no limit.
 * @returns {Promise<{ close: () => Promise<void> }>}  Held until closed.
 */
export declare function lock(dir: string, timeout?: number): Promise<{
    close: () => Promise<void>;
}>;
/**
 * What a killed swap left in `main.next` goes, unless a swap is running there. Only once `main` is open: a swap in
 * another process keeps main open while the incoming identity opens.
 *
 * @param {string} dir
 */
export declare function sweep(dir: string): Promise<void>;
/**
 * Run `fn` with `dir/main.next` set aside for it, emptied before and after.
 *
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export declare function staging<T>(dir: string, fn: () => Promise<T>): Promise<T>;
/**
 * The identity opened and closed in `main.next`, all of it on disk: a rename that follows never points at data
 * still in a cache.
 *
 * @param {string} dir
 */
export declare function flush(dir: string): Promise<void>;
/**
 * The identity opened, closed and flushed in `main.next` takes main's place. Both must be closed.
 *
 * @param {string} dir
 */
export declare function commit(dir: string): Promise<void>;
