/**
 * Build the hyperdispatch router for a spec: wires membership, builtin, and
 * spec-defined collection/action ops, returning the router plus an apply loop.
 *
 * @param {object} opts
 * @param {{ dispatch: { Router: Function }, meta?: { refs?: Record<string, { kind?: string, builtin?: boolean, verb?: string }> } }} opts.spec  Generated hyperdispatch spec.
 * @param {string} opts.ns  Namespace prefix for collection and op names.
 * @param {Record<string, Function>} opts.routes  Custom action handlers keyed by route name.
 * @param {(err: Error) => void} opts.onerror  Called when a malformed node is skipped.
 * @param {() => Uint8Array | null} opts.key  The database key, null until the bee booted.
 * @param {(row: { epoch: number, stamp: number, wrapped: Uint8Array, commit: Uint8Array }) => Promise<void>} opts.onepoch  Per-peer side of an applied rotation (skipped in dry runs).
 * @param {(phase: 'before' | 'after', op: string) => Function[]} [opts.hooks]  Registered hooks for an op, run inside its transaction.
 * @param {(name: string) => void} [opts.touch]  Marks a ref written by a hook, so its watchers tick.
 * @param {(view: object, name: string, query?: any) => Promise<any>} [opts.read]  Planned read against a given view, for a hook's `ctx.get`.
 * @param {(fn: Function) => Function} [opts.inHook]  Wraps a route so operators called inside it throw, like a hook.
 * @returns {{ dispatch: (value: Buffer, ctx: object) => Promise<void>, apply: (nodes: Array<{ value: Buffer, key: Buffer }>, view: object, host: object) => Promise<void> }}
 */
export declare function makeDispatcher({ spec, ns, routes, onerror, key, onepoch, hooks, touch, read, inHook }: {
    spec: {
        dispatch: {
            Router: Function;
        };
        meta?: {
            refs?: Record<string, {
                kind?: string;
                builtin?: boolean;
                verb?: string;
            }>;
        };
    };
    ns: string;
    routes: Record<string, Function>;
    onerror: (err: Error) => void;
    key: () => Uint8Array | null;
    onepoch: (row: {
        epoch: number;
        stamp: number;
        wrapped: Uint8Array;
        commit: Uint8Array;
    }) => Promise<void>;
    hooks?: (phase: 'before' | 'after', op: string) => Function[];
    touch?: (name: string) => void;
    read?: (view: object, name: string, query?: any) => Promise<any>;
    inHook?: (fn: Function) => Function;
}): {
    dispatch: (value: Buffer, ctx: object) => Promise<void>;
    apply: (nodes: Array<{
        value: Buffer;
        key: Buffer;
    }>, view: object, host: object) => Promise<void>;
};
