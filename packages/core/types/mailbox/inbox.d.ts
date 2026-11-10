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
 * A handled row old enough to forget; one whose `handled` is no time is not.
 *
 * @param {import('./index.js').Mail} mail
 * @returns {boolean}
 */
export declare function aged({ handled }: import('./index.js').Mail): boolean;
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
 * that does not open in time, or that `onmessage` resolves `false` on, is dropped; one that opens
 * is kept in `box` until `onmessage` resolves, as a row naming its core, never the message, and
 * its id stays there for HANDLED_FOR once handled.
 * A core the inbox fetched is erased once dropped, or once handled with `keep` false; one this
 * device held already is left alone.
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
    _mail;
    /** @private */
    _turns;
    /** @private */
    _load;
    /** @private */
    _behind;
    /** @private */
    _reading;
    /** @private */
    _handled;
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
    private _forget;
    /** @private */
    private _next;
    /** @private */
    private _settle;
    /** @private */
    private _read;
    /** @private */
    private _resume;
    /** @private */
    private _unseal;
    /** @private */
    private _drop;
    /** @private */
    private _handle;
    /** @private */
    private _remember;
    /** @private */
    private _prune;
}
