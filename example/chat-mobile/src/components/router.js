import { useState } from 'react'
import { View, Text } from 'react-native'
import { cero } from '@cero-base/cero/client'
import { useCero } from '../hooks/use-cero'
import { RoomContext } from '../context'
import { Header } from './ui'
import { Settings } from './settings'
import { Rooms } from './rooms'
import { Room as RoomView } from './room'
import { styles, colors } from '../styles'

export function Router() {
  const me = useCero()
  const [view, setView] = useState('rooms')
  const [roomId, setRoomId] = useState(null)
  const [room, setRoom] = useState(null)

  if (roomId) {
    if (!room || room.id !== roomId) {
      cero
        .open(me.room, { id: roomId })
        .then(setRoom)
        .catch(() => setRoomId(null))
      return (
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: colors.bg
          }}
        >
          <Text style={styles.muted}>Loading room...</Text>
        </View>
      )
    }
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
      <View style={{ flex: 1, paddingTop: 48, backgroundColor: colors.bg }}>
        <View style={{ paddingHorizontal: 16 }}>
          <Header onBack={() => setView('rooms')} title='Profile & Settings' />
        </View>
        <Settings />
      </View>
    )
  }

  return <Rooms onOpen={setRoomId} onSettings={() => setView('settings')} />
}
