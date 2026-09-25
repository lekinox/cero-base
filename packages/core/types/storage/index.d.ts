import ReadyResource from 'ready-resource';
export type StorageOpts = {
    spec: {
        database: object;
        meta?: {
            ns?: string;
            refs?: Record<string, {
                kind?: string;
            }>;
        };
    };
    backend: 'rocks' | 'bee';
    /**
     * Pre-existing HypercoreStorage to reuse.
     */
    root?: import('hypercore-storage');
    /**
     * Pre-existing Corestore to reuse.
     */
    store?: import('corestore');
    /**
     * 32-byte key encrypting the backing core at rest (bee backend only).
     */
    storageKey?: Uint8Array;
};
export type Ref = {
    name: string;
    kind: string;
};
export type Row = import('../database/index.js').Row;
export type SingleResult = import('../database/index.js').SingleResult;
export type ListResult = import('../database/index.js').ListResult;
/**
 * @typedef {object} StorageOpts
 * @property {{ database: object, meta?: { ns?: string, refs?: Record<string, { kind?: string }> } }} spec
 * @property {'rocks' | 'bee'} backend
 * @property {import('hypercore-storage')} [root]  Pre-existing HypercoreStorage to reuse.
 * @property {import('corestore')} [store]         Pre-existing Corestore to reuse.
 * @property {Uint8Array} [storageKey]  32-byte key encrypting the backing core at rest (bee backend only).
 *
 * @typedef {{ name: string, kind: string }} Ref
 * @typedef {import('../database/index.js').Row} Row
 * @typedef {import('../database/index.js').SingleResult} SingleResult
 * @typedef {import('../database/index.js').ListResult} ListResult
 */
/**
 * Local, single-writer storage. Backed by either RocksDB (`rocks`) or a Hyperbee on top of
 * corestore (`bee`).
 */
export declare class Storage extends ReadyResource {
    dir: string;
    spec: {
        database: object;
        meta?: {
            ns?: string;
            refs?: Record<string, {
                kind?: string;
            }>;
        };
    };
    backend: "bee" | "rocks";
    storageKey: Uint8Array<ArrayBufferLike>;
    ns: string;
    refs: Record<string, {
        kind?: string;
    }>;
    /** @private */
    _cf;
    /** @private */
    _ownsRoot;
    /** @private */
    _ownsStore;
    /** @type {import('hypercore-storage') | null} */
    root: import('hypercore-storage') | null;
    /** @type {import('corestore') | null} */
    store: import('corestore') | null;
    /** @type {import('hyperdb') | null} */
    db: import('hyperdb') | null;
    /** @private */
    _writing;
    /**
     * @param {string} dir
     * @param {StorageOpts} [opts]
     */
    constructor(dir: string, { spec, backend, root, store, storageKey }?: StorageOpts);
    /** @private */
    private _open;
    /** @private */
    private _close;
    /**
     * Insert (or overwrite by id) a row, stamping `id`/`createdAt`/`updatedAt`.
     *
     * @param {string} name
     * @param {Record<string, unknown>} row
     * @returns {Promise<SingleResult>}
     */
    put(name: string, row: Record<string, unknown>): Promise<SingleResult>;
    /**
     * Upsert by merging with the existing row, preserving `createdAt`.
     *
     * @param {string} name
     * @param {Record<string, unknown>} row
     * @param {{ upsert?: boolean }} [opts]
     * @returns {Promise<SingleResult | null>}
     */
    set(name: string, row: Record<string, unknown>, { upsert }?: {
        upsert?: boolean;
    }): Promise<SingleResult | null>;
    /**
     * Delete by id (collection) or wipe the whole single-row table.
     *
     * @param {string} name
     * @param {string} [id]
     * @returns {Promise<void>}
     */
    del(name: string, id?: string): Promise<void>;
    /**
     * Read a row. With no `query`: list all (collection) or fetch the one
     * record (single). With a string id: fetch that specific row.
     *
     * @param {string} name
     * @param {string | Record<string, unknown>} [query]
     * @returns {Promise<SingleResult | ListResult>}
     */
    get(name: string, query?: string | Record<string, unknown>): Promise<SingleResult | ListResult>;
    /**
     * Live snapshot stream — re-emits the latest `get()` result on every
     * underlying mutation. Destroy the stream to stop watching.
     *
     * @param {string} name
     * @param {Record<string, unknown>} [query]
     * @returns {import('streamx').Readable}
     */
    watch(name: string, query?: Record<string, unknown>): import('streamx').Readable;
    /** @private */
    private _guard;
    /**
     * @param {string} name @returns {Ref}
     * @private
     */
    private _ref;
    /**
     * @param {Ref} ref @returns {string}
     * @private
     */
    private _col;
    /**
     * @param {Ref} ref @param {string} [id] @returns {Promise<Row | null>}
     * @private
     */
    private _read;
    /**
     * @param {Ref} ref @param {Row} row @returns {Promise<void>}
     * @private
     */
    private _write;
    /** @private */
    private _serial;
    /**
     * Construct a RocksDB-backed Storage.
     *
     * @param {string} dir
     * @param {Omit<StorageOpts, 'backend'>} opts
     */
    static rocks(dir: string, opts: Omit<StorageOpts, 'backend'>): Storage;
    /**
     * Construct a Hyperbee-backed Storage.
     *
     * @param {string} dir
     * @param {Omit<StorageOpts, 'backend'>} opts
     */
    static bee(dir: string, opts: Omit<StorageOpts, 'backend'>): Storage;
}
