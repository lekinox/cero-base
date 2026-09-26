/**
 * Read-only snapshot of a handle's existing p2p/storage counters.
 *
 * @param {import('@cero-base/cero').Handle} handle  A cero root or child handle.
 * @param {number} [at]  Sample timestamp, stamped by the caller.
 * @returns {{ handleId: string, network: { connections: number, peers: number, dht: object | null }, bee: { local: number, stats: Record<string, number> | null }, cores: Array<{ length: number, byteLength: number, peers: number }>, at: number }}
 */
export declare function stats(handle: import('@cero-base/cero').Handle, at?: number): {
    handleId: string;
    network: {
        connections: number;
        peers: number;
        dht: object | null;
    };
    bee: {
        local: number;
        stats: Record<string, number> | null;
    };
    cores: Array<{
        length: number;
        byteLength: number;
        peers: number;
    }>;
    at: number;
};
