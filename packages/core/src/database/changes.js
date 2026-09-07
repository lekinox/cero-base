import { Readable } from 'streamx'
import b4a from 'b4a'

/**
 * Pull-driven delta stream over a collection: batches of `{ prev, next }` pairs diffed
 * from the head this stream last reported.
 *
 * @param {import('./index.js').Database} db
 * @param {string} name    Ref name (scopes the update ticks).
 * @param {string} col     Collection path (`@ns/name`).
 * @param {(row: any) => boolean} matches
 * @returns {import('streamx').Readable}
 */
export function makeChanges(db, name, col, matches) {
  let at = null
  let dirty = true
  let wake = null

  const mark = () => {
    dirty = true
    if (wake !== null) wake()
  }
  const off = db.onUpdate(name, mark)

  const stream = new Readable({
    async read(cb) {
      try {
        let batch = null
        while (batch === null && !stream.destroying) {
          if (!dirty) await new Promise((resolve) => (wake = resolve))
          dirty = false
          batch = await diff()
        }
        if (batch !== null) stream.push(batch)
        cb(null)
      } catch (err) {
        cb(err)
      }
    },
    predestroy() {
      off()
      mark()
    }
  })

  const diff = async () => {
    const view = db.view
    // snapshot() and head() are synchronous, so the cursor is exactly-once
    const snap = view.snapshot()
    const head = view.engine.head()
    const reset =
      at === null || at.view !== view || head === null || !b4a.equals(at.head.key, head.key)
    try {
      const changes = []
      for await (const { left, right } of snap.diff(col, reset ? {} : { from: at.head })) {
        const prev = left && matches(left) ? left : null
        const next = right && matches(right) ? right : null
        if (prev || next) changes.push({ prev, next })
      }
      at = head && { head, view }
      return reset || changes.length ? { changes, reset } : null
    } finally {
      await snap.close().catch(() => {})
    }
  }

  return stream
}
