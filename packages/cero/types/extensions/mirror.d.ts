/**
 * Write `row`'s name and `fields`, read from `from`, onto row `id` of `to`. A file is copied
 * into `to`'s handle, so it resolves there for everyone in it. Nothing is written when there is
 * no row or it already matches: an unconditional set on every open is an op in the log forever.
 *
 * @param {import('../lib/refs.js').Ref} from
 * @param {Record<string, unknown>} row
 * @param {Record<string, object>} fields
 * @param {import('../lib/refs.js').Ref} to
 * @param {string} id
 * @returns {Promise<void>}
 */
export declare function mirror(from: import('../lib/refs.js').Ref, row: Record<string, unknown>, fields: Record<string, object>, to: import('../lib/refs.js').Ref, id: string): Promise<void>;
