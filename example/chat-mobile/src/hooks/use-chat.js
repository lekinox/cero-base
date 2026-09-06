import { useEffect, useState } from 'react'
import { connect } from 'chat-backend/client'
import { getIPC } from '../lib/ipc'

export function useChat() {
  const [state, setState] = useState({ status: 'connecting' })

  useEffect(() => {
    let ipc
    let gone = false

    const cleanup = () => {
      gone = true
      try {
        ipc?.destroy()
      } catch {}
    }

    const boot = async () => {
      ipc = getIPC()
      try {
        const me = await connect(ipc)
        if (!gone) setState({ status: 'ready', me })
      } catch (err) {
        if (!gone) setState({ status: 'error', error: err.message || String(err) })
      }
    }

    boot()

    return cleanup
  }, [])

  return state
}
