export type RefKind = 'collection' | 'single' | 'action' | 'handle';
export type RefInfo = {
    kind?: string;
    schema?: string;
};
/**
 * @typedef {'collection' | 'single' | 'action' | 'handle'} RefKind
 * @typedef {{ kind?: string, schema?: string }} RefInfo
 *   Shape of the entries in `meta.refs` — describes a single ref name.
 *   `kind` is one of {@link RefKind}, kept as `string` since it originates
 *   from a generated spec.
 */
/**
 * Typed pointer to a single ref (table or handle slot) on a `Handle` or `Local`.
 */
export declare class Ref {
    handle: any;
    name: string;
    kind: string;
    schema: string;
    /**
     * @param {any} handle  Owner — a `Handle` (or `Local`) the ref lives on.
     * @param {string} name  Ref name as declared in the schema.
     * @param {string} kind  Ref kind: `'collection'`, `'single'`, `'action'`, or `'handle'`.
     * @param {string | null} [schema]  Fully-qualified schema id, if any.
     */
    constructor(handle: any, name: string, kind: string, schema?: string | null);
    /**
     * Attach a `Ref` property to `target` for every entry in `refs`, so callers
     * write `handle.someRef` instead of looking refs up by name.
     *
     * @param {any} target
     * @param {Record<string, RefInfo>} refs
     */
    static attach(target: any, refs: Record<string, RefInfo>): void;
}
