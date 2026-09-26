import ReadyResource from 'ready-resource';
import { Storage } from '@cero-base/core/storage';
export type LocalOpts = {
    /**
     * Pre-existing HypercoreStorage to reuse.
     */
    root?: import('hypercore-storage');
    /**
     * Pre-existing Corestore to reuse.
     */
    store?: import('corestore');
    /**
     * 32-byte key encrypting the local store at rest.
     */
    storageKey?: Uint8Array;
};
/**
 * @typedef {object} LocalOpts
 * @property {import('hypercore-storage')} [root]   Pre-existing HypercoreStorage to reuse.
 * @property {import('corestore')} [store]  Pre-existing Corestore to reuse.
 * @property {Uint8Array} [storageKey]  32-byte key encrypting the local store at rest.
 */
/**
 * Per-device, single-writer storage for cero — holds the master seed, device keypair and
 * any per-handle keypairs.
 */
export declare class Local extends ReadyResource {
    dir: string;
    spec: import("../lib/spec.js").Spec;
    store: Storage;
    /** @private */
    _owned;
    /**
     * @param {string | null} dir   Directory for the local store, or `null` when reusing an external `store`.
     * @param {import('../lib/spec.js').Spec} spec  Built cero spec, with `spec.local.database` and `spec.meta.local`.
     * @param {LocalOpts} [opts]
     */
    constructor(dir: string | null, spec: import('../lib/spec.js').Spec, { root, store, storageKey }?: LocalOpts);
    /**
     * Tie a watch stream to this store: it ends when the store closes.
     *
     * @template {import('streamx').Readable} T
     * @param {T} stream
     * @returns {T}
     */
    own<T extends import('streamx').Readable>(stream: T): T;
    /** @private */
    private _open;
    /** @private */
    private _close;
}
/**
 * One of the mailbox's boxes, kept in the local store so mail survives a restart.
 *
 * @param {import('@cero-base/core/storage').Storage} store
 * @param {'inbox' | 'outbox'} name
 * @returns {import('@cero-base/core/mailbox').Box}
 */
export declare function box(store: import('@cero-base/core/storage').Storage, name: 'inbox' | 'outbox'): import('@cero-base/core/mailbox').Box;
