/**
 * Loopback TCP transport implementing the tap `{ accept(handler) }` contract plus
 * lifecycle.
 *
 * @param {{ port?: number, host?: string, token?: string | null }} [opts]
 * @returns {{ accept(handler: (socket: any) => void): void, ready(): Promise<{ port: number }>, port: number | null, close(): void }}
 */
export declare function loopback(opts?: {
    port?: number;
    host?: string;
    token?: string | null;
}): {
    accept(handler: (socket: any) => void): void;
    ready(): Promise<{
        port: number;
    }>;
    port: number | null;
    close(): void;
};
/**
 * Dial a loopback tap server and return the connected socket, ready for
 * `connect()`.
 *
 * @param {{ port: number, host?: string }} [opts]
 * @returns {any} A streamx-compatible Duplex socket.
 */
export declare function dial(opts?: {
    port: number;
    host?: string;
}): any;
