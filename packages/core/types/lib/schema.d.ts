export type Prim = {
    prim: string;
    required?: boolean;
};
export type TypeDef = {
    kind: 'single' | 'collection' | 'action';
    fields: Record<string, Prim>;
};
export type SchemaDefs = {
    [name: string]: TypeDef | Record<string, TypeDef>;
} & {
    local?: Record<string, TypeDef>;
};
export type Schema = {
    defs: SchemaDefs;
};
/**
 * Schema DSL. Primitive field types and kind-constructors used to describe
 * a database's tables before the builder turns them into a wire spec.
 */
export declare const t: {
    string: Prim;
    uint: Prim;
    int: Prim;
    bool: Prim;
    bytes: Prim;
    json: Prim;
    fixed32: Prim;
    fixed64: Prim;
    file: Prim;
    /**
     * Mark a field as required. Fields are optional by default.
     *
     * @param {Prim} marker
     * @returns {Prim}
     */
    required: (marker: Prim) => Prim;
    /**
     * Single-row table (one record, set/get by name).
     *
     * @param {Record<string, Prim>} fields
     * @returns {TypeDef}
     */
    single(fields: Record<string, Prim>): TypeDef;
    /**
     * Multi-row table keyed by `id`. `own` restricts a row to the member who wrote it — anyone
     * may add rows, but only the author changes or deletes theirs.
     *
     * @param {Record<string, Prim>} fields
     * @param {{ indexes?: Record<string, string[]>, own?: boolean }} [opts]
     * @returns {TypeDef}
     */
    collection(fields: Record<string, Prim>, opts?: {
        indexes?: Record<string, string[]>;
        own?: boolean;
    }): TypeDef;
    /**
     * RPC-style mutation that doesn't persist a row.
     *
     * @param {Record<string, Prim>} fields
     * @returns {TypeDef}
     */
    action(fields: Record<string, Prim>): TypeDef;
    /**
     * Add fields to a builtin type (members, devices, …). Merged into the
     * builtin's base fields at build time; redeclaring a base field throws.
     *
     * @param {Record<string, Prim>} fields
     * @returns {{ kind: 'extend', fields: Record<string, Prim> }}
     */
    extend(fields: Record<string, Prim>): {
        kind: 'extend';
        fields: Record<string, Prim>;
    };
};
/**
 * Wrap a definitions object so the builder can recognise it as a schema.
 *
 * @param {SchemaDefs} defs
 * @returns {Schema}
 */
export declare function schema(defs: SchemaDefs): Schema;
