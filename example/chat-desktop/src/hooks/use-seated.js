import { useCero } from './use-cero'
import { useQuery } from './use-query'

// false once another device of the profile removed this one: its own row is gone from the list
export function useSeated() {
  const me = useCero()
  const { data: devices } = useQuery(me.devices)
  return !devices.length || devices.some((d) => d.id === me.device?.id)
}
