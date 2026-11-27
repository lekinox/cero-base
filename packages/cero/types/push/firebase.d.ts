/**
 * `@react-native-firebase/messaging` as the messaging service `connect` takes for push: pass `messaging()`. Pushes to the app in
 * front; the push worklet answers the ones the OS delivers while it is not.
 *
 * @param {{ subscribeToTopic: (topic: string) => Promise<void>, unsubscribeFromTopic: (topic: string) => Promise<void>, onMessage: (fn: (message: object) => void) => () => void }} messaging
 * @returns {import('../rpc/push.js').Messaging}
 */
export declare function firebase(messaging: {
    subscribeToTopic: (topic: string) => Promise<void>;
    unsubscribeFromTopic: (topic: string) => Promise<void>;
    onMessage: (fn: (message: object) => void) => () => void;
}): import('../rpc/push.js').Messaging;
