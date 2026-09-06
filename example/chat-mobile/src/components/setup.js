import { useState } from 'react'
import { Text, View, TextInput } from 'react-native'
import { Button, Input, Page, ErrorBox } from './ui'
import { styles, colors } from '../styles'

export function Setup({ onCreate, onRecover }) {
  const [name, setName] = useState('')
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const run = (fn) => {
    setBusy(true)
    setError(null)
    Promise.resolve(fn())
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <Page>
      <Text style={styles.title}>Cero Chat</Text>

      <ErrorBox message={error} />

      <Input placeholder='Your name' value={name} onChangeText={setName} autoFocus />
      <Button
        title={busy ? '…' : 'Continue'}
        onPress={() => run(() => onCreate(name.trim()))}
        disabled={!name.trim() || busy}
      />

      <View style={{ borderTopColor: colors.border, borderTopWidth: 1, paddingTop: 12, gap: 8 }}>
        <Text style={styles.muted}>Or sign in with a seed from another device</Text>
        <TextInput
          style={{
            paddingHorizontal: 14,
            paddingVertical: 10,
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 6,
            color: colors.text,
            fontSize: 13,
            minHeight: 80,
            textAlignVertical: 'top'
          }}
          placeholder='Enter your 12-word seed phrase'
          placeholderTextColor={colors.muted}
          value={phrase}
          onChangeText={setPhrase}
          multiline
        />
        <Button
          title={busy ? '…' : 'Use Existing Seed'}
          variant='secondary'
          onPress={() => run(() => onRecover(phrase.trim().replace(/\s+/g, ' ')))}
          disabled={!phrase.trim() || busy}
        />
      </View>
    </Page>
  )
}
