/**
 * Re-exports of the schema DSL (`t`) and `schema()` wrapper from `@cero-base/core/schema`,
 * so cero apps can describe their tables without pulling in the core package directly.
 */
export { t, schema } from '@cero-base/core/schema'

/**
 * @typedef {object} RefInfo  One entry of a spec's `meta.refs`.
 * @property {'single' | 'collection' | 'action' | 'handle'} [kind]
 * @property {string} [schema]
 * @property {string} [type]      The handle type a `handle` ref opens.
 * @property {boolean} [internal] A builtin: members, devices, files and the like.
 * @property {boolean} [live]     Computed on the device, never stored: status, joins, nearby.
 * @property {string[]} [fields]  The declared fields, in schema order.
 * @property {Record<string, string>} [required]  The required fields and their types.
 * @property {string[]} [files]   The fields holding file ids.
 * @property {string} [verb]
 *
 * @typedef {object} SpecMeta
 * @property {string} [ns]
 * @property {string} [type]     The handle type, on a handle's spec.
 * @property {number} [version]
 * @property {Record<string, RefInfo>} refs
 * @property {{ refs: Record<string, RefInfo> }} [local]
 * @property {Record<string, SpecMeta>} [handles]
 *
 * @typedef {import('@cero-base/core/rpc').Spec & {
 *   meta: SpecMeta,
 *   database?: object,
 *   dispatch?: object,
 *   local?: { database: object, schema: object, meta: SpecMeta, codec?: import('@cero-base/core/rpc').Codec },
 *   extensions?: import('../extensions/index.js').Extension[] | null,
 *   handles?: Record<string, Spec>
 * }} Spec  What `build` writes and `cero()` opens.
 *
 * @typedef {import('@cero-base/core/database').Row} Row
 */
