import { can, WRITE } from '@cero-base/core/utils'

import { t } from '../lib/spec.js'
import { get, watch } from '../lib/operators.js'
import { mirror } from './mirror.js'

/**
 * Mirror your `profile` onto your `member` row in every handle you're in, open or closed here.
 *
 * @param {{ fields?: Record<string, object> }} [opts]  Extra fields, as `t` types.
 * @returns {import('./index.js').Extension}
 */
export function profileSync({ fields = { avatar: t.string } } = {}) {
  const keys = ['name', ...Object.keys(fields)]
  return {
    name: 'profile-sync',
    schema: {
      profile: t.single({ name: t.string, ...fields }),
      members: t.extend(fields)
    },
    setup(me) {
      const publish = async (child, profile) => {
        try {
          // a reader's row takes it in a room at the version where every release reads it alike
          const { data: row } = await get(child.members, me.identity.id)
          if (row && !can(row.role, WRITE) && !(await child.store._seatless())) return
          await mirror(me.profile, profile, fields, child.members, me.identity.id)
        } catch (err) {
          // a handle that closed meanwhile has no member row left to update
          if (!child.closing) throw err
        }
      }

      const onHandle = async (child) => {
        const { data: profile } = await get(me.profile)
        if (profile) await publish(child, profile)
      }

      const onchild = (child) => onHandle(child).catch(me._onerror)
      me.on('handle', onchild)

      // the rooms closed here hear of a change through the root's pass over them
      me._tellers.push({
        async stamp() {
          const { data } = await get(me.profile)
          return data ? JSON.stringify(keys.map((k) => data[k]?.id ?? data[k] ?? null)) : null
        },
        tell: onHandle
      })

      // a local edit and one replicated from another device both land here
      const stream = watch(me.profile, { changes: true }, { signal: me.signal })
      stream.on('error', me._onerror)
      stream.on('data', ({ changes: batch }) => {
        for (const { next } of batch) {
          if (next) me.children.forEach((child) => publish(child, next).catch(me._onerror))
        }
        if (batch.length) me._tellClosed()
      })
      return () => me.off('handle', onchild)
    }
  }
}
