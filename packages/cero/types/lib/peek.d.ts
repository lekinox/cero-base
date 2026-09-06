/**
 * Quickly check whether the on-disk directory at `dir` already holds an initialised cero
 * identity (i.e. a stored master seed).
 *
 * @param {string} dir   Cero data directory.
 * @param {any} spec     Built spec — same value passed to `cero(dir, spec)`.
 * @returns {Promise<boolean>}  `true` if a master seed exists on disk.
 */
export declare function peek(dir: string, spec: any): Promise<boolean>;
