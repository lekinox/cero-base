import ReadyResource from 'ready-resource';
/**
 * `me.bluetooth` — the app-facing surface for nearby (Bluetooth) sync, a thin facade over
 * ble-swarm.
 *
 * @extends ReadyResource
 */
export declare class Bluetooth extends ReadyResource {
    /** @private */
    _handle;
    /** @private */
    _autoStart;
    /** @type {{ hex: string, count: number, timer: ReturnType<typeof setTimeout> | null } | null} active invite rendezvous (single topic — one at a time) */
    _announce: {
        hex: string;
        count: number;
        timer: ReturnType<typeof setTimeout> | null;
    } | null;
    /** @private */
    _restorePending;
    /** @private */
    _topic;
    /** @type {import('ble-swarm')} */
    swarm: import('ble-swarm');
    /**
     * @param {import('../handle/index.js').Handle} handle  The root: its network, identity and channel.
     * @param {object} [opts]
     * @param {object | null} [opts.backend]  Injected bare-bluetooth-shaped backend (tests); omitted → ble-swarm loads its own, null/false → unsupported.
     * @param {boolean} [opts.autoStart]  Start on handle open (from `cero({ bluetooth: true })`).
     * @param {number} [opts.maxOutbound]  Max concurrent outbound links; gossip covers the rest.
     * @param {number} [opts.maxInbound]   Max concurrent inbound sessions; newcomers past this are refused.
     * @param {'l2cap' | 'gatt'} [opts.pipe]  Data pipe — 'l2cap' (default, faster) or 'gatt'. Both peers must match.
     */
    constructor(handle: import('../handle/index.js').Handle, { backend, autoStart, maxOutbound, maxInbound, pipe }?: {
        backend?: object | null;
        autoStart?: boolean;
        maxOutbound?: number;
        maxInbound?: number;
        pipe?: 'l2cap' | 'gatt';
    });
    /** @returns {'unsupported'|'unauthorized'|'off'|'waiting'|'starting'|'on'} */
    get state(): 'unsupported' | 'unauthorized' | 'off' | 'waiting' | 'starting' | 'on';
    /** @returns {Map<string, object>} Live BLE links, keyed by peer public key. */
    get peers(): Map<string, object>;
    /** @private */
    private _open;
    /** @private */
    private _close;
    /**
     * Begin advertising + scanning. Idempotent; no-op when unsupported.
     *
     * @returns {Promise<void>}
     */
    start(): Promise<void>;
    /**
     * Stop advertising/scanning and drop links; open invite rendezvous end with the radio.
     *
     * @returns {Promise<void>}
     */
    stop(): Promise<void>;
    /**
     * Offline join rendezvous: retune the radio to the invite-derived topic so holder and
     * joiner find each other with zero DHT.
     *
     * @param {string} invite  Z32 invite string.
     * @returns {() => void}
     */
    announce(invite: string): () => void;
    /**
     * Host-lifecycle pause (app backgrounded): radio down, user intent kept.
     *
     * @returns {Promise<void>}
     */
    suspend(): Promise<void>;
    /**
     * Resume after a host-lifecycle pause.
     *
     * @returns {Promise<void>}
     */
    resume(): Promise<void>;
    /** @private */
    private _stopAnnounce;
    /** @private */
    private _clearAnnounce;
}
