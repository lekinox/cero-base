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
    _seen: Set<any>;
    _session: any;
    _discovery: import("../network/discovery.js").Discovery;
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
    _open(): Promise<void>;
    _close(): Promise<void>;
    _onannounce(key: any): void;
    _read(id: any, key: any): Promise<void>;
    _handle({ id, message }: {
        id: any;
        message: any;
    }): Promise<void>;
}
