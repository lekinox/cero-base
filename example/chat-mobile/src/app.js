import { View, Text } from 'react-native'
import { CeroContext } from './context'
import { useChat } from './hooks/use-chat'
import { ErrorBoundary } from './components/error'
import { Router } from './components/router'
import { styles, colors } from './styles'

function App() {
  const { status, me, error } = useChat()

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
