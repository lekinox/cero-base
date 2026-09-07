import { t, schema } from '../lib/spec.js';
import * as operators from '../lib/operators.js';
export * from './profile-sync.js';
export * from './handle-sync.js';
export { t, schema };
export declare const put: typeof operators.put, set: typeof operators.set, get: typeof operators.get, del: typeof operators.del, watch: typeof operators.watch, changes: typeof operators.changes, call: typeof operators.call, open: typeof operators.open, rotate: typeof operators.rotate, before: typeof operators.before, after: typeof operators.after;
export declare const cero: {
    t: {
        string: import("@cero-base/core").Prim;
        uint: import("@cero-base/core").Prim;
        int: import("@cero-base/core").Prim;
        bool: import("@cero-base/core").Prim;
        bytes: import("@cero-base/core").Prim;
        json: import("@cero-base/core").Prim;
        fixed32: import("@cero-base/core").Prim;
        fixed64: import("@cero-base/core").Prim;
        file: import("@cero-base/core").Prim;
        required: (marker: import("@cero-base/core").Prim) => import("@cero-base/core").Prim;
        single(fields: Record<string, import("@cero-base/core").Prim>): import("@cero-base/core").TypeDef;
        collection(fields: Record<string, import("@cero-base/core").Prim>, opts?: {
            indexes?: Record<string, string[]>;
            own?: boolean;
        }): import("@cero-base/core").TypeDef;
        action(fields: Record<string, import("@cero-base/core").Prim>): import("@cero-base/core").TypeDef;
        extend(fields: Record<string, import("@cero-base/core").Prim>): {
            kind: 'extend';
            fields: Record<string, import("@cero-base/core").Prim>;
        };
    };
    schema: typeof schema;
    put: typeof operators.put;
    set: typeof operators.set;
    get: typeof operators.get;
    del: typeof operators.del;
    watch: typeof operators.watch;
    changes: typeof operators.changes;
    call: typeof operators.call;
    open: typeof operators.open;
    rotate: typeof operators.rotate;
    before: typeof operators.before;
    after: typeof operators.after;
};
export type Extension = {
    /**
     * Refs to add, or `t.extend` on a builtin, nested by handle type like the app schema.
     */
    schema?: Record<string, any>;
    /**
     * Runs once the root is ready; a returned function runs on close.
     */
    setup?: (me: any) => any;
};
/**
 * @typedef {object} Extension
 * @property {Record<string, any>} [schema]  Refs to add, or `t.extend` on a builtin, nested by handle type like the app schema.
 * @property {(me: any) => any} [setup]      Runs once the root is ready; a returned function runs on close.
 */
/** The two every app gets unless its build names a list. */
export declare const bundled: ({
    name: string;
    schema: {
        profile: import("@cero-base/core").TypeDef;
        members: {
            kind: 'extend';
            fields: Record<string, import("@cero-base/core").Prim>;
        };
    };
    setup(me: any): void;
} | {
    name: string;
    schema: {
        handles: {
            kind: 'extend';
            fields: Record<string, import("@cero-base/core").Prim>;
        };
    };
    setup(me: any): void;
})[];
/**
 * The extensions a spec carries, else the bundled two. A bare function is `{ setup }`.
 *
 * @param {any} spec
 * @param {Array<any>} [override]
 * @returns {Extension[]}
 */
export declare function extensionsOf(spec: any, override?: Array<any>): Extension[];
/**
 * The operators a spec carries: functions taking the handle first, keyed by namespace, a
 * key naming a handle type holding that type's namespaces.
 *
 * @param {any} spec
 * @param {Record<string, any>} [override]
 * @returns {Record<string, any>}
 */
export declare function operatorsOf(spec: any, override?: Record<string, any>): Record<string, any>;
/**
 * Put the operators for `handle` on it: the root when `type` is null, else a child of `type`.
 *
 * @param {any} handle
 * @param {string | null} type
 * @param {Record<string, any>} operators
 * @returns {any} handle
 */
export declare function bind(handle: any, type: string | null, operators: Record<string, any>): any;
