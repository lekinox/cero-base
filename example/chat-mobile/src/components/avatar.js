import { View, Text } from 'react-native'
import { colors } from '../styles'

export function Avatar({ name, size = 28 }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.accent,
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: size * 0.45 }}>
        {(name || '?')[0].toUpperCase()}
      </Text>
    </View>
  )
}
