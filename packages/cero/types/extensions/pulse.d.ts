/**
 * Hear through a pulse service when another device writes in a handle you are in, closed here too,
 * and wake that handle so it syncs, without the app opening it. A best effort: a notice may come
 * late or twice. Declares `local.pulses`, a row per handle id: `heard`, the local time a write from
 * another device last landed here, 0 before the first; and what pulse keeps for itself: `told`,
 * `owed`, `since` and `epoch`.
 *
 * @param {string | Uint8Array} [key]  The service's public key, as it prints it. The build needs none.
 * @returns {import('./index.js').Extension}
 */
export declare function pulse(key?: string | Uint8Array): import('./index.js').Extension;
