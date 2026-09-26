import { t } from '../lib/spec.js'
import { set, watch } from '../lib/operators.js'
import { mirror } from './mirror.js'

/**
 * Mirror a child handle's `profile` (name + avatar) onto its row in the parent's `handles`
 * list — so a handle list shows names + avatars without opening each one.
 *
 * @param {{ fields?: Record<string, object> }} [opts]  Extra fields, as `t` types.
 * @returns {import('./index.js').Extension}
 */
export function handleSync({ fields = { avatar: t.string } } = {}) {
  return {
    name: 'handle-sync',
    schema: { handles: t.extend(fields) },
    setup(me) {
      const onHandle = (child, opts) => {
        if (!child.profile) return
        if (opts.name) set(child.profile, { name: opts.name }).catch(me._onerror)
        watch(child.profile).on('data', ({ data }) => {
          if (!data?.name) return
          child.name = data.name
          mirror(child.profile, data, fields, me.handles, child.id).catch(me._onerror)
        })
      }
      me.on('handle', onHandle)
      return () => me.off('handle', onHandle)
    }
  }
}
