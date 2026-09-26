export type Session = {
    refresh(opts?: object): Promise<void>;
    flushed(): Promise<boolean>;
    destroy(): Promise<void>;
};
/**
 * Handle for a single topic membership on a {@link Network}. Wraps a hyperswarm
 * PeerDiscovery session and lets it switch between active/passive announce/lookup.
 */
/**
 * @typedef {{ refresh(opts?: object): Promise<void>, flushed(): Promise<boolean>, destroy(): Promise<void> }} Session
 *   The hyperswarm session `swarm.join()` returns, as far as this file uses it.
 */
export declare class Discovery {
    network: import("./index.js").Network;
    /** @type {Session} */
    session: Session;
    /** @private */
    _mode;
    /** @private */
    _destroyed;
    /** @private */
    _timer;
    /**
     * @param {import('./index.js').Network} network  Owning network.
     * @param {Session} session  Hyperswarm PeerDiscovery session from `swarm.join()`.
     * @param {'active' | 'passive'} mode
     */
    constructor(network: import('./index.js').Network, session: Session, mode: 'active' | 'passive');
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
    /** @private */
    private _requery;
    /**
     * Leave the topic and tear down the session. Idempotent.
     *
     * @returns {Promise<void>}
     */
    destroy(): Promise<void>;
}
