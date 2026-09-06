/**
 * Handle for a single topic membership on a {@link Network}. Wraps a hyperswarm
 * PeerDiscovery session and lets it switch between active/passive announce/lookup.
 */
export declare class Discovery {
    network: import("./index.js").Network;
    session: any;
    _mode: "active" | "passive";
    _destroyed: boolean;
    /**
     * @param {import('./index.js').Network} network  Owning network.
     * @param {any} session  Hyperswarm PeerDiscovery session from `swarm.join()`.
     * @param {'active' | 'passive'} mode
     */
    constructor(network: import('./index.js').Network, session: any, mode: 'active' | 'passive');
    /** @returns {'active' | 'passive'} */
    get mode(): 'active' | 'passive';
    /** @returns {boolean} */
    get destroyed(): boolean;
    /**
     * Switch to active (client+server) announce/lookup.
     *
     * @returns {Promise<void>}
     */
    activate(): Promise<void>;
    /**
     * Switch to passive announce.
     *
     * @returns {Promise<void>}
     */
    deactivate(): Promise<void>;
    /**
     * Wait for the current announce/lookup to settle.
     *
     * @returns {Promise<void>}
     */
    flush(): Promise<void>;
    /**
     * Leave the topic and tear down the session. Idempotent.
     *
     * @returns {Promise<void>}
     */
    destroy(): Promise<void>;
}
