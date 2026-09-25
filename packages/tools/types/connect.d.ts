import { Framed } from './protocol.js';
export type Query = object;
export type Handle = Record<string, unknown>;
/**
 * @typedef {object} Query  Opaque query filter passed to the server.
 */
/**
 * @typedef {Record<string, unknown>} Handle  A handle descriptor returned by the server.
 */
/**
 * Consumer SDK for a tap server reached over a local Duplex `stream`.
 *
 * @param {import('streamx').Duplex} stream  A streamx Duplex connected to a tap server.
 * @param {{ token?: string }} [opts]
 * @returns {Promise<{ handles(): Promise<Handle[]>, get(ref: string, query?: Query, handleId?: string): Promise<unknown>, watch(ref: string, query?: Query, handleId?: string): import('streamx').Readable, events(): import('streamx').Readable, stats(): import('streamx').Readable, close(): void }>}
 */
export declare function connect(stream: import('streamx').Duplex, { token }?: {
    token?: string;
}): Promise<{
    handles(): Promise<Handle[]>;
    get(ref: string, query?: Query, handleId?: string): Promise<unknown>;
    watch(ref: string, query?: Query, handleId?: string): import('streamx').Readable;
    events(): import('streamx').Readable;
    stats(): import('streamx').Readable;
    close(): void;
}>;
export declare class Session {
    stream: import("streamx").Duplex<import("streamx").DuplexEvents>;
    token: string;
    /** @type {Map<number, { resolve: (value: unknown) => void, reject: (err: Error) => void }>} */
    pending: Map<number, {
        resolve: (value: unknown) => void;
        reject: (err: Error) => void;
    }>;
    /** @type {Map<number, import('streamx').Readable>} */
    streams: Map<number, import('streamx').Readable>;
    seq: number;
    wire: Framed;
    /**
     * @param {import('streamx').Duplex} stream
     * @param {{ token?: string }} [opts]
     */
    constructor(stream: import('streamx').Duplex, { token }?: {
        token?: string;
    });
    /**
     * Lists the handles exposed by the server.
     *
     * @returns {Promise<Handle[]>} Resolves to the handle descriptors.
     */
    handles(): Promise<Handle[]>;
    /**
     * Reads the current value for `ref`.
     *
     * @param {string} ref  Reference to read.
     * @param {Query} [query]  Optional query filter.
     * @param {string} [handleId]  Optional handle to scope the read.
     * @returns {Promise<unknown>} Resolves to the value.
     */
    get(ref: string, query?: Query, handleId?: string): Promise<unknown>;
    /**
     * Watches `ref` for changes, emitting frames as they arrive.
     *
     * @param {string} ref  Reference to watch.
     * @param {Query} [query]  Optional query filter.
     * @param {string} [handleId]  Optional handle to scope the watch.
     * @returns {import('streamx').Readable} Cancels its server-side source when destroyed.
     */
    watch(ref: string, query?: Query, handleId?: string): import('streamx').Readable;
    /**
     * Streams server events.
     *
     * @returns {import('streamx').Readable} Cancels its server-side source when destroyed.
     */
    events(): import('streamx').Readable;
    /**
     * Streams server stats.
     *
     * @returns {import('streamx').Readable} Cancels its server-side source when destroyed.
     */
    stats(): import('streamx').Readable;
    /**
     * Closes the session by ending the underlying stream.
     *
     * @returns {void}
     */
    close(): void;
    /** @private */
    private _onclose;
    /** @private */
    private _onmessage;
    /** @private */
    private _newId;
    /** @private */
    private _send;
    /** @private */
    private _request;
    /** @private */
    private _stream;
}
