import ReadyResource from 'ready-resource';
import { Discovery } from './discovery.js';
/** @type {(topic: Uint8Array, channel: string | null) => Uint8Array} */
export declare function channelTopic(topic: Uint8Array<ArrayBufferLike>, channel: string): Uint8Array<ArrayBufferLike>;
export type NetworkOpts = {
    /**
     * Custom DHT bootstrap nodes.
     */
    bootstrap?: Array<{
        host: string;
        port: number;
    }>;
    /**
     * Incoming-connection filter.
     */
    firewall?: (remotePublicKey: Uint8Array, payload: unknown) => boolean;
    /**
     * Blind relay public keys; a connection goes through one only when a direct one fails or this device sits behind a randomizing NAT.
     */
    relayThrough?: Array<string | Uint8Array>;
    /**
     * Optional network-isolation label; only same-channel peers meet.
     */
    channel?: string;
    /**
     * Corestore; every connection replicates it, so every core it holds rides every peer.
     */
    store: import('corestore');
    /**
     * Blind-peer public keys; each attached database/blob core is mirrored through them for offline sync.
     */
    mirrors?: Array<string | Uint8Array>;
    /**
     * Background-task error handler.
     */
    onerror?: (err: Error) => void;
    /**
     * The budget for topics in the rotation: how many announce at once, and the ms one keeps its slot before a touched one may take it.
     */
    presence?: {
        active?: number;
        idle?: number;
    };
};
export type Entry = {
    id: string;
    session: import('./discovery.js').Session;
    /**
     * The store session the replicator session lives on.
     */
    store: import('corestore');
    /**
     * Joins holding the topic.
     */
    refs: number;
    /**
     * Joins pinning it.
     */
    pins: number;
};
/**
 * @typedef {object} NetworkOpts
 * @property {Array<{ host: string, port: number }>} [bootstrap]    Custom DHT bootstrap nodes.
 * @property {(remotePublicKey: Uint8Array, payload: unknown) => boolean} [firewall]  Incoming-connection filter.
 * @property {Array<string | Uint8Array>} [relayThrough]           Blind relay public keys; a connection goes through one only when a direct one fails or this device sits behind a randomizing NAT.
 * @property {string} [channel]                                     Optional network-isolation label; only same-channel peers meet.
 * @property {import('corestore')} store                            Corestore; every connection replicates it, so every core it holds rides every peer.
 * @property {Array<string | Uint8Array>} [mirrors]                Blind-peer public keys; each attached database/blob core is mirrored through them for offline sync.
 * @property {(err: Error) => void} [onerror]                      Background-task error handler.
 * @property {{ active?: number, idle?: number }} [presence]        The budget for topics in the rotation: how many announce at once, and the ms one keeps its slot before a touched one may take it.
 *
 * @typedef {object} Entry  One replicator session per topic, shared by every join of it.
 * @property {string} id
 * @property {import('./discovery.js').Session} session
 * @property {import('corestore')} store  The store session the replicator session lives on.
 * @property {number} refs  Joins holding the topic.
 * @property {number} pins  Joins pinning it.
 */
/**
 * Peer discovery and connections on hyperjoin, plus a shared wakeup channel. Every connection,
 * the replicator's or injected, replicates the store.
 */
