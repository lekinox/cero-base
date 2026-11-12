import { useCero } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'

// another device of the profile removed this one: its own row is gone from the list
export function Removed() {
  const me = useCero()
  const { data: devices } = useQuery(me.devices)
  if (!devices.length || devices.some((d) => d.id === me.device?.id)) return null
  return (
    <div className='p-2 bg-error/10 border border-error/30 rounded text-xs text-error'>
      This device was removed from your profile
    </div>
  )
}
