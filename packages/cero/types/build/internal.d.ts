export declare const defs: {
    main: {
        members: {
            type: string;
        };
        devices: {
            type: string;
        };
        invites: {
            type: string;
        };
        handles: {
            type: string;
        };
        files: {
            type: string;
        };
        requests: {
            type: string;
        };
    };
    local: {
        master: {
            type: string;
            kind: string;
        };
        keypair: {
            type: string;
            kind: string;
        };
        'handle-keypairs': {
            type: string;
        };
        joins: {
            type: string;
        };
        inbox: {
            type: string;
        };
        outbox: {
            type: string;
        };
        environment: {
            type: string;
            kind: string;
        };
        serving: {
            type: string;
        };
    };
};
export type RefInfo = import('../lib/spec.js').RefInfo;
export type FieldType = {
    prim: string;
    required?: boolean;
    array?: boolean;
};
export type Column = {
    name: string;
    type: string;
    required: boolean;
    array?: boolean;
};
/**
 * @typedef {import('../lib/spec.js').RefInfo} RefInfo
 * @typedef {{ prim: string, required?: boolean, array?: boolean }} FieldType  A `t` field.
 * @typedef {{ name: string, type: string, required: boolean, array?: boolean }} Column
 */
/**
 * @param {string} ns
 * @param {boolean} root
 * @returns {Record<string, RefInfo>}
 */
export declare function live(ns: string, root: boolean): Record<string, RefInfo>;
/**
 * @param {Record<string, FieldType>} map
 * @returns {Column[]}
 */
export declare function fields(map: Record<string, FieldType>): Column[];
/**
 * @param {'main' | 'local' | 'rpc'} scope
 * @param {Record<string, Record<string, FieldType>>} [extend]
 * @returns {Array<{ name: string, compact: boolean, fields: Column[] }>}
 */
export declare function types(scope: 'main' | 'local' | 'rpc', extend?: Record<string, Record<string, FieldType>>): Array<{
    name: string;
    compact: boolean;
    fields: Column[];
}>;
/**
 * @param {string} ns
 * @param {'main' | 'local'} scope
 * @returns {Record<string, RefInfo & { path: string[] }>}
 */
export declare function refs(ns: string, scope: 'main' | 'local'): Record<string, RefInfo & {
    path: string[];
}>;
/**
 * Add `fields` to a ref: file ones resolve on read, required ones the RPC client fills on a set.
 *
 * @param {RefInfo} ref
 * @param {Record<string, FieldType>} fields
 * @returns {RefInfo}
 */
export declare function declare(ref: RefInfo, fields: Record<string, FieldType>): RefInfo;
/**
 * @param {string} ns
 * @param {'main' | 'local'} scope
 * @returns {Array<{ name: string, schema: string, key: string[] }>}
 */
export declare function collections(ns: string, scope: 'main' | 'local'): Array<{
    name: string;
    schema: string;
    key: string[];
}>;
/**
 * @param {string} ns
 * @returns {Array<{ name: string, requestType: string }>}
 */
export declare function dispatches(ns: string): Array<{
    name: string;
    requestType: string;
}>;
/**
 * @param {string} ns
 * @returns {Array<{ name: string, request: { name: string }, response: { name: string, stream?: boolean } }>}
 */
export declare function commands(ns: string): Array<{
    name: string;
    request: {
        name: string;
    };
    response: {
        name: string;
        stream?: boolean;
    };
}>;
