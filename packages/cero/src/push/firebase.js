import b4a from 'b4a'

/**
 * `@react-native-firebase/messaging` as the messaging service `connect` takes for push: pass `messaging()`. Pushes to the app in
 * front; the push worklet answers the ones the OS delivers while it is not.
 *
 * @param {{ subscribeToTopic: (topic: string) => Promise<void>, unsubscribeFromTopic: (topic: string) => Promise<void>, onMessage: (fn: (message: object) => void) => () => void }} messaging
 * @returns {import('../rpc/push.js').Messaging}
 */
export function firebase(messaging) {
  const payload = (message) => message?.data?.payload && b4a.from(message.data.payload, 'base64')
  return {
    subscribe: (topic) => messaging.subscribeToTopic(topic),
    unsubscribe: (topic) => messaging.unsubscribeFromTopic(topic),
    on(event, fn) {
      if (event !== 'push') return () => {}
      return messaging.onMessage((message) => {
        const bytes = payload(message)
        if (bytes) fn(bytes)
      })
    }
  }
}
