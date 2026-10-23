export type Backend = {
    subscribe: (topic: string) => Promise<void>;
    unsubscribe: (topic: string) => Promise<void>;
    on: (event: 'push', fn: (payload: Uint8Array) => void) => (() => void) | void;
};
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
export declare function follow(me: import('./client.js').Client, backend: Backend): () => void;
