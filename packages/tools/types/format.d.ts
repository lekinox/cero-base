/**
 * Render a handle tree (`[{ id, type }]`) as a short colored list.
 *
 * @param {Array<{ id: string, type: string | null }>} tree
 * @returns {string}
 */
export declare function formatHandles(tree: Array<{
    id: string;
    type: string | null;
}>): string;
/**
 * Render a `get()` reply — `{ data, total, size }` for collections or
 * `{ data }` for single refs — as a compact summary.
 *
 * @param {string} ref
 * @param {{ data: any, total?: number, size?: number }} result
 * @returns {string}
 */
export declare function formatState(ref: string, result: {
    data: any;
    total?: number;
    size?: number;
}): string;
/**
 * Render a failed ref lookup as one line (so the CLI keeps going).
 *
 * @param {string} ref
 * @param {{ message?: string }} err
 * @returns {string}
 */
export declare function formatError(ref: string, err: {
    message?: string;
}): string;
/**
 * Render one applied-op event as a single colored line.
 *
 * @param {{ op: string, name: string, row: any, writerKey?: any, seq?: number }} e
 * @returns {string}
 */
export declare function formatEvent(e: {
    op: string;
    name: string;
    row: any;
    writerKey?: any;
    seq?: number;
}): string;
/**
 * Render a stats snapshot as a single colored line.
 *
 * @param {{ network?: { connections: number, peers: number }, bee?: { local: number }, cores?: any[] }} s
 * @returns {string}
 */
export declare function formatStats(s: {
    network?: {
        connections: number;
        peers: number;
    };
    bee?: {
        local: number;
    };
    cores?: any[];
}): string;
