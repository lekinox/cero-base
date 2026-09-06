import { useState } from 'react'
import { View, Text, ScrollView } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as cero from '@cero-base/cero/client'
import { useCero } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { useToast } from '../hooks/use-toast'
import { Button, Input, Card, Section } from './ui'
import { Avatar } from './avatar'
import { Toast } from './toast'
import { styles, colors } from '../styles'

export function Settings() {
  const me = useCero()
  const { data: profile } = useQuery(me.profile)
  const { data: devices } = useQuery(me.devices)
  const toast = useToast()
  const [name, setName] = useState(profile?.name || '')
  const [invite, setInvite] = useState('')

  const phrase = ''

  const save = async () => {
    const v = name.trim()
    if (v && v !== profile?.name) await cero.set(me.profile, { name: v })
  }

  const newInvite = async () => {
    try {
      const inv = await me.invite()
      setInvite(inv)
    } catch (err) {
      toast.show(err.message || 'invite failed')
    }
  }

  const copy = (text) => {
    Clipboard.setStringAsync(text)
    toast.show('Copied to clipboard')
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Avatar name={profile?.name} size={48} />
          <View style={{ flex: 1, gap: 4 }}>
            <Input value={name} onChangeText={setName} onBlur={save} />
            <Text style={styles.muted}>{String(me.id).slice(0, 16)}...</Text>
          </View>
        </View>
      </Card>

      <Section title='Devices'>
        {devices.map((d) => (
          <Card key={d.id}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={styles.text}>{d.name || 'Unnamed'}</Text>
              <Text style={styles.muted}>{d.id?.slice(0, 8)}</Text>
              {d.id === me.device?.id && <Text style={{ color: colors.accent }}>(current)</Text>}
            </View>
          </Card>
        ))}
      </Section>

      <Section title='Pair a device'>
        {invite ? (
          <>
            <Card>
              <Text style={[styles.text, { fontFamily: 'monospace' }]} selectable>
                {invite}
              </Text>
            </Card>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button title='Copy' onPress={() => copy(invite)} />
              <Button title='Clear' variant='secondary' onPress={() => setInvite('')} />
            </View>
          </>
        ) : (
          <Button title='Generate Device Invite' onPress={newInvite} />
        )}
      </Section>

      {phrase && (
        <Section title='Recovery phrase (write this down!)'>
          <Card>
            <Text style={[styles.text, { color: '#fbbf24' }]} selectable>
              {phrase}
            </Text>
          </Card>
        </Section>
      )}

      <Toast message={toast.message} />
    </ScrollView>
  )
}
