import { t } from '../lib/spec.js'
import { get, set, watch } from '../lib/operators.js'

/**
 * Mirror a child handle's `profile` (name + avatar) onto its row in the parent's `handles`
 * list — so a handle list shows names + avatars without opening each one.
 *
 * @param {{ fields?: Record<string, any> }} [opts]
 */
export function handleSync({ fields = { avatar: t.string } } = {}) {
  return {
    name: 'handle-sync',
    schema: { handles: t.extend(fields) },
    setup(me) {
      const keys = ['name', ...Object.keys(fields)]
      // an unconditional set on every open is a new op in the log forever
      const reflect = async (child, data) => {
        child.name = data.name
        const { data: row } = await get(me.handles, child.id)
        if (row && keys.every((k) => row[k] === data[k])) return
        await set(me.handles, { id: child.id, ...data }, { upsert: false })
      }
      const onHandle = (child, opts) => {
        if (!child.profile) return
        if (opts.name) set(child.profile, { name: opts.name }).catch(me._onerror)
        watch(child.profile).on('data', ({ data }) => {
          if (!data?.name) return
          reflect(child, data).catch(me._onerror)
        })
      }
      me.on('handle', onHandle, { signal: me.signal })
    }
  }
}
