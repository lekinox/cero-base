import { CeroError } from '@cero-base/core/errors'

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
export class Ref {
  /**
   * @param {any} handle  Owner — a `Handle` (or `Local`) the ref lives on.
   * @param {string} name  Ref name as declared in the schema.
   * @param {string} kind  Ref kind: `'collection'`, `'single'`, `'action'`, or `'handle'`.
   * @param {string | null} [schema]  Fully-qualified schema id, if any.
   */
  constructor(handle, name, kind, schema = null) {
    this.handle = handle
    this.name = name
    this.kind = kind
    this.schema = schema
  }

  /**
   * Attach a `Ref` property to `target` for every entry in `refs`, so callers
   * write `handle.someRef` instead of looking refs up by name.
   *
   * @param {any} target
   * @param {Record<string, RefInfo>} refs
   */
  static attach(target, refs) {
    for (const [name, info] of Object.entries(refs || {})) {
      // a ref named like a reserved member must fail loud, not overwrite it
      if (name in target) {
        throw CeroError.INVALID(
          `schema ref '${name}' collides with a reserved ${target.constructor?.name || 'handle'} member — rename it`
        )
      }
      target[name] = new Ref(target, name, info.kind, info.schema)
    }
  }
}
