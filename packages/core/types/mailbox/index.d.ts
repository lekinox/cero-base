import ReadyResource from 'ready-resource';
export type Mail = {
    /**
     * Unique per message, hex.
     */
    id: string;
    /**
     * Where it goes, or where it arrived.
     */
    address: Uint8Array;
    message: Uint8Array;
    /**
     * Where a sent message waits for an owner who is offline.
     */
    mirrors?: Uint8Array[];
};
export type Box = {
    list: () => Promise<Mail[]>;
    put: (mail: Mail) => Promise<unknown>;
    del: (id: string) => Promise<unknown>;
};
export type MailboxOpts = {
    /**
     * Keeps a received message until it was handled.
     */
    inbox?: Box;
    /**
     * Keeps a sent message until someone read it.
     */
    outbox?: Box;
    /**
     * Called when a message fails to be handled or sent.
     */
    onerror?: (err: Error) => void;
};
/**
 * @typedef {object} Mail
 * @property {string} id                 Unique per message, hex.
 * @property {Uint8Array} address        Where it goes, or where it arrived.
 * @property {Uint8Array} message
 * @property {Uint8Array[]} [mirrors]    Where a sent message waits for an owner who is offline.
 *
 * @typedef {object} Box                 Where mail is kept; memory unless given a persistent one.
 * @property {() => Promise<Mail[]>} list
 * @property {(mail: Mail) => Promise<unknown>} put
 * @property {(id: string) => Promise<unknown>} del
 *
 * @typedef {object} MailboxOpts
 * @property {Box} [inbox]                   Keeps a received message until it was handled.
 * @property {Box} [outbox]                  Keeps a sent message until someone read it.
 * @property {(err: Error) => void} [onerror] Called when a message fails to be handled or sent.
 */
/**
 * A device's mailbox. It receives at the addresses it holds the secret of, and sends to any
 * address. Both ends keep their mail until it is done with: the outbox until someone read it,
 * the inbox until it was handled. Give it persistent boxes and that survives a restart: it
 * sends again what was not read and hands over again what was not handled, so a message may
 * arrive twice, never not at all.
 */
export declare class Mailbox extends ReadyResource {
    network: import("../index.js").Network;
    inbox: Box;
    outbox: Box;
    onerror: (err: Error) => void;
    _resources: Set<any>;
    /**
     * @param {import('../network/index.js').Network} network  Needs a store: messages travel as cores in it.
     * @param {MailboxOpts} [opts]
     */
    constructor(network: import('../network/index.js').Network, { inbox, outbox, onerror }?: MailboxOpts);
    /**
     * The address a secret owns: share it, anyone can send to it, only the secret opens.
     *
     * @param {Uint8Array} secret
     * @returns {Uint8Array}
     */
    static getAddress(secret: Uint8Array): Uint8Array;
    _open(): Promise<void>;
    _close(): Promise<void>;
    /**
     * Receive the messages sent to the address `secret` owns, until the returned inbox closes.
     * A message stays in the inbox until `onmessage` resolves; one it did not finish is handed
     * over again the next time this address is received.
     *
     * @param {Uint8Array} secret
     * @param {(message: Uint8Array) => unknown} onmessage
     * @returns {{ close: () => Promise<void> }}
     */
    receive(secret: Uint8Array, onmessage: (message: Uint8Array) => unknown): {
        close: () => Promise<void>;
    };
    /**
     * Send a message to an address. Resolves once the outbox keeps it; it is delivered in the
     * background, and dropped from the outbox once someone read it.
     *
     * @param {Uint8Array} address
     * @param {Uint8Array} message
     * @param {{ mirrors?: Uint8Array[] }} [opts]  Where it waits for an owner who is offline; the network's by default.
     * @returns {Promise<void>}
     */
    send(address: Uint8Array, message: Uint8Array, { mirrors }?: {
        mirrors?: Uint8Array[];
    }): Promise<void>;
    _deliver({ id, address, message, mirrors }: {
        address: any;
        id: any;
        message: any;
        mirrors: any;
    }): void;
    _track(resource: any): void;
}
