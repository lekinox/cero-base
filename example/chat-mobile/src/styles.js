import { StyleSheet } from 'react-native'

export const colors = {
  bg: '#0f172a',
  card: '#1e293b',
  border: '#334155',
  text: '#f1f5f9',
  muted: '#94a3b8',
  accent: '#06b6d4',
  primary: '#0891b2',
  destructive: '#dc2626'
}

export const styles = StyleSheet.create({
  page: { flex: 1, padding: 16, gap: 12, backgroundColor: colors.bg },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 18, fontWeight: 'bold', color: colors.accent },
  text: { fontSize: 14, color: colors.text },
  muted: { fontSize: 12, color: colors.muted },
  card: {
    padding: 12,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8
  },
  sectionLabel: { fontSize: 11, color: colors.muted, textTransform: 'uppercase', marginTop: 8 }
})
