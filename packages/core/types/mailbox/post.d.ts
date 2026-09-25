import ReadyResource from 'ready-resource';
/**
 * One sealed message on its way to an address: written to a fresh core, announced to peers
 * receiving at the address, and deposited on `mirrors` for an owner who is offline.
 * `delivered` resolves on the first read, by the owner or by a mirror holding it for them.
 * Given a `core` instead, it announces that core as it is.
 */
export declare class Post extends ReadyResource {
    network: import("../index.js").Network;
    address: Uint8Array<ArrayBufferLike>;
    message: Uint8Array<ArrayBufferLike>;
    mirrors: Uint8Array<ArrayBufferLike>[];
    /** @type {Promise<void>} */
    delivered: Promise<void>;
    /** @private */
    _ondelivered;
    /** @private */
    _core;
    /** @private */
    _session;
    /** @private */
    _discovery;
    /**
     * @param {import('../network/index.js').Network} network
     * @param {Uint8Array} address
     * @param {Uint8Array | null} message
     * @param {{ mirrors?: Uint8Array[], core?: import('hypercore') }} [opts]
     */
    constructor(network: import('../network/index.js').Network, address: Uint8Array, message: Uint8Array | null, { mirrors, core }?: {
        mirrors?: Uint8Array[];
        core?: import('hypercore');
    });
    /** @private */
    private _open;
    /** @private */
    private _close;
}
