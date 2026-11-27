export type Session = {
    state: 'inactive' | 'pinned' | 'autostarted' | 'discovering' | 'destroyed';
    active: boolean;
    priority: number;
    closing: Promise<void> | null;
    discovery: {
        refresh(): void;
    } | null;
    pin: () => void;
    unpin: () => void;
    discover: () => void;
    flush: () => Promise<void>;
    destroy: () => Promise<void>;
    on: (event: string, listener: (session: Session) => void) => void;
};
/**
 * @typedef {object} Session  The hyperjoin session a topic has, as far as cero uses it.
 * @property {'inactive' | 'pinned' | 'autostarted' | 'discovering' | 'destroyed'} state
 * @property {boolean} active
 * @property {number} priority
 * @property {Promise<void> | null} closing
 * @property {{ refresh(): void } | null} discovery
 * @property {() => void} pin
 * @property {() => void} unpin
 * @property {() => void} discover
 * @property {() => Promise<void>} flush
 * @property {() => Promise<void>} destroy
 * @property {(event: string, listener: (session: Session) => void) => void} on
 */
/**
 * Handle for one topic membership on a {@link Network}: a view on the session the topic has,
 * shared by every join of it. Pinned, it announces and looks up until released; in the
 * rotation, it announces while it holds a slot, ranked by its last touch.
 */
export declare class Discovery {
    network: import("./index.js").Network;
    /** @private */
    entry;
    /** @private */
    _pinned;
    /** @private */
    _destroyed;
    /**
     * @param {import('./index.js').Network} network  Owning network.
     * @param {import('./index.js').Entry} entry  The topic's session, shared by every join of it.
     * @param {boolean} pin
     */
    constructor(network: import('./index.js').Network, entry: import('./index.js').Entry, pin: boolean);
    /** @returns {Session} */
    get session(): Session;
    /** @returns {'inactive' | 'pinned' | 'autostarted' | 'discovering' | 'destroyed'} */
    get state(): 'inactive' | 'pinned' | 'autostarted' | 'discovering' | 'destroyed';
    /** @returns {boolean} Whether the topic announces or looks up right now. */
    get active(): boolean;
    /** @returns {boolean} */
    get destroyed(): boolean;
    /**
     * Pin the topic and look up now: it announces and looks up until `deactivate()`, outside the
     * rotation's budget.
     *
     * @returns {Promise<void>}
     */
    activate(): Promise<void>;
    /**
     * Unpin the topic: the rotation decides, by its last touch.
     *
     * @returns {Promise<void>}
     */
    deactivate(): Promise<void>;
    /** Rank the topic first in the rotation, as just used. */
    touch(): void;
    /** Rank the topic last: it keeps a slot only while one is spare. */
    release(): void;
    /**
     * Wait for the current announce or lookup to settle.
     *
     * @returns {Promise<void>}
     */
    flush(): Promise<void>;
    /**
     * Leave the topic, once every join of it has. Idempotent.
     *
     * @returns {Promise<void>}
     */
    destroy(): Promise<void>;
    /** @private */
    private _pin;
    /** @private */
    private _rank;
}
