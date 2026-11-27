import { useEffect, useState } from 'react'
import { connect } from 'chat-backend/client'
import { getIPC, peek } from '../lib/ipc'

// a store a quit left waiting for another device of the profile: the screen it waits on
const WAITING = { recovering: 'restoring', linking: 'linking' }

export function useChat() {
  const [state, setState] = useState({ status: 'checking' })

  useEffect(() => {
    let gone = false
    const ipc = getIPC()
    const fail = (err) => !gone && setState({ status: 'error', error: err.message || String(err) })

    // a phrase is recovered from another device of the profile, however long until one is online
    const boot = async (opts = {}, waiting = opts.phrase && 'restoring') => {
      setState({ status: waiting || 'connecting' })
      try {
        const me = await connect(ipc, {
          ...opts,
          // the id the other device shows in its requests: the user compares them before approving
          onrequest: (request) => !gone && setState({ status: 'linking', request })
        })
        if (!gone) setState({ status: 'ready', me })
      } catch (err) {
        fail(err)
      }
    }

    peek(ipc).then((held) => {
      if (gone) return
      if (held) boot({}, WAITING[held])
      else setState({ status: 'setup', init: boot })
    }, fail)

    return () => {
      gone = true
      try {
        ipc.destroy()
      } catch {}
    }
  }, [])

  return state
}
