import { useState, useCallback, useEffect } from 'react'
import { cero } from '@cero-base/cero/client'
import { useCero } from './use-cero'
import { useQuery } from './use-query'

export function useTheme() {
  const me = useCero()
  const { data } = useQuery(me.local.settings)
  const stored = data?.find((r) => r.key === 'theme')?.value
  const [theme, set] = useState(stored || 'dark')

  useEffect(() => {
    if (stored && stored !== theme) set(stored)
  }, [stored]) // eslint-disable-line react-hooks/exhaustive-deps

  const setTheme = useCallback(
    (t) => {
      set(t)
      cero.put(me.local.settings, { id: 'theme', key: 'theme', value: t })
    },
    [me]
  )

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }, [theme, setTheme])

  return { theme, setTheme, toggle, isDark: theme === 'dark' }
}
