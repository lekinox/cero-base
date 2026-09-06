import ReadyResource from 'ready-resource';
/**
 * `me.bluetooth` — the app-facing surface for nearby (Bluetooth) sync, a thin facade over
 * ble-swarm.
 *
 * @extends ReadyResource
 */
export declare class Bluetooth extends ReadyResource {
    _handle: object;
    _autoStart: boolean;
    /** @type {{ hex: string, count: number, timer: any } | null} active invite rendezvous (single topic — one at a time) */
    _announce: {
        hex: string;
        count: number;
        timer: any;
    } | null;
    _restorePending: boolean;
    _topic: any;
    swarm: any;
    /**
     * @param {object} handle           Root cero Handle (network + identity + channel).
     * @param {object} [opts]
     * @param {any} [opts.backend]      Injected bare-bluetooth-shaped backend (tests); omitted → ble-swarm loads its own, null/false → unsupported.
     * @param {boolean} [opts.autoStart]  Start on handle open (from `cero({ bluetooth: true })`).
     * @param {number} [opts.maxOutbound]  Max concurrent outbound links; gossip covers the rest.
     * @param {number} [opts.maxInbound]   Max concurrent inbound sessions; newcomers past this are refused.
     * @param {'l2cap' | 'gatt'} [opts.pipe]  Data pipe — 'l2cap' (default, faster) or 'gatt'. Both peers must match.
     */
    constructor(handle: object, { backend, autoStart, maxOutbound, maxInbound, pipe }?: {
        backend?: any;
        autoStart?: boolean;
        maxOutbound?: number;
        maxInbound?: number;
        pipe?: 'l2cap' | 'gatt';
    });
    /** @returns {'unsupported'|'unauthorized'|'off'|'waiting'|'starting'|'on'} */
    get state(): 'unsupported' | 'unauthorized' | 'off' | 'waiting' | 'starting' | 'on';
    /** @returns {Map<string, any>} Live BLE links, keyed by peer public key. */
    get peers(): Map<string, any>;
    _open(): Promise<void>;
    _close(): Promise<void>;
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
    _stopAnnounce(): void;
    _clearAnnounce(): void;
}
