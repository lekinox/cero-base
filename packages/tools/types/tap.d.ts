export type OpEvent = {
    op: string;
    name: string;
    row: Record<string, unknown>;
    writerKey: Buffer;
    seq: number;
};
export type StatsSample = {
    handleId: string;
    network: {
        connections: number;
        peers: number;
        dht: object | null;
    };
    bee: {
        local: number;
    };
    cores: Array<{
        length: number;
        byteLength: number;
        peers: number;
    }>;
    at: number;
};
/**
 * An applied-op event fed into the ring buffer.
 *
 * @typedef {{ op: string, name: string, row: Record<string, unknown>, writerKey: Buffer, seq: number }} OpEvent
 */
/**
 * A periodic `stats(me)` sample. See `stats()` for the field meanings.
 *
 * @typedef {{ handleId: string, network: { connections: number, peers: number, dht: object | null }, bee: { local: number }, cores: Array<{ length: number, byteLength: number, peers: number }>, at: number }} StatsSample
 */
/**
 * `cero.use(devtools())` tap extension. Bound to the root handle's lifecycle, it feeds
 * every applied op into a bounded ring buffer, samples `stats(me)` on an interval, and
 * serves a read-only inspection.
 *
 * @param {{ port?: number, host?: string, token?: string | false, bufferSize?: number, sampleInterval?: number, redact?: ((ref: string, row: Record<string, unknown>) => Record<string, unknown>) | { fields?: string[], match?: (key: string, value: unknown, path: string) => boolean, deny?: RegExp | false }, transport?: { accept(handler: (stream: object) => void): void } }} [opts]
 * @returns {{ setup(me: object): () => void }}
 */
export declare function devtools(opts?: {
    port?: number;
    host?: string;
    token?: string | false;
    bufferSize?: number;
    sampleInterval?: number;
    redact?: ((ref: string, row: Record<string, unknown>) => Record<string, unknown>) | {
        fields?: string[];
        match?: (key: string, value: unknown, path: string) => boolean;
        deny?: RegExp | false;
    };
    transport?: {
        accept(handler: (stream: object) => void): void;
    };
}): {
    setup(me: object): () => void;
};
