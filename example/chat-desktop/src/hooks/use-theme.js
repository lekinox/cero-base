import { useState, useCallback, useEffect } from 'react'
import * as cero from '@cero-base/cero/client'
import { useCero } from './use-cero'
import { useQuery } from './use-query'

const KEY = 'cero-theme'

function apply(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  localStorage.setItem(KEY, theme)
}

apply(localStorage.getItem(KEY) || 'dark')

export function useTheme() {
  const me = useCero()
  const [theme, set] = useState(localStorage.getItem(KEY) || 'dark')
  const { data } = useQuery(me.settings)
  const stored = data?.find((r) => r.key === 'theme')?.value

  useEffect(() => {
    if (stored && stored !== theme) {
      set(stored)
      apply(stored)
    }
  }, [stored]) // eslint-disable-line react-hooks/exhaustive-deps

  const setTheme = useCallback(
    (t) => {
      set(t)
      apply(t)
      cero.put(me.settings, { key: 'theme', value: t })
    },
    [me]
  )

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }, [theme, setTheme])

  return { theme, setTheme, toggle, isDark: theme === 'dark' }
}
