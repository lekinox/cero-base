import ReadyResource from 'ready-resource';
/**
 * One sealed message on its way to an address: written to a fresh core, announced to peers
 * receiving at the address, and deposited on `mirrors` for an owner who is offline.
 * `delivered` resolves on the first read, by the owner or by a mirror holding it for them.
 */
export declare class Post extends ReadyResource {
    network: import("../index.js").Network;
    address: Uint8Array<ArrayBufferLike>;
    message: Uint8Array<ArrayBufferLike>;
    mirrors: Uint8Array<ArrayBufferLike>[];
    delivered: Promise<any>;
    _ondelivered: (value: any) => void;
    _core: any;
    _session: any;
    _discovery: import("../network/discovery.js").Discovery;
    /**
     * @param {import('../network/index.js').Network} network
     * @param {Uint8Array} address
     * @param {Uint8Array} message
     * @param {{ mirrors?: Uint8Array[] }} [opts]
     */
    constructor(network: import('../network/index.js').Network, address: Uint8Array, message: Uint8Array, { mirrors }?: {
        mirrors?: Uint8Array[];
    });
    _open(): Promise<void>;
    _close(): Promise<void>;
}
