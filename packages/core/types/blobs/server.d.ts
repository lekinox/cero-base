export type Resolved = {
    key: Buffer;
    encryptionKey: Buffer | null;
};
/**
 * @typedef {{ key: Buffer, encryptionKey: Buffer | null }} Resolved
 */
/**
 * HTTP server that turns a string file id into a renderable localhost URL.
 */
export declare class FileServer {
    resolve: (coreKey: Buffer, info: object) => Resolved | null | Promise<Resolved | null>;
    server: any;
    /**
     * @param {object} opts
     * @param {import('corestore')} opts.store
     * @param {(coreKey: Buffer, info: object) => Resolved | null | Promise<Resolved | null>} opts.resolve
     */
    constructor({ store, resolve }: {
        store: import('corestore');
        resolve: (coreKey: Buffer, info: object) => Resolved | null | Promise<Resolved | null>;
    });
    get port(): any;
    listen(): Promise<void>;
    /**
     * Build a renderable localhost URL for a string file id.
     *
     * @param {string} id
     * @returns {string}
     */
    getLink(id: string): string;
    close(): Promise<void>;
}
