/**
 * What the directory at `dir` holds, read without opening it: nothing yet, an identity, or a recovery or a link
 * still waiting for a device of its identity, which the next `cero(dir, spec)` goes on with.
 *
 * @param {string} dir   Cero data directory.
 * @param {import('./spec.js').Spec} spec  Built spec, the value passed to `cero(dir, spec)`.
 * @param {{ storageKey?: Uint8Array }} [opts]  The key `cero()` encrypts the local store with, if any.
 * @returns {Promise<'ready' | 'recovering' | 'linking' | null>}  `null` when it holds nothing.
 */
export declare function peek(dir: string, spec: import('./spec.js').Spec, { storageKey }?: {
    storageKey?: Uint8Array;
}): Promise<'ready' | 'recovering' | 'linking' | null>;
