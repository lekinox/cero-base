import { Readable } from 'streamx';
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
 * @param {object} stream  A streamx Duplex connected to a tap server.
 * @returns {Promise<{ handles(): Promise<Handle[]>, get(ref: string, query?: Query, handleId?: string): Promise<unknown>, count(ref: string, query?: Query, handleId?: string): Promise<number>, watch(ref: string, query?: Query, handleId?: string): import('streamx').Readable, events(): import('streamx').Readable, stats(): import('streamx').Readable, close(): void }>}
 */
export declare function connect(stream: object, { token }?: {}): Promise<{
    handles(): Promise<Handle[]>;
    get(ref: string, query?: Query, handleId?: string): Promise<unknown>;
    count(ref: string, query?: Query, handleId?: string): Promise<number>;
    watch(ref: string, query?: Query, handleId?: string): import('streamx').Readable;
    events(): import('streamx').Readable;
    stats(): import('streamx').Readable;
    close(): void;
}>;
export declare class Session {
    stream: any;
    token: any;
    pending: Map<any, any>;
    streams: Map<any, any>;
    seq: number;
    wire: Framed;
    constructor(stream: any, { token }?: {});
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
     * Counts entries matching `ref`.
     *
     * @param {string} ref  Reference to count.
     * @param {Query} [query]  Optional query filter.
     * @param {string} [handleId]  Optional handle to scope the count.
     * @returns {Promise<number>} Resolves to the count.
     */
    count(ref: string, query?: Query, handleId?: string): Promise<number>;
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
    _onclose(): void;
    _onmessage(msg: any): void;
    _newId(): number;
    _send(frame: any): void;
    _request(method: any, fields: any): Promise<any>;
    _stream(method: any, fields: any): Readable<import("streamx").ReadableEvents>;
}
