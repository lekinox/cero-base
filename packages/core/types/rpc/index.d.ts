export { RPCServer } from './server.js';
export { RPCClient } from './client.js';
export type Spec = {
    /**
     * hyperschema-shaped module.
     */
    schema: {
        encode: (type: string, value: unknown) => Uint8Array;
        decode: (type: string, buf: Uint8Array) => unknown;
        getEncoding?: (name: string) => import('compact-encoding').Encoder;
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
    rpc?: new (stream: import('streamx').Duplex) => object;
    /**
     * Filled in by `bindCodec`.
     */
    codec?: Codec;
};
export type Codec = {
    encodeRow: (type: string, row: Record<string, unknown>) => Uint8Array;
    decodeRow: (type: string, buf: Uint8Array) => Record<string, unknown>;
    encodeRows: (type: string, rows: Record<string, unknown>[]) => Uint8Array;
    decodeRows: (type: string, buf: Uint8Array) => Record<string, unknown>[];
    encodeQuery: (q: Record<string, unknown>) => Uint8Array;
    decodeQuery: (buf: Uint8Array) => Record<string, unknown>;
    encodeCreate: (row: Record<string, unknown>) => Uint8Array;
    decodeCreate: (buf: Uint8Array) => Record<string, unknown>;
    encodeAction: (handle: Record<string, {
        schema?: string;
    }>, op: string, data: unknown) => Uint8Array;
    decodeAction: (handle: Record<string, {
        schema?: string;
    }>, op: string, buf: Uint8Array) => unknown;
};
/**
 * @typedef {object} Spec
 * @property {{ encode: (type: string, value: unknown) => Uint8Array, decode: (type: string, buf: Uint8Array) => unknown, getEncoding?: (name: string) => import('compact-encoding').Encoder }} schema   hyperschema-shaped module.
 * @property {{ ns?: string }} [meta]                                                                                                                              Optional metadata; `ns` controls envelope type fqns.
 * @property {new (stream: import('streamx').Duplex) => object} [rpc]                                                                                             hrpc constructor used by RPCServer/RPCClient.
 * @property {Codec} [codec]                                                                                                                                      Filled in by `bindCodec`.
 *
 * @typedef {object} Codec
 * @property {(type: string, row: Record<string, unknown>) => Uint8Array} encodeRow
 * @property {(type: string, buf: Uint8Array) => Record<string, unknown>} decodeRow
 * @property {(type: string, rows: Record<string, unknown>[]) => Uint8Array} encodeRows
 * @property {(type: string, buf: Uint8Array) => Record<string, unknown>[]} decodeRows
 * @property {(q: Record<string, unknown>) => Uint8Array} encodeQuery
 * @property {(buf: Uint8Array) => Record<string, unknown>} decodeQuery
 * @property {(row: Record<string, unknown>) => Uint8Array} encodeCreate
 * @property {(buf: Uint8Array) => Record<string, unknown>} decodeCreate
 * @property {(handle: Record<string, { schema?: string }>, op: string, data: unknown) => Uint8Array} encodeAction
 * @property {(handle: Record<string, { schema?: string }>, op: string, buf: Uint8Array) => unknown} decodeAction
 */
/**
 * Attach a `codec` namespace to a hyperschema-shaped `spec`.
 *
 * @param {Spec} spec
 * @returns {Spec}
 */
export declare function bindCodec(spec: Spec): Spec;
