import { Text, View } from 'react-native'
import { styles, colors } from '../styles'

export function Toast({ message }) {
  if (!message) return null
  return (
    <View
      style={{
        position: 'absolute',
        bottom: 50,
        alignSelf: 'center',
        paddingHorizontal: 18,
        paddingVertical: 10,
        backgroundColor: colors.card,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 8
      }}
    >
      <Text style={styles.text}>{message}</Text>
    </View>
  )
}
