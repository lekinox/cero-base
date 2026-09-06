import { t } from '../lib/spec.js'
import { get, set, after } from '../lib/operators.js'

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
      const publish = (child, profile) =>
        set(child.members, { id: me.identity.id, ...profile }, { upsert: false }).catch(me._onerror)

      // an unconditional set on every open is a room-wide op forever
      const onHandle = async (child) => {
        const { data: profile } = await get(me.profile)
        if (!profile) return
        const { data: member } = await get(child.members, me.identity.id)
        if (member && keys.every((k) => member[k] === profile[k])) return
        publish(child, profile)
      }

      const onProfile = (ctx) => {
        if (ctx.row) me.children.forEach((child) => publish(child, ctx.row))
      }

      me.on('handle', (child) => onHandle(child).catch(me._onerror), { signal: me.signal })
      after(me.profile, onProfile, { signal: me.signal })
    }
  }
}
