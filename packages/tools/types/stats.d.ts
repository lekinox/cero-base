/**
 * Read-only snapshot of a handle's existing p2p/storage counters.
 *
 * @param {any} handle  A cero root or child handle.
 * @param {number} [at]  Sample timestamp, stamped by the caller.
 * @returns {{ handleId: string, network: { connections: number, peers: number, dht: any }, bee: { local: number, stats: any }, cores: Array<{ length: number, byteLength: number, peers: number }>, at: number }}
 */
export declare function stats(handle: any, at?: number): {
    handleId: string;
    network: {
        connections: number;
        peers: number;
        dht: any;
    };
    bee: {
        local: number;
        stats: any;
    };
    cores: Array<{
        length: number;
        byteLength: number;
        peers: number;
    }>;
    at: number;
};
