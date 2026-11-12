import { useEffect, useState } from 'react'
import { connect } from 'chat-backend/client'
import { getIPC } from '../lib/ipc'

const WORKER = '/workers/main.js'

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

    const cancel = async () => {
      ipc?.destroy()
      ipc = null
      await window.bridge.stopWorker(WORKER)
      if (!gone) setState({ status: 'setup', init: boot })
    }

    const boot = async (opts = {}) => {
      // a phrase is recovered from another device of the profile, however long until one is online
      setState(opts.phrase ? { status: 'restoring', cancel } : { status: 'connecting' })
      const run = (ipc = getIPC(WORKER))
      const live = () => !gone && ipc === run
      try {
        const me = await connect(run, {
          ...opts,
          // the id the other device shows in its requests: the user compares them before approving
          onrequest: (request) => live() && setState({ status: 'linking', request })
        })
        if (live()) setState({ status: 'ready', me })
      } catch (err) {
        if (live()) setState({ status: 'error', error: err.message || String(err) })
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
