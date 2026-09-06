import { Component } from 'react'
import { View, Text, ScrollView } from 'react-native'
import { styles, colors } from '../styles'

export class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('[CeroChat] Unhandled error:', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 32, paddingTop: 64 }}>
        <ScrollView contentContainerStyle={{ gap: 12 }}>
          <Text style={styles.title}>CeroChat crashed</Text>
          <Text style={{ color: colors.destructive }}>
            {this.state.error.message || String(this.state.error)}
          </Text>
          <Text style={styles.muted}>{this.state.error.stack}</Text>
        </ScrollView>
      </View>
    )
  }
}
