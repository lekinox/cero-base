import ReadyResource from 'ready-resource';
/**
 * The keypair behind the address a secret owns.
 *
 * @param {Uint8Array} secret
 * @returns {{ publicKey: Uint8Array, secretKey: Uint8Array }}
 */
export declare function keyPair(secret: Uint8Array): {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
};
/**
 * Erase the core a message travelled in. Corestore leaves a core that still has a session open,
 * and that is an error here, not silence.
 *
 * @param {import('corestore')} store
 * @param {Uint8Array} key
 * @returns {Promise<void>}
 */
export declare function erase(store: import('corestore'), key: Uint8Array): Promise<void>;
/**
 * Receives at the address a secret owns, direct from the sender or from a mirror. A message
 * that does not open is dropped and its core erased; one that opens is kept in `box` until
 * `onmessage` resolves.
 * With `keep` false, the core it came in is then erased from this device.
 */
export declare class Inbox extends ReadyResource {
    network: import("../index.js").Network;
    keyPair: {
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    };
    address: Uint8Array<ArrayBufferLike>;
    box: import("./index.js").Box;
    onmessage: (message: Uint8Array) => unknown;
    onerror: (err: Error) => void;
    keep: boolean;
    /** @private */
    _seen;
    /** @private */
    _session;
    /** @private */
    _discovery;
    /**
     * @param {import('../network/index.js').Network} network
     * @param {Uint8Array} secret
     * @param {{ box: import('./index.js').Box, onmessage: (message: Uint8Array) => unknown, onerror: (err: Error) => void, keep?: boolean }} opts
     */
    constructor(network: import('../network/index.js').Network, secret: Uint8Array, { box, onmessage, onerror, keep }: {
        box: import('./index.js').Box;
        onmessage: (message: Uint8Array) => unknown;
        onerror: (err: Error) => void;
        keep?: boolean;
    });
    /** @private */
    private _open;
    /** @private */
    private _close;
    /** @private */
    private _onannounce;
    /** @private */
    private _read;
    /** @private */
    private _handle;
}