export declare class Network extends ReadyResource {
    bootstrap: {
        host: string;
        port: number;
    }[];
    firewall: (remotePublicKey: Uint8Array, payload: unknown) => boolean;
    relayThrough: any[];
    channel: string;
    /** @type {import('corestore')} */
    store: import('corestore');
    /** @type {Uint8Array[]} */
    mirrors: Uint8Array[];
    /** @type {{ active: number, idle: number }} */
    presence: {
        active: number;
        idle: number;
    };
    /** @private */
    _replicator;
    /** @private */
    _dht;
    /** @type {import('protomux-wakeup')} */
    wakeup: import('protomux-wakeup');
    /** @private @type {Map<string, Entry>} */
    _sessions;
    /** @private @type {Set<Discovery>} */
    _discoveries;
    /** @private */
    _injected;
    /** @private */
    _blindPeering;
    /** @private */
    _peeringClosed;
    /** @private */
    _listening;
    /** @private */
    _refreshing;
    /** @private */
    _resuming;
    /** @private */
    _relookup;
    /** @private */
    _onerror;
    /** @param {NetworkOpts} opts */
    constructor({ bootstrap, firewall, relayThrough, channel, store, mirrors, presence, onerror }?: NetworkOpts);
    /** @returns {import('hyperjoin') | null} The underlying hyperjoin replicator, or null before ready / after close. */
    get replicator(): import('hyperjoin') | null;
    /** @returns {import('hyperdht') | null} The DHT the replicator and the mirrors share. */
    get dht(): import('hyperdht') | null;
    /** @returns {Map<string, object>} Known peers keyed by public-key hex. */
    get peers(): Map<string, object>;
    /** @returns {Set<import('@hyperswarm/secret-stream')>} Live connection streams — the replicator's and injected. */
    get connections(): Set<import('@hyperswarm/secret-stream')>;
    /** @returns {boolean} */
    get suspended(): boolean;
    /** @private */
    private _open;
    /** @private */
    private _close;
    /**
     * Feed an externally-established connection — a Bluetooth L2CAP channel, a serial link, an
     * in-process pair, any duplex — into the network.
     *
     * @param {import('streamx').Duplex} stream  Duplex transport, or a ready NoiseSecretStream.
     * @param {{ isInitiator?: boolean }} [opts]  Which side initiates the noise handshake (raw duplexes only).
     * @returns {import('@hyperswarm/secret-stream')} The encrypted connection stream.
     */
    inject(stream: import('streamx').Duplex, { isInitiator }?: {
        isInitiator?: boolean;
    }): import('@hyperswarm/secret-stream');
    /** @private */
    private _add;
    /**
     * Stop mirroring, before the databases close: blind peering reads storage for every database it
     * mirrors, so once it is closed none of its work outlives storage. `peering()` throws CLOSED
     * after it; closing the network does it too.
     *
     * @returns {Promise<void>}
     */
    closePeering(): Promise<void>;
    /**
     * The blind-peering client, built on first use: a mailbox post names mirrors this network
     * may not have been given.
     *
     * @returns {import('blind-peering')}
     */
    peering(): import('blind-peering');
    /**
     * Wait for pending DHT announces, lookups and dials to settle, bounded by timeout.
     *
     * @param {{ timeout?: number }} [opts]
     * @returns {Promise<void>}
     */
    flush({ timeout }?: {
        timeout?: number;
    }): Promise<void>;
    /** @private */
    private _flush;
    /**
     * Pause the network — keeps state, drops sockets. Idempotent.
     *
     * @returns {Promise<void>}
     */
    suspend(): Promise<void>;
    /**
     * Resume a suspended network. Idempotent.
     *
     * @returns {Promise<void>}
     */
    resume(): Promise<void>;
    /** @private */
    private _resume;
    /**
     * Join a 32-byte topic and return a Discovery handle. Pinned by default: it announces and
     * looks up now; `pin: false` leaves it to the rotation.
     *
     * @param {Uint8Array} topic
     * @param {{ pin?: boolean }} [opts]
     * @returns {Discovery}
     */
    join(topic: Uint8Array, { pin }?: {
        pin?: boolean;
    }): Discovery;
    /**
     * Where a topic stands on this network.
     *
     * @param {Uint8Array} topic
     * @returns {'inactive' | 'pinned' | 'autostarted' | 'discovering' | null} Its session's state, null when not joined.
     */
    state(topic: Uint8Array): 'inactive' | 'pinned' | 'autostarted' | 'discovering' | null;
    /**
     * Whether `store` replicates on this network's connections: the network's store or a session of it.
     *
     * @param {import('corestore')} store
     * @returns {boolean}
     */
    replicates(store: import('corestore')): boolean;
    /**
     * Keep a core or an autobee on the mirrors, so it stays reachable while its writers are
     * offline. It rides the connections already, from the store; a mirror drops it once it closes.
     *
     * @param {import('hypercore') | import('autobee')} core
     * @returns {void}
     */
    attach(core: import('hypercore') | import('autobee')): void;
    /** @private */
    private _mirror;
    /** @private */
    private _leave;
    /** @private */
    private _settle;
    /** @private */
    private _refresh;
    /** @private */
    private _rotate;
    /** @private */
    private _relook;
}
