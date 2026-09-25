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
 * Receives at the address a secret owns, direct from the sender or from a mirror. A message
 * that does not open is dropped; one that opens is kept in `box` until `onmessage` resolves.
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
    /** @private */
    _seen;
    /** @private */
    _session;
    /** @private */
    _discovery;
    /**
     * @param {import('../network/index.js').Network} network
     * @param {Uint8Array} secret
     * @param {{ box: import('./index.js').Box, onmessage: (message: Uint8Array) => unknown, onerror: (err: Error) => void }} opts
     */
    constructor(network: import('../network/index.js').Network, secret: Uint8Array, { box, onmessage, onerror }: {
        box: import('./index.js').Box;
        onmessage: (message: Uint8Array) => unknown;
        onerror: (err: Error) => void;
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
