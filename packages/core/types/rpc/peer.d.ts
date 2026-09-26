import ReadyResource from 'ready-resource';
/**
 * Shared RPC peer: wraps an IPC duplex in a length-framed stream and constructs the spec's
 * hrpc binding.
 */
export declare class RPCPeer extends ReadyResource {
    ipc: import("streamx").Duplex<import("streamx").DuplexEvents>;
    spec: import("./index.js").Spec;
    /** @type {import('framed-stream')} */
    framed: import('framed-stream');
    rpc: object;
    /**
     * @param {import('streamx').Duplex} ipc           Duplex IPC stream (e.g. a socket or pipe).
     * @param {import('./index.js').Spec} spec         Spec object exposing `rpc` and `schema`.
     */
    constructor(ipc: import('streamx').Duplex, spec: import('./index.js').Spec);
    /** @private */
    private _open;
    /** @private */
    private _close;
}
