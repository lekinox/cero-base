import { t } from '../lib/spec.js'
import { get, watch } from '../lib/operators.js'
import { mirror } from './mirror.js'

/**
 * Mirror your `profile` onto your `member` row in every handle you're in.
 *
 * @param {{ fields?: Record<string, object> }} [opts]  Extra fields, as `t` types.
 * @returns {import('./index.js').Extension}
 */
export function profileSync({ fields = { avatar: t.string } } = {}) {
  return {
    name: 'profile-sync',
    schema: {
      profile: t.single({ name: t.string, ...fields }),
      members: t.extend(fields)
    },
    setup(me) {
      const publish = (child, profile) =>
        mirror(me.profile, profile, fields, child.members, me.identity.id)

      const onHandle = async (child) => {
        const { data: profile } = await get(me.profile)
        if (profile) await publish(child, profile)
      }

      const onchild = (child) => onHandle(child).catch(me._onerror)
      me.on('handle', onchild)

      // a local edit and one replicated from another device both land here
      const stream = watch(me.profile, { changes: true }, { signal: me.signal })
      stream.on('error', me._onerror)
      stream.on('data', ({ changes: batch }) => {
        for (const { next } of batch) {
          if (next) me.children.forEach((child) => publish(child, next).catch(me._onerror))
        }
      })
      return () => me.off('handle', onchild)
    }
  }
}
