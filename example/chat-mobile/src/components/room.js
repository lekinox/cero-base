import { useState, useEffect, useRef } from 'react'
import { View, Text, ScrollView } from 'react-native'
import * as cero from '@cero-base/cero/client'
import { useCero, useRoom } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { Button, Input } from './ui'
import { styles, colors } from '../styles'

function MessageGroup({ messages, mine, sender }) {
  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', gap: 2, marginBottom: 4 }}>
      {!mine && (
        <Text style={{ fontSize: 11, color: colors.accent, marginBottom: 2 }}>{sender}</Text>
      )}
      {messages.map((m) => (
        <View
          key={m.id}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: mine ? colors.primary : colors.card
          }}
        >
          <Text style={{ color: mine ? '#fff' : colors.text, fontSize: 14 }}>{m.text}</Text>
        </View>
      ))}
    </View>
  )
}

function groupMessages(messages, myId) {
  const groups = []
  for (const m of messages) {
    const last = groups[groups.length - 1]
    if (last && last.memberId === m.memberId) {
      last.messages.push(m)
    } else {
      groups.push({ memberId: m.memberId, mine: m.memberId === myId, messages: [m] })
    }
  }
  return groups
}

export function Room({ onClose }) {
  const me = useCero()
  const room = useRoom()
  const { data: messages } = useQuery(room.messages)
  const { data: members } = useQuery(room.members)
  const [text, setText] = useState('')
  const [invite, setInvite] = useState('')
  const scroller = useRef(null)

  useEffect(() => {
    scroller.current?.scrollToEnd({ animated: true })
  }, [messages])

  const sorted = [...messages].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const groups = groupMessages(sorted, me.id)

  const send = async () => {
    const t = text.trim()
    if (!t) return
    setText('')
    await cero.put(room.messages, { text: t })
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          paddingTop: 48,
          backgroundColor: colors.card,
          borderBottomColor: colors.border,
          borderBottomWidth: 1
        }}
      >
        <Button title='←' onPress={onClose} variant='ghost' />
        <Text style={styles.muted}>{members.length} members</Text>
        <View style={{ flex: 1 }} />
        {invite ? (
          <Text style={[styles.muted, { fontFamily: 'monospace' }]} numberOfLines={1}>
            {invite.slice(0, 16)}...
          </Text>
        ) : (
          <Button title='Invite' onPress={() => room.invite().then(setInvite)} />
        )}
      </View>

      <ScrollView ref={scroller} style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
        {groups.map((g, i) => (
          <MessageGroup
            key={i}
            messages={g.messages}
            mine={g.mine}
            sender={members.find((x) => x.id === g.memberId)?.name || g.memberId?.slice(0, 8)}
          />
        ))}
      </ScrollView>

      <View
        style={{
          flexDirection: 'row',
          gap: 8,
          padding: 12,
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          borderTopWidth: 1
        }}
      >
        <Input
          style={{ flex: 1 }}
          placeholder='Message...'
          value={text}
          onChangeText={setText}
          onSubmitEditing={send}
        />
        <Button title='Send' onPress={send} />
      </View>
    </View>
  )
}
