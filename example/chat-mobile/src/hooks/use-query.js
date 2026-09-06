import { useEffect, useState } from 'react'
import * as cero from '@cero-base/cero/client'

export function useQuery(ref, query) {
  const queryKey = query ? JSON.stringify(query) : ''
  const [data, setData] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!ref) return
    const stream = cero.watch(ref, query)
    stream.on('data', (snap) => setData(snap.data ?? snap))
    stream.on('error', setError)
    return () => stream.destroy()
  }, [ref, queryKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return { data: data || [], error }
}
