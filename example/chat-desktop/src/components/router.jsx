import { useEffect, useState } from 'react'
import * as cero from '@cero-base/cero/client'
import { useCero } from '../hooks/use-cero'
import { RoomContext } from '../context'
import { Page, Header } from './ui'
import { Settings } from './settings'
import { Rooms } from './rooms'
import { Room as RoomView } from './room'

export function Router() {
  const me = useCero()
  const [view, setView] = useState('rooms')
  const [roomId, setRoomId] = useState(null)
  const [room, setRoom] = useState(null)

  useEffect(() => {
    if (!roomId) {
      setRoom(null)
      return
    }
    if (room && room.id === roomId) return
    let cancelled = false
    cero
      .open(me.room, { id: roomId })
      .then((r) => {
        if (!cancelled) setRoom(r)
      })
      .catch((err) => {
        console.error('[router] failed to open room', roomId)
        console.error('error:', err)
        console.error('stack:', err?.stack)
        if (!cancelled) setRoomId(null)
      })
    return () => {
      cancelled = true
    }
  }, [roomId, me])

  if (roomId) {
    if (!room || room.id !== roomId) return null
    return (
      <RoomContext.Provider value={room}>
        <RoomView
          onClose={() => {
            setRoomId(null)
            setRoom(null)
          }}
        />
      </RoomContext.Provider>
    )
  }

  if (view === 'settings') {
    return (
      <Page>
        <Header onBack={() => setView('rooms')} title='Profile & Settings' />
        <Settings />
      </Page>
    )
  }

  return <Rooms onOpen={(id) => setRoomId(id)} onSettings={() => setView('settings')} />
}
