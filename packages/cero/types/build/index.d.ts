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
};
/**
 * @typedef {import('@cero-base/core/schema').Schema} Schema
 * @typedef {import('@cero-base/core/schema').SchemaDefs} SchemaDefs
 * @typedef {Schema | (SchemaDefs & { local?: SchemaDefs })} SchemaInput
 *
 * @typedef {object} BuildOpts
 * @property {string} [ns]  Namespace prefix for emitted schema ids. Defaults to `'cero'`.
 */
/**
 * Compile a cero schema into wire-level artifacts and write them to disk.
 *
 * @param {string} specDir          Output directory.
 * @param {SchemaInput} schema      Either a `schema(...)` wrapper or its raw defs object.
 * @param {BuildOpts} [opts]
 * @returns {Promise<void>}
 */
export declare function build(specDir: string, schema: SchemaInput, { ns, extensions }?: BuildOpts): Promise<void>;
