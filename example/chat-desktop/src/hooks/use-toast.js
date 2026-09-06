import { useState, useCallback, useRef } from 'react'

export function useToast(duration = 2000) {
  const [message, setMessage] = useState(null)
  const timer = useRef(null)

  const show = useCallback(
    (msg) => {
      if (timer.current) clearTimeout(timer.current)
      setMessage(msg)
      timer.current = setTimeout(() => setMessage(null), duration)
    },
    [duration]
  )

  return { message, show }
}
