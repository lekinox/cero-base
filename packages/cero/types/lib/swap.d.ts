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
 * identity had opened, so it takes main's place; without it the old one comes back. What a killed swap left
 * in `main.next` goes, unless a swap is running there.
 *
 * @param {string} dir
 */
export declare function settle(dir: string): Promise<void>;
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
 * The identity opened and closed in `main.next` takes main's place. Both must be closed.
 *
 * @param {string} dir
 */
export declare function commit(dir: string): Promise<void>;
