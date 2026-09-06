import { useContext } from 'react'
import { CeroContext, RoomContext } from '../context'

export function useCero() {
  const me = useContext(CeroContext)
  if (!me) throw new Error('useCero requires <Cero> provider')
  return me
}

export function useRoom() {
  return useContext(RoomContext)
}
