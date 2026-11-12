import { View, Text } from 'react-native'
import { CeroContext } from './context'
import { useChat } from './hooks/use-chat'
import { ErrorBoundary } from './components/error'
import { Router } from './components/router'
import { Setup } from './components/setup'
import { styles, colors } from './styles'

const center = {
  flex: 1,
  justifyContent: 'center',
  alignItems: 'center',
  backgroundColor: colors.bg,
  padding: 32,
  gap: 8
}

function App() {
  const { status, me, error, request, init } = useChat()

  if (status === 'error') {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colors.bg,
          padding: 32
        }}
      >
        <Text style={{ color: colors.destructive }}>{error}</Text>
      </View>
    )
  }
  if (status === 'setup') {
    return (
      <Setup
        onCreate={(name) => init({ name })}
        onRecover={(phrase) => init({ phrase })}
        onLink={(invite) => init({ invite })}
      />
    )
  }
  if (status === 'linking') {
    return (
      <View style={center}>
        <Text style={styles.muted}>Approve this device on your other device</Text>
        <Text style={styles.text} selectable>
          {request}
        </Text>
      </View>
    )
  }
  if (status === 'restoring') {
    return (
      <View style={center}>
        <Text style={styles.muted}>Looking for your other device…</Text>
        <Text style={styles.muted}>Keep one of your devices online</Text>
      </View>
    )
  }
  if (status !== 'ready') {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colors.bg
        }}
      >
        <Text style={styles.muted}>Loading...</Text>
      </View>
    )
  }

  return (
    <CeroContext.Provider value={me}>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Router />
      </View>
    </CeroContext.Provider>
  )
}

export default function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}
