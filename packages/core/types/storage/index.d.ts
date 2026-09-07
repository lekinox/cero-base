import ReadyResource from 'ready-resource';
export type StorageOpts = {
    spec: {
        database: any;
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
    root?: any;
    /**
     * Pre-existing Corestore to reuse.
     */
    store?: any;
    /**
     * 32-byte key encrypting the backing core at rest (bee backend only).
     */
    storageKey?: Uint8Array;
};
export type Ref = {
    name: string;
    kind: string;
};
export type StoredRow = {
    id?: string;
    createdAt: number;
    updatedAt: number;
    [k: string]: any;
};
export type SingleResult = {
    data: any;
};
export type ListResult = {
    data: any[];
    total: number;
    size: number;
};
export type GetByIdResult = {
    data: any | null;
};
/**
 * @typedef {object} StorageOpts
 * @property {{ database: any, meta?: { ns?: string, refs?: Record<string, { kind?: string }> } }} spec
 * @property {'rocks' | 'bee'} backend
 * @property {any} [root]   Pre-existing HypercoreStorage to reuse.
 * @property {any} [store]  Pre-existing Corestore to reuse.
 * @property {Uint8Array} [storageKey]  32-byte key encrypting the backing core at rest (bee backend only).
 *
 * @typedef {{ name: string, kind: string }} Ref
 * @typedef {{ id?: string, createdAt: number, updatedAt: number, [k: string]: any }} StoredRow
 * @typedef {{ data: any }} SingleResult
 * @typedef {{ data: any[], total: number, size: number }} ListResult
 * @typedef {{ data: any | null }} GetByIdResult
 */
/**
 * Local, single-writer storage. Backed by either RocksDB (`rocks`) or a Hyperbee on top of
 * corestore (`bee`).
 */
export declare class Storage extends ReadyResource {
    dir: string;
    spec: {
        database: any;
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
    _cf: string;
    _ownsRoot: boolean;
    _ownsStore: boolean;
    root: any;
    store: any;
    db: any;
    /**
     * @param {string} dir
     * @param {StorageOpts} [opts]
     */
    constructor(dir: string, { spec, backend, root, store, storageKey }?: StorageOpts);
    _open(): Promise<void>;
    _close(): Promise<void>;
    /**
     * Insert (or overwrite by id) a row, stamping `id`/`createdAt`/`updatedAt`.
     *
     * @param {string} name
     * @param {Record<string, any>} row
     * @returns {Promise<SingleResult>}
     */
    put(name: string, row: Record<string, any>): Promise<SingleResult>;
    /**
     * Upsert by merging with the existing row, preserving `createdAt`.
     *
     * @param {string} name
     * @param {Record<string, any>} row
     * @param {{ upsert?: boolean }} [opts]
     * @returns {Promise<SingleResult | null>}
     */
    set(name: string, row: Record<string, any>, { upsert }?: {
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
     * @param {string | Record<string, any>} [query]
     * @returns {Promise<SingleResult | ListResult | GetByIdResult>}
     */
    get(name: string, query?: string | Record<string, any>): Promise<SingleResult | ListResult | GetByIdResult>;
    /**
     * Live snapshot stream — re-emits the latest `get()` result on every
     * underlying mutation. Destroy the stream to stop watching.
     *
     * @param {string} name
     * @param {Record<string, any>} [query]
     * @returns {import('streamx').Readable}
     */
    watch(name: string, query?: Record<string, any>): import('streamx').Readable;
    _guard(): void;
    /** @param {string} name @returns {Ref} */
    _ref(name: string): Ref;
    /** @param {Ref} ref @returns {string} */
    _col(ref: Ref): string;
    /** @param {Ref} ref @param {string} [id] @returns {Promise<any | null>} */
    _read(ref: Ref, id?: string): Promise<any | null>;
    /** @param {Ref} ref @param {Record<string, any>} row @returns {Promise<void>} */
    _write(ref: Ref, row: Record<string, any>): Promise<void>;
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
