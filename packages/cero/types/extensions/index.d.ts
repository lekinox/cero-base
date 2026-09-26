import { t, schema } from '../lib/spec.js';
import * as operators from '../lib/operators.js';
export * from './profile-sync.js';
export * from './handle-sync.js';
export { t, schema };
export * from '../lib/operators.js';
export declare const cero: {
    put(ref: operators.Ref, row: operators.Row): Promise<operators.SingleResult>;
    set(ref: operators.Ref, row: operators.Row, opts?: {
        upsert?: boolean;
    }): Promise<operators.SingleResult | null>;
    del(ref: operators.Ref, id?: string): Promise<void>;
    call(ref: operators.Ref, d?: operators.Row): Promise<void>;
    before(ref: operators.Ref, fn: (ctx: operators.HookContext) => unknown, opts?: {
        signal?: AbortSignal;
    }): () => void;
    after(ref: operators.Ref, fn: (ctx: operators.HookContext) => unknown, opts?: {
        signal?: AbortSignal;
    }): () => void;
    get(ref: operators.Ref, q?: string | Record<string, unknown>): Promise<operators.SingleResult | operators.ListResult>;
    watch(ref: operators.Ref, query?: string | (Record<string, unknown> & {
        changes?: boolean;
    }), opts?: {
        signal?: AbortSignal;
    }): import('streamx').Readable;
    open(ref: operators.Ref, arg?: string | {
        invite?: string;
        id?: string;
        name?: string;
    } | undefined): Promise<operators.Context>;
    invite(ctx: operators.Context, opts?: import("@cero-base/core").InviteOpts): Promise<string>;
    revoke(ctx: operators.Context, code: string): Promise<boolean>;
    rotate(ctx: operators.Context): Promise<{
        epoch: number;
    }>;
    tx<T>(ctx: operators.Context, fn: (tx: operators.Context) => Promise<T>): Promise<T>;
    accept(ctx: operators.Context, request: {
        id: string;
    }, { role }?: {
        role?: string;
    }): Promise<void>;
    deny(ctx: operators.Context, request: {
        id: string;
    }, reason?: string): Promise<void>;
    leave(ctx: operators.Context): Promise<void>;
    close(ctx: operators.Context): Promise<void>;
    cancel(me: operators.Context, code: string): Promise<boolean>;
    suspend(me: operators.Context): Promise<void>;
    resume(me: operators.Context): Promise<void>;
    activate(room: operators.Context): Promise<void>;
    deactivate(room: operators.Context): Promise<void>;
    phrase(me: operators.Context): Promise<string>;
    nearby(ctx: operators.Context, mode: boolean | string): Promise<void>;
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
};
export type Extension = {
    name?: string;
    /**
     * Refs to add, or `t.extend` on a builtin, nested by handle type like the app schema.
     */
    schema?: Record<string, object>;
    /**
     * Runs before the root opens; a returned function runs on close.
     */
    setup?: (me: import('../handle/index.js').Context) => void | (() => void) | Promise<void | (() => void)>;
};
/**
 * @typedef {object} Extension
 * @property {string} [name]
 * @property {Record<string, object>} [schema]  Refs to add, or `t.extend` on a builtin, nested by handle type like the app schema.
 * @property {(me: import('../handle/index.js').Context) => void | (() => void) | Promise<void | (() => void)>} [setup]  Runs before the root opens; a returned function runs on close.
 */
/** The two every app gets unless its build names a list. */
export declare const bundled: Extension[];
/**
 * The override, else the list the spec carries, else the bundled two. A bare function is `{ setup }`.
 *
 * @param {import('../lib/spec.js').Spec | null} spec
 * @param {Array<Extension | Extension['setup']>} [override]
 * @returns {Extension[]}
 */
export declare function extensionsOf(spec: import('../lib/spec.js').Spec | null, override?: Array<Extension | Extension['setup']>): Extension[];
