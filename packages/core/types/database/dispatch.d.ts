export declare const BESPOKE: Set<string>;
export declare const leftId: (memberId: any) => string;
/**
 * Build the hyperdispatch router for a spec: wires membership, builtin, and
 * spec-defined collection/action ops, returning the router plus an apply loop.
 *
 * @param {object} opts
 * @param {{ dispatch: { Router: Function, encode: (name: string, value: unknown, opts?: { version?: number }) => Uint8Array }, meta?: { refs?: Record<string, { kind?: string, internal?: boolean, own?: boolean, verb?: string, fields?: string[], required?: Record<string, string> }>, encoding?: Record<string, number> } }} opts.spec  Generated hyperdispatch spec.
 * @param {string} opts.ns  Namespace prefix for collection and op names.
 * @param {number} opts.start  The version of a database that holds no version row.
 * @param {() => number} opts.contract  This build's contract: an op whose effective stamp is past it is skipped.
 * @param {(stamp: number) => void} opts.onskip  Called with the effective stamp of each op skipped as past the contract.
 * @param {() => number[]} opts.build  The row describing this build, kept in the view it applies: its database, rules, contract and the lowest version it skipped.
 * @param {(err: Error) => void} opts.onerror  Called when a malformed node is skipped.
 * @param {() => Uint8Array | null} opts.key  The database key, null until the bee booted.
 * @param {(row: { epoch: number, stamp: number, wrapped: Uint8Array, commit: Uint8Array }) => Promise<void>} opts.onepoch  Per-peer side of an applied rotation (skipped in dry runs).
 * @param {() => { publicKey: Uint8Array, secretKey: Uint8Array } | null} opts.room  The keypair behind the database's address, which joins are sealed to.
 * @param {(phase: 'before' | 'after', op: string) => Function[]} opts.hooks  Registered hooks for an op, run inside its transaction.
 * @param {(name: string) => void} opts.touch  Marks a ref written by a hook, once its batch commits, so its watchers tick.
 * @param {(view: object, name: string, query?: string | import('./index.js').Query) => Promise<import('./index.js').SingleResult | import('./index.js').ListResult>} opts.read  Planned read against a given view, for a hook's `ctx.get`.
 * @returns {{ encode: (route: string, value: unknown, stamp: number) => Uint8Array, cut: (route: string, value: Record<string, unknown>, stamp: number) => Record<string, unknown>, dispatch: (value: Buffer, ctx: object) => Promise<void>, role: (view: object, writer: Uint8Array) => Promise<string | null>, version: (view: object) => Promise<number>, built: (view: object) => Promise<Array<number | null> | null>, apply: (nodes: Array<{ value: Buffer, key: Buffer, version: number }>, view: object, host: object) => Promise<{ landed: Array<{ value: Buffer, key: Buffer, version: number }>, changed: boolean }> }}  `apply` takes each op with its author's stamp, runs it at its effective stamp, and resolves to the nodes that landed and whether they changed a row.
 */
export declare function makeDispatcher({ spec, ns, start, contract, onskip, build, onerror, key, onepoch, room, hooks, touch, read }: {
    spec: {
        dispatch: {
            Router: Function;
            encode: (name: string, value: unknown, opts?: {
                version?: number;
            }) => Uint8Array;
        };
        meta?: {
            refs?: Record<string, {
                kind?: string;
                internal?: boolean;
                own?: boolean;
                verb?: string;
                fields?: string[];
                required?: Record<string, string>;
            }>;
            encoding?: Record<string, number>;
        };
    };
    ns: string;
    start: number;
    contract: () => number;
    onskip: (stamp: number) => void;
    build: () => number[];
    onerror: (err: Error) => void;
    key: () => Uint8Array | null;
    onepoch: (row: {
        epoch: number;
        stamp: number;
        wrapped: Uint8Array;
        commit: Uint8Array;
    }) => Promise<void>;
    room: () => {
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    } | null;
    hooks: (phase: 'before' | 'after', op: string) => Function[];
    touch: (name: string) => void;
    read: (view: object, name: string, query?: string | import('./index.js').Query) => Promise<import('./index.js').SingleResult | import('./index.js').ListResult>;
}): {
    encode: (route: string, value: unknown, stamp: number) => Uint8Array;
    cut: (route: string, value: Record<string, unknown>, stamp: number) => Record<string, unknown>;
    dispatch: (value: Buffer, ctx: object) => Promise<void>;
    role: (view: object, writer: Uint8Array) => Promise<string | null>;
    version: (view: object) => Promise<number>;
    built: (view: object) => Promise<Array<number | null> | null>;
    apply: (nodes: Array<{
        value: Buffer;
        key: Buffer;
        version: number;
    }>, view: object, host: object) => Promise<{
        landed: Array<{
            value: Buffer;
            key: Buffer;
            version: number;
        }>;
        changed: boolean;
    }>;
};
