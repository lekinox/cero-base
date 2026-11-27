import { useEffect, useState } from 'react'
import { connect } from 'chat-backend/client'
import { getIPC } from '../lib/ipc'

const WORKER = '/workers/main.js'
// a store a quit left waiting for another device of the profile: the screen it waits on
const WAITING = { recovering: 'restoring', linking: 'linking' }

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

    // a phrase is recovered from another device of the profile, however long until one is online
    const boot = async (opts = {}, waiting = opts.phrase && 'restoring') => {
      setState(waiting ? { status: waiting, cancel } : { status: 'connecting' })
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
      .then((state) => {
        if (gone) return
        if (state) boot({}, WAITING[state])
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
