export type RefKind = 'collection' | 'single' | 'action' | 'handle';
export type RefInfo = import('./spec.js').RefInfo;
export type Spec = import('./spec.js').Spec;
export type Owner = import('../handle/index.js').Context | import('../local/index.js').Local;
/**
 * @typedef {'collection' | 'single' | 'action' | 'handle'} RefKind
 * @typedef {import('./spec.js').RefInfo} RefInfo
 * @typedef {import('./spec.js').Spec} Spec
 * @typedef {import('../handle/index.js').Context | import('../local/index.js').Local} Owner
 */
/**
 * Typed pointer to a single ref (table or handle slot) on a `Handle` or `Local`.
 */
export declare class Ref {
    handle: Owner;
    name: string;
    kind: string;
    schema: string;
    type: string;
    /**
     * @param {Owner} handle  The root, a room or the local store the ref lives on.
     * @param {string} name  Ref name as declared in the schema.
     * @param {string} kind  Ref kind: `'collection'`, `'single'`, `'action'`, or `'handle'`.
     * @param {string | null} [schema]  Fully-qualified schema id, if any.
     * @param {string | null} [type]    On a ref under a handle type (`me.room.notes`), that type.
     */
    constructor(handle: Owner, name: string, kind: string, schema?: string | null, type?: string | null);
    /**
     * Attach a `Ref` property to `target` for every entry in `refs`, so callers
     * write `handle.someRef` instead of looking refs up by name.
     *
     * @param {Owner} target
     * @param {Record<string, RefInfo>} refs
     * @param {Record<string, Spec>} [handles]  The handle types, so `target.room.notes` names every room's notes.
     */
    static attach(target: Owner, refs: Record<string, RefInfo>, handles?: Record<string, Spec>): void;
}
