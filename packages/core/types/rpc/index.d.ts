export { RPCServer } from './server.js';
export { RPCClient } from './client.js';
export type Spec = {
    /**
     * hyperschema-shaped module.
     */
    schema: {
        encode: (type: string, value: any) => Uint8Array;
        decode: (type: string, buf: Uint8Array) => any;
        getEncoding?: (name: string) => any;
    };
    /**
     * Optional metadata; `ns` controls envelope type fqns.
     */
    meta?: {
        ns?: string;
    };
    /**
     * hrpc constructor used by RPCServer/RPCClient.
     */
    rpc?: any;
    /**
     * Filled in by `bindCodec`.
     */
    codec?: Codec;
};
export type Codec = {
    encodeRow: (type: string, row: any) => Uint8Array;
    decodeRow: (type: string, buf: Uint8Array) => any;
    encodeRows: (type: string, rows: any[]) => Uint8Array;
    encodeChanges: (type: string, changes: Array<{
        prev: any;
        next: any;
    }>) => Uint8Array;
    decodeChanges: (type: string, buf: Uint8Array) => Array<{
        prev: any;
        next: any;
    }>;
    decodeRows: (type: string, buf: Uint8Array) => any[];
    encodeQuery: (q: any) => Uint8Array;
    decodeQuery: (buf: Uint8Array) => any;
    encodeCreate: (row: any) => Uint8Array;
    decodeCreate: (buf: Uint8Array) => any;
    encodeAction: (handle: any, op: string, data: any) => Uint8Array;
    decodeAction: (handle: any, op: string, buf: Uint8Array) => any;
};
/**
 * @typedef {object} Spec
 * @property {{ encode: (type: string, value: any) => Uint8Array, decode: (type: string, buf: Uint8Array) => any, getEncoding?: (name: string) => any }} schema   hyperschema-shaped module.
 * @property {{ ns?: string }} [meta]                                                                                                                              Optional metadata; `ns` controls envelope type fqns.
 * @property {any} [rpc]                                                                                                                                          hrpc constructor used by RPCServer/RPCClient.
 * @property {Codec} [codec]                                                                                                                                      Filled in by `bindCodec`.
 *
 * @typedef {object} Codec
 * @property {(type: string, row: any) => Uint8Array} encodeRow
 * @property {(type: string, buf: Uint8Array) => any} decodeRow
 * @property {(type: string, rows: any[]) => Uint8Array} encodeRows
 * @property {(type: string, changes: Array<{ prev: any, next: any }>) => Uint8Array} encodeChanges
 * @property {(type: string, buf: Uint8Array) => Array<{ prev: any, next: any }>} decodeChanges
 * @property {(type: string, buf: Uint8Array) => any[]} decodeRows
 * @property {(q: any) => Uint8Array} encodeQuery
 * @property {(buf: Uint8Array) => any} decodeQuery
 * @property {(row: any) => Uint8Array} encodeCreate
 * @property {(buf: Uint8Array) => any} decodeCreate
 * @property {(handle: any, op: string, data: any) => Uint8Array} encodeAction
 * @property {(handle: any, op: string, buf: Uint8Array) => any} decodeAction
 */
/**
 * Attach a `codec` namespace to a hyperschema-shaped `spec`.
 *
 * @param {Spec} spec
 * @returns {Spec}
 */
export declare function bindCodec(spec: Spec): Spec;
