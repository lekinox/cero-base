import ReadyResource from 'ready-resource';
import { Discovery } from './discovery.js';
import { Presence } from './presence.js';
/** @type {(topic: Uint8Array, channel: string | null) => Uint8Array} */
export declare function channelTopic(topic: Uint8Array<ArrayBufferLike>, channel: string): Uint8Array<ArrayBufferLike>;
export type NetworkOpts = {
    /**
     * Long-lived keypair used as the swarm identity.
     */
    identity?: import('../identity/index.js').Identity;
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
     * Relay public keys to tunnel through.
     */
    relayThrough?: Uint8Array[];
    /**
     * Reconnect backoff tiers in ms; the default escalates to ~10min, far too slow for local nets.
     */
    backoffs?: number[];
    /**
     * Optional network-isolation label; only same-channel peers meet.
     */
    channel?: string;
    /**
     * Corestore; required for mirrors (blind peers replicate its cores).
     */
    store?: import('corestore');
    /**
     * Blind-peer public keys; each attached room/blob core is mirrored through them for offline sync.
     */
    mirrors?: Array<string | Uint8Array>;
    /**
     * Background-task error handler.
     */
    onerror?: (err: Error) => void;
    /**
     * Swarm budget for attached databases: how many search, how many only announce, and the idle ms before the rest leave.
     */
    presence?: {
        active?: number;
        announced?: number;
        idle?: number;
    };
};
export type Replicable = {
    replicate: (stream: import('@hyperswarm/secret-stream')) => unknown;
};
/**
 * @typedef {object} NetworkOpts
 * @property {import('../identity/index.js').Identity} [identity]  Long-lived keypair used as the swarm identity.
 * @property {Array<{ host: string, port: number }>} [bootstrap]    Custom DHT bootstrap nodes.
 * @property {(remotePublicKey: Uint8Array, payload: unknown) => boolean} [firewall]  Incoming-connection filter.
 * @property {Uint8Array[]} [relayThrough]                          Relay public keys to tunnel through.
 * @property {number[]} [backoffs]                                  Reconnect backoff tiers in ms; the default escalates to ~10min, far too slow for local nets.
 * @property {string} [channel]                                     Optional network-isolation label; only same-channel peers meet.
 * @property {import('corestore')} [store]                          Corestore; required for mirrors (blind peers replicate its cores).
 * @property {Array<string | Uint8Array>} [mirrors]                Blind-peer public keys; each attached room/blob core is mirrored through them for offline sync.
 * @property {(err: Error) => void} [onerror]                      Background-task error handler.
 * @property {{ active?: number, announced?: number, idle?: number }} [presence]  Swarm budget for attached databases: how many search, how many only announce, and the idle ms before the rest leave.
 *
 * @typedef {{ replicate: (stream: import('@hyperswarm/secret-stream')) => unknown }} Replicable
 */
/**
 * Hyperswarm peer-discovery + replication multiplexer. Wraps a swarm and a
 * shared wakeup channel, replicating any attached resource onto every peer.
 */
export declare class Network extends ReadyResource {
    identity: import("../index.js").Identity;
    bootstrap: {
        host: string;
        port: number;
    }[];
    firewall: (remotePublicKey: Uint8Array, payload: unknown) => boolean;
    relayThrough: Uint8Array<ArrayBufferLike>[];
    backoffs: number[];
    channel: string;
    /** @type {import('corestore') | null} */
    store: import('corestore') | null;
    /** @type {Uint8Array[]} */
    mirrors: Uint8Array[];
    /** @private */
    _swarm;
    /** @type {import('protomux-wakeup')} */
    wakeup: import('protomux-wakeup');
    presence: Presence;
    info: object;
    /** @private */
    _peerInfo;
    /** @private */
    _infoSenders;
    /** @private */
    _replicateables;
    /** @private */
    _discoveries;
    /** @private */
    _injected;
    /** @private */
    _blindPeering;
    /** @private */
    _lost;
    /** @private */
    _relookup;
    /** @private */
    _onerror;
    /** @param {NetworkOpts} [opts] */
    constructor({ identity, bootstrap, firewall, relayThrough, backoffs, channel, store, mirrors, presence, onerror }?: NetworkOpts);
    /** @returns {import('hyperswarm') | null} The underlying hyperswarm, or null before ready / after close. */
    get swarm(): import('hyperswarm') | null;
    /** @returns {Map<string, object>} Known peers keyed by public-key string. */
    get peers(): Map<string, object>;
    /** @returns {Set<import('@hyperswarm/secret-stream')>} Live connection streams — swarm and injected. */
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
    /**
     * The blind-peering client, built on first use: a mailbox post names mirrors this network
     * may not have been given.
     *
     * @returns {import('blind-peering')}
     */
    peering(): import('blind-peering');
    /**
     * Declare this peer's self-reported info ({ name, ... }) to the peers of injected streams.
     *
     * @param {object | null} info
     */
    setInfo(info: object | null): void;
    /**
     * Info a connected peer declared about itself, or null.
     *
     * @param {Uint8Array | string} key  Peer public key (bytes or hex).
     * @returns {object | null}
     */
    getInfo(key: Uint8Array | string): object | null;
    /**
     * Wait for pending DHT announces and lookups to settle, bounded by timeout.
     *
     * @param {{ timeout?: number }} [opts]
     * @returns {Promise<void>}
     */
    flush({ timeout }?: {
        timeout?: number;
    }): Promise<void>;
    /**
     * Pause the swarm — keeps state, drops sockets. Idempotent.
     *
     * @returns {Promise<void>}
     */
    suspend(): Promise<void>;
    /**
     * Resume a suspended swarm. Idempotent.
     *
     * @returns {Promise<void>}
     */
    resume(): Promise<void>;
    /**
     * Announce/lookup on a 32-byte topic and return a Discovery handle.
     *
     * @param {Uint8Array} topic
     * @param {{ mode?: 'active' | 'passive' }} [opts]  `active` = client+server, `passive` = server-only
     * @returns {Discovery}
     */
    join(topic: Uint8Array, { mode }?: {
        mode?: 'active' | 'passive';
    }): Discovery;
    /**
     * Register a replicable resource (hypercore, autobee, hyperdb).
     * It is replicated on every current and future swarm connection.
     *
     * @param {Replicable} core
     * @returns {void}
     */
    attach(core: Replicable): void;
    /** @private */
    private _mirror;
    /**
     * Unregister a previously attached resource. New connections will no
     * longer replicate it (existing replication streams continue).
     *
     * @param {Replicable} core
     * @returns {void}
     */
    detach(core: Replicable): void;
    /**
     * Replicate a one-off resource onto every current swarm connection
     * without registering it as a long-lived attachment.
     *
     * @param {Replicable} target
     * @returns {void}
     */
    replicate(target: Replicable): void;
    /** @private */
    private _lose;
    /** @private */
    private _relook;
    /** @private */
    private _attachInfo;
}
