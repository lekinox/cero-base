import { Identity } from '@cero-base/core/identity';
import { Handle, Ref } from './handle/index.js';
import { Local } from './local/index.js';
import * as verbs from './lib/operators.js';
import { peek } from './lib/peek.js';
import { t, schema } from './lib/spec.js';
export { Handle, Ref, Local };
export * from './lib/operators.js';
export { peek } from './lib/peek.js';
export { t, schema } from './lib/spec.js';
export type Context = import('./handle/index.js').Context;
export type CeroOpts = {
    /**
     * Pre-resolved identity. If absent, derived from `seed` or generated.
     */
    identity?: Identity;
    /**
     * 16- or 32-byte seed entropy: `toSeed(phrase)` restores from a phrase.
     */
    seed?: Uint8Array;
    /**
     * Mnemonic length when generating a fresh identity.
     */
    words?: 12 | 24;
    /**
     * Friendly device name persisted on the identity claim.
     */
    name?: string | null;
    /**
     * Marks this device as mobile.
     */
    isMobile?: boolean;
    /**
     * Custom DHT bootstrap nodes.
     */
    bootstrap?: Array<{
        host: string;
        port: number;
    }>;
    /**
     * Swarm reconnect backoff tiers in ms (testing/tuning).
     */
    backoffs?: number[];
    /**
     * Optional network-isolation label; only same-channel peers connect.
     */
    channel?: string;
    /**
     * Blind-peer public keys. Rooms and files are mirrored through them so peers sync even when never online at the same time. Mirrors hold only encrypted blocks — they never read your data.
     */
    mirrors?: Array<string | Uint8Array>;
    /**
     * How many rooms search, how many only announce, and the idle ms before the rest leave the swarm.
     */
    presence?: {
        active?: number;
        announced?: number;
        idle?: number;
    };
    /**
     * Existing database key to recover into, skipping the pointer lookup.
     */
    key?: Uint8Array;
    /**
     * Pre-existing encryption key.
     */
    encryptionKey?: Uint8Array;
    /**
     * Where background errors go; the console without one.
     */
    onerror?: (err: Error) => void;
    /**
     * Max wait to find another device and be admitted, in ms. Defaults to 30000.
     */
    recoveryTimeout?: number;
    /**
     * 32-byte key encrypting local key material (master seed, device keypairs) at rest. Source it from the OS keychain — cero never stores it.
     */
    storageKey?: Uint8Array;
    /**
     * The extensions this instance runs, instead of the ones the spec carries. Build with the same list.
     */
    extensions?: import('./extensions/index.js').Extension[];
    /**
     * `true` enables nearby (Bluetooth) sync, the radio on. `{ autoStart: false }` leaves it off until `cero.nearby(me, true)`. `backend` injects a bare-bluetooth-shaped backend (tests). `maxOutbound`/`maxInbound` cap concurrent outbound links and inbound sessions. `pipe` picks the data pipe, `'l2cap'` (default, faster) or `'gatt'`; both peers must match. Without a backend on the host, `me.status` reports `nearby: 'unsupported'`.
     */
    bluetooth?: boolean | {
        autoStart?: boolean;
        backend?: object;
        maxOutbound?: number;
        maxInbound?: number;
        pipe?: 'l2cap' | 'gatt';
    };
};
/**
 * @typedef {import('./handle/index.js').Context} Context
 */
/**
 * @typedef {object} CeroOpts
 * @property {Identity} [identity]                     Pre-resolved identity. If absent, derived from `seed` or generated.
 * @property {Uint8Array} [seed]                       16- or 32-byte seed entropy: `toSeed(phrase)` restores from a phrase.
 * @property {12 | 24} [words]                         Mnemonic length when generating a fresh identity.
 * @property {string | null} [name]                    Friendly device name persisted on the identity claim.
 * @property {boolean} [isMobile]                      Marks this device as mobile.
 * @property {Array<{ host: string, port: number }>} [bootstrap]  Custom DHT bootstrap nodes.
 * @property {number[]} [backoffs]                     Swarm reconnect backoff tiers in ms (testing/tuning).
 * @property {string} [channel]                        Optional network-isolation label; only same-channel peers connect.
 * @property {Array<string | Uint8Array>} [mirrors]    Blind-peer public keys. Rooms and files are mirrored through them so peers sync even when never online at the same time. Mirrors hold only encrypted blocks — they never read your data.
 * @property {{ active?: number, announced?: number, idle?: number }} [presence]  How many rooms search, how many only announce, and the idle ms before the rest leave the swarm.
 * @property {Uint8Array} [key]                        Existing database key to recover into, skipping the pointer lookup.
 * @property {Uint8Array} [encryptionKey]              Pre-existing encryption key.
 * @property {(err: Error) => void} [onerror]            Where background errors go; the console without one.
 * @property {number} [recoveryTimeout]                Max wait to find another device and be admitted, in ms. Defaults to 30000.
 * @property {Uint8Array} [storageKey]                 32-byte key encrypting local key material (master seed, device keypairs) at rest. Source it from the OS keychain — cero never stores it.
 * @property {import('./extensions/index.js').Extension[]} [extensions]  The extensions this instance runs, instead of the ones the spec carries. Build with the same list.
 * @property {boolean | { autoStart?: boolean, backend?: object, maxOutbound?: number, maxInbound?: number, pipe?: 'l2cap' | 'gatt' }} [bluetooth]  `true` enables nearby (Bluetooth) sync, the radio on. `{ autoStart: false }` leaves it off until `cero.nearby(me, true)`. `backend` injects a bare-bluetooth-shaped backend (tests). `maxOutbound`/`maxInbound` cap concurrent outbound links and inbound sessions. `pipe` picks the data pipe, `'l2cap'` (default, faster) or `'gatt'`; both peers must match. Without a backend on the host, `me.status` reports `nearby: 'unsupported'`.
 */
/**
 * Open (or create) a cero handle at `dir`.
 *
 * @param {string} dir       Data directory.
 * @param {import('./lib/spec.js').Spec} spec  Built spec, the output of `cero/build`.
 * @param {CeroOpts} [opts]
 * @returns {Promise<Context>}
 */
declare function start(dir: string, spec: import('./lib/spec.js').Spec, opts?: CeroOpts): Promise<Context>;
/**
 * Restore a cero instance from a seed.
 *
 * @param {Context} me  The root to restore.
 * @param {Uint8Array} seed   The identity's seed: `toSeed(phrase)` from a phrase.
 * @returns {Promise<Handle>}  Freshly restored root handle.
 */
export declare function restore(me: Context, seed: Uint8Array): Promise<Handle>;
/**
 * The seed a BIP-39 phrase writes out, for `cero(dir, spec, { seed })` and `restore(me, seed)`.
 *
 * @param {string} phrase
 * @returns {Uint8Array}
 */
export declare function toSeed(phrase: string): Uint8Array;
/** @type {typeof start & typeof verbs & { t: typeof t, schema: typeof schema, peek: typeof peek, restore: typeof restore, toSeed: typeof toSeed }} */
export declare const cero: typeof start & typeof verbs & {
    t: typeof t;
    schema: typeof schema;
    peek: typeof peek;
    restore: typeof restore;
    toSeed: typeof toSeed;
};
