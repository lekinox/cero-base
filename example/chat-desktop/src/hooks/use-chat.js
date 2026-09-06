import { useEffect, useState } from 'react'
import { connect } from 'chat-backend/client'
import { getIPC } from '../lib/ipc'

export function useChat() {
  const [state, setState] = useState({ status: 'checking' })

  useEffect(() => {
    let ipc
    let gone = false

    const cleanup = () => {
      gone = true
      try {
        ipc?.destroy()
      } catch {}
    }

    const boot = async (opts = {}) => {
      setState({ status: 'connecting' })
      ipc = getIPC('/workers/main.js')
      try {
        const me = await connect(ipc, opts)
        if (!gone) setState({ status: 'ready', me })
      } catch (err) {
        if (!gone) setState({ status: 'error', error: err.message || String(err) })
      }
    }

    window.bridge
      .isInitialized()
      .then((ok) => {
        if (gone) return
        if (ok) boot()
        else setState({ status: 'setup', init: boot })
      })
      .catch((err) => {
        // a locked store means another instance owns it; do not offer setup on top of it
        if (!gone) setState({ status: 'error', error: err.message || String(err) })
      })

    return cleanup
  }, [])

  return state
}
