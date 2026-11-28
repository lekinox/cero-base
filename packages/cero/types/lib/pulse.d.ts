/**
 * Follow every handle this device is in on the service at `key`: tell it of this device's writes,
 * and wake a handle when another device tells of one. A best effort: a notice may come late or
 * twice, and the data is Cero's sync's. `me` emits `'pulse'` with the handle's id and the local
 * time a write from another device landed in it.
 *
 * @param {import('../handle/index.js').Context} me
 * @param {string | Uint8Array} key  The service's public key.
 * @returns {() => void}  Stops following.
 */
export declare function follow(me: import('../handle/index.js').Context, key: string | Uint8Array): () => void;
