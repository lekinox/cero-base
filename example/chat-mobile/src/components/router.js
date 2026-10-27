import { useEffect, useState } from 'react'
import { View, Text, Linking } from 'react-native'
import { cero } from '@cero-base/cero/client'
import { restore } from 'chat-backend/client'
import { useCero } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { RoomContext } from '../context'
import { Header } from './ui'
import { Setup } from './setup'
import { Settings } from './settings'
import { Rooms } from './rooms'
import { Room as RoomView } from './room'
import { styles, colors } from '../styles'

export function Router() {
  const me = useCero()
  const [identity, setIdentity] = useState(me.id)
  return <Screens key={identity} onSwitch={() => setIdentity(me.id)} />
}

function Screens({ onSwitch }) {
  const me = useCero()
  const { data: profile } = useQuery(me.profile)
  const [view, setView] = useState('rooms')
  const [roomId, setRoomId] = useState(null)
  const [room, setRoom] = useState(null)
  const [request, setRequest] = useState(null)
  const [error, setError] = useState(null)

  const link = (invite) =>
    cero
      .link(me, invite, { onrequest: setRequest })
      .then(onSwitch)
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setRequest(null))

  // a device invite can arrive as a link too, scanned or tapped: <scheme>://link?invite=<invite>.
  // It only fills the field: linking replaces this device's identity, so the user taps for it
  const [fromLink, setFromLink] = useState('')
  useEffect(() => {
    const onUrl = ({ url }) => {
      const invite = /[?&]invite=([a-z0-9]+)/.exec(url)?.[1]
      if (invite) setFromLink(invite)
    }
    Linking.getInitialURL().then((url) => url && onUrl({ url }))
    const sub = Linking.addEventListener('url', onUrl)
    return () => sub.remove()
  }, [])

  if (!profile?.name) {
    if (request) {
      return (
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: colors.bg,
            padding: 32,
            gap: 8
          }}
        >
          <Text style={styles.muted}>Approve this device on your other device</Text>
          <Text style={styles.text} selectable>
            {request}
          </Text>
        </View>
      )
    }
    return (
      <Setup
        onCreate={(name) => cero.set(me.profile, { name })}
        onRecover={(phrase) => cero.restore(me, phrase).then(onSwitch)}
        onLink={link}
        invite={fromLink}
        error={error}
      />
    )
  }

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
