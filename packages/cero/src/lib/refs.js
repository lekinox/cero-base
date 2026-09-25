import { CeroError } from '@cero-base/core/errors'

/**
 * @typedef {'collection' | 'single' | 'action' | 'handle'} RefKind
 * @typedef {import('./spec.js').RefInfo} RefInfo
 * @typedef {import('./spec.js').Spec} Spec
 * @typedef {import('../handle/index.js').Context | import('../local/index.js').Local} Owner
 */

/**
 * Typed pointer to a single ref (table or handle slot) on a `Handle` or `Local`.
 */
export class Ref {
  /**
   * @param {Owner} handle  The root, a room or the local store the ref lives on.
   * @param {string} name  Ref name as declared in the schema.
   * @param {string} kind  Ref kind: `'collection'`, `'single'`, `'action'`, or `'handle'`.
   * @param {string | null} [schema]  Fully-qualified schema id, if any.
   * @param {string | null} [type]    On a ref under a handle type (`me.room.notes`), that type.
   */
  constructor(handle, name, kind, schema = null, type = null) {
    this.handle = handle
    this.name = name
    this.kind = kind
    this.schema = schema
    this.type = type
  }

  /**
   * Attach a `Ref` property to `target` for every entry in `refs`, so callers
   * write `handle.someRef` instead of looking refs up by name.
   *
   * @param {Owner} target
   * @param {Record<string, RefInfo>} refs
   * @param {Record<string, Spec>} [handles]  The handle types, so `target.room.notes` names every room's notes.
   */
  static attach(target, refs, handles) {
    for (const [name, info] of Object.entries(refs || {})) {
      // a ref named like a reserved member must fail loud, not overwrite it
      if (name in target) {
        throw CeroError.INVALID(
          `schema ref '${name}' collides with a reserved ${target.constructor?.name || 'handle'} member — rename it`
        )
      }
      const ref = (target[name] = new Ref(target, name, info.kind, info.schema))
      for (const [sub, i] of Object.entries(handles?.[name]?.meta?.refs || {})) {
        ref[sub] = new Ref(target, sub, i.kind, i.schema, name)
      }
    }
  }
}
