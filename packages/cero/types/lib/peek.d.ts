/**
 * Quickly check whether the on-disk directory at `dir` already holds an initialised cero
 * identity (i.e. a stored device key with its proof).
 *
 * @param {string} dir   Cero data directory.
 * @param {import('./spec.js').Spec} spec  Built spec, the value passed to `cero(dir, spec)`.
 * @returns {Promise<boolean>}  `true` if a device of an identity exists on disk.
 */
export declare function peek(dir: string, spec: import('./spec.js').Spec): Promise<boolean>;
