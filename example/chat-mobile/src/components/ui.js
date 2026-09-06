import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native'
import { colors } from '../styles'

const ui = StyleSheet.create({
  button: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 6, alignItems: 'center' },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  ghost: {},
  danger: { backgroundColor: colors.destructive },
  textPrimary: { color: '#fff', fontSize: 13, fontWeight: '600' },
  textGhost: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  textSecondary: { color: colors.text, fontSize: 13, fontWeight: '600' },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 6,
    color: colors.text,
    fontSize: 13
  },
  errorBox: {
    padding: 10,
    backgroundColor: '#3a1212',
    borderColor: colors.destructive,
    borderWidth: 1,
    borderRadius: 6
  },
  errorText: { color: '#fca5a5', fontSize: 12 }
})

export function Button({ title, onPress, disabled, variant = 'primary', style }) {
  const variants = {
    primary: ui.primary,
    secondary: ui.secondary,
    ghost: ui.ghost,
    danger: ui.danger
  }
  const textVariants = {
    primary: ui.textPrimary,
    secondary: ui.textSecondary,
    ghost: ui.textGhost,
    danger: ui.textPrimary
  }
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[ui.button, variants[variant], disabled && { opacity: 0.5 }, style]}
    >
      <Text style={textVariants[variant]}>{title}</Text>
    </TouchableOpacity>
  )
}

export function Input({ style, ...props }) {
  return <TextInput style={[ui.input, style]} placeholderTextColor={colors.muted} {...props} />
}

export function Card({ children, onPress, style }) {
  const Wrap = onPress ? TouchableOpacity : View
  return (
    <Wrap
      onPress={onPress}
      style={[
        {
          padding: 12,
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 8
        },
        style
      ]}
    >
      {children}
    </Wrap>
  )
}

export function Section({ title, children }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 11, color: colors.muted, textTransform: 'uppercase' }}>{title}</Text>
      {children}
    </View>
  )
}

export function Page({ children, style }) {
  return (
    <View
      style={[{ flex: 1, padding: 16, paddingTop: 64, gap: 12, backgroundColor: colors.bg }, style]}
    >
      {children}
    </View>
  )
}

export function Header({ onBack, title, children }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      {onBack && (
        <TouchableOpacity onPress={onBack}>
          <Text style={{ color: colors.accent, fontSize: 18 }}>←</Text>
        </TouchableOpacity>
      )}
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }}>{title}</Text>
      {children && <View style={{ flex: 1 }} />}
      {children}
    </View>
  )
}

export function ErrorBox({ message }) {
  if (!message) return null
  return (
    <View style={ui.errorBox}>
      <Text style={ui.errorText}>{message}</Text>
    </View>
  )
}
