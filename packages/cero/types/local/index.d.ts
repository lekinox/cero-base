import ReadyResource from 'ready-resource';
import { Storage } from '@cero-base/core/storage';
export type LocalOpts = {
    /**
     * Pre-existing HypercoreStorage to reuse.
     */
    root?: any;
    /**
     * Pre-existing Corestore to reuse.
     */
    store?: any;
    /**
     * 32-byte key encrypting the local store at rest.
     */
    storageKey?: Uint8Array;
};
/**
 * @typedef {object} LocalOpts
 * @property {any} [root]   Pre-existing HypercoreStorage to reuse.
 * @property {any} [store]  Pre-existing Corestore to reuse.
 * @property {Uint8Array} [storageKey]  32-byte key encrypting the local store at rest.
 */
/**
 * Per-device, single-writer storage for cero — holds the master seed, device keypair and
 * any per-handle keypairs.
 */
export declare class Local extends ReadyResource {
    dir: string;
    spec: any;
    store: Storage;
    /**
     * @param {string | null} dir   Directory for the local store, or `null` when reusing an external `store`.
     * @param {any} spec            Built cero spec — must include `spec.local.database` and `spec.meta.local`.
     * @param {LocalOpts} [opts]
     */
    constructor(dir: string | null, spec: any, { root, store, storageKey }?: LocalOpts);
    _open(): Promise<void>;
    _close(): Promise<void>;
}
