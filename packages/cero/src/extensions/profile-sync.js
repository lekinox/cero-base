import { t } from '../lib/spec.js'
import { get, set, changes } from '../lib/operators.js'

/**
 * Mirror your `profile` onto your `member` row in every handle you're in.
 *
 * @param {{ fields?: Record<string, any> }} [opts]
 */
export function profileSync({ fields = { avatar: t.string } } = {}) {
  return {
    name: 'profile-sync',
    bundled: true,
    schema: {
      profile: t.single({ name: t.string, ...fields }),
      members: t.extend(fields)
    },
    setup(me) {
      const keys = ['name', ...Object.keys(fields)]

      // an unconditional set on every open is a room-wide op forever
      const publish = async (child, profile) => {
        const { data: member } = await get(child.members, me.identity.id)
        if (member && keys.every((k) => member[k] === profile[k])) return
        await set(child.members, { id: me.identity.id, ...profile }, { upsert: false })
      }

      const onHandle = async (child) => {
        const { data: profile } = await get(me.profile)
        if (profile) await publish(child, profile)
      }

      me.on('handle', (child) => onHandle(child).catch(me._onerror), { signal: me.signal })

      // a local edit and one replicated from another device both land here
      const stream = changes(me.profile, {}, { signal: me.signal })
      stream.on('error', me._onerror)
      stream.on('data', ({ changes: batch }) => {
        for (const { next } of batch) {
          if (next) me.children.forEach((child) => publish(child, next).catch(me._onerror))
        }
      })
    }
  }
}
