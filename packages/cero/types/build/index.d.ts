export type Schema = import('@cero-base/core/schema').Schema;
export type SchemaDefs = import('@cero-base/core/schema').SchemaDefs;
export type SchemaInput = Schema | (SchemaDefs & {
    local?: SchemaDefs;
});
export type BuildOpts = {
    /**
     * Namespace prefix for emitted schema ids. Defaults to `'cero'`.
     */
    ns?: string;
    /**
     * The extensions to fold in. A module specifier, relative to `specDir`, is imported here for its `extensions` export and written into the spec, so every process runs the same list. A list is folded in only. The bundled two by default, `[]` for none.
     */
    extensions?: string | import('../extensions/index.js').Extension[];
    /**
     * A module specifier, relative to `specDir`, written into the spec for its `operators` export, so every process binds the same map.
     */
    operators?: string;
};
/**
 * @typedef {import('@cero-base/core/schema').Schema} Schema
 * @typedef {import('@cero-base/core/schema').SchemaDefs} SchemaDefs
 * @typedef {Schema | (SchemaDefs & { local?: SchemaDefs })} SchemaInput
 *
 * @typedef {object} BuildOpts
 * @property {string} [ns]  Namespace prefix for emitted schema ids. Defaults to `'cero'`.
 * @property {string | import('../extensions/index.js').Extension[]} [extensions]  The extensions to fold in. A module specifier, relative to `specDir`, is imported here for its `extensions` export and written into the spec, so every process runs the same list. A list is folded in only. The bundled two by default, `[]` for none.
 * @property {string} [operators]  A module specifier, relative to `specDir`, written into the spec for its `operators` export, so every process binds the same map.
 */
/**
 * Compile a cero schema into wire-level artifacts and write them to disk.
 *
 * @param {string} specDir          Output directory.
 * @param {SchemaInput} schema      Either a `schema(...)` wrapper or its raw defs object.
 * @param {BuildOpts} [opts]
 * @returns {Promise<void>}
 */
export declare function build(specDir: string, schema: SchemaInput, { ns, extensions, operators }?: BuildOpts): Promise<void>;
