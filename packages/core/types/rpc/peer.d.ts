import ReadyResource from 'ready-resource';
/**
 * Shared RPC peer: wraps an IPC duplex in a length-framed stream and constructs the spec's
 * hrpc binding.
 */
export declare class RPCPeer extends ReadyResource {
    ipc: any;
    spec: import("./index.js").Spec;
    framed: any;
    rpc: any;
    /**
     * @param {any} ipc                                Duplex IPC stream (e.g. a socket or pipe).
     * @param {import('./index.js').Spec} spec         Spec object exposing `rpc` and `schema`.
     */
    constructor(ipc: any, spec: import('./index.js').Spec);
    _open(): Promise<void>;
    _close(): Promise<void>;
}
