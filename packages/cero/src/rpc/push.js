import { watch, get, open, activate, receive } from '../lib/operators.js'

/**
 * @typedef {object} Backend  The platform's push service, as `connect` takes it.
 * @property {(topic: string) => Promise<void>} subscribe
 * @property {(topic: string) => Promise<void>} unsubscribe
 * @property {(event: 'push', fn: (payload: Uint8Array) => void) => (() => void) | void} on
 */

/**
 * Keep the device on the push topics of its handles, one subscription per handle, dropped when it
 * leaves; and act on a push: the handle it is about ranks first on the swarm.
 *
 * @param {import('./client.js').Client} me
 * @param {Backend} backend
 * @returns {() => void}
 */
export function follow(me, backend) {
  const topics = new Set()
  const stream = watch(me.topics)
  let closed = false
  const sync = async () => {
    for await (const { data } of stream) {
      const wanted = new Set(data.map((row) => row.id))
      // a subscribe that fails is left out, so the next change tries it again
      for (const topic of wanted) {
        if (topics.has(topic)) continue
        try {
          await backend.subscribe(topic)
          topics.add(topic)
        } catch (err) {
          me._onerror(err)
        }
      }
      for (const topic of topics) {
        if (wanted.has(topic)) continue
        topics.delete(topic)
        await backend.unsubscribe(topic).catch(me._onerror)
      }
    }
  }
  sync().catch((err) => closed || me._onerror(err))
  const off = backend.on('push', (payload) => wake(me, payload).catch(me._onerror))
  return () => {
    closed = true
    stream.destroy()
    if (off) off()
  }
}

// while the app sleeps the OS shows the push; the handle syncs first once it wakes on its own
async function wake(me, payload) {
  if ((await get(me.status)).data.suspended) return
  const hit = await receive(me, payload)
  if (!hit?.newer) return
  await activate(await open(me[hit.type], { id: hit.id }))
}
