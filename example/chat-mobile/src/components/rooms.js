import { useState } from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import * as cero from '@cero-base/cero/client'
import { useCero } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { Button, Input, Card, ErrorBox, Page } from './ui'
import { Avatar } from './avatar'
import { styles, colors } from '../styles'

export function Rooms({ onOpen, onSettings }) {
  const me = useCero()
  const { data: rooms } = useQuery(me.room)
  const { data: profile } = useQuery(me.profile)
  const userName = profile?.name || me.id?.slice(0, 8)
  const [name, setName] = useState('')
  const [invite, setInvite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const room = await cero.open(me.room, { name: name.trim() })
      setName('')
      onOpen(room.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const join = async () => {
    setBusy(true)
    setError(null)
    try {
      const room = await cero.open(me.room, { invite: invite.trim() })
      setInvite('')
      onOpen(room.id)
    } catch (err) {
      setError(err.message || 'Failed to join room')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={styles.title}>Cero Chat</Text>
        <TouchableOpacity
          onPress={onSettings}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: 10,
            paddingVertical: 4,
            backgroundColor: colors.card,
            borderRadius: 999
          }}
        >
          <Avatar name={userName} />
          <Text style={styles.muted}>{userName}</Text>
        </TouchableOpacity>
      </View>

      <ErrorBox message={error} />

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Input style={{ flex: 1 }} placeholder='Room name' value={name} onChangeText={setName} />
        <Button title={busy ? '...' : 'New'} onPress={create} disabled={!name.trim() || busy} />
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Input
          style={{ flex: 1 }}
          placeholder='Invite code'
          value={invite}
          onChangeText={setInvite}
        />
        <Button title={busy ? '...' : 'Join'} onPress={join} disabled={!invite || busy} />
      </View>

      {rooms.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>ROOMS</Text>
          {rooms.map((r) => (
            <Card key={r.id} onPress={() => onOpen(r.id)}>
              <Text style={styles.text}>{r.name || 'Unnamed'}</Text>
              <Text style={styles.muted}>{String(r.id).slice(0, 12)}...</Text>
            </Card>
          ))}
        </>
      )}
    </Page>
  )
}
