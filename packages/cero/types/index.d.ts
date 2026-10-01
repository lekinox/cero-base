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
     * The identity's BIP-39 phrase, as `cero.phrase(me)` gives it: on a new `dir` it recovers that identity.
     */
    phrase?: string;
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
     * Blind-peer public keys. Handles and files are mirrored through them so peers sync even when never online at the same time. Mirrors hold only encrypted blocks — they never read your data.
     */
    mirrors?: Array<string | Uint8Array>;
    /**
     * How many handles search, how many only announce, and the idle ms before the rest leave the swarm.
     */
    presence?: {
        active?: number;
        announced?: number;
        idle?: number;
    };
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
     * Bluetooth at start: `on` (off by default) and `topic` (the default one, else the channel's own); the app turns the radio on and off with `cero.nearby`, and nothing is stored. `maxOutbound`/`maxInbound` cap concurrent outbound links and inbound sessions. `pipe` picks the data pipe, `'l2cap'` (default, faster) or `'gatt'`; both peers must match. `backend` injects a bare-bluetooth-shaped backend (tests); with none on the host, `status.nearby` reads `'unsupported'`.
     */
    bluetooth?: {
        on?: boolean;
        topic?: string;
        backend?: object | null;
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
 * @property {string} [phrase]                         The identity's BIP-39 phrase, as `cero.phrase(me)` gives it: on a new `dir` it recovers that identity.
 * @property {12 | 24} [words]                         Mnemonic length when generating a fresh identity.
 * @property {string | null} [name]                    Friendly device name persisted on the identity claim.
 * @property {boolean} [isMobile]                      Marks this device as mobile.
 * @property {Array<{ host: string, port: number }>} [bootstrap]  Custom DHT bootstrap nodes.
 * @property {number[]} [backoffs]                     Swarm reconnect backoff tiers in ms (testing/tuning).
 * @property {string} [channel]                        Optional network-isolation label; only same-channel peers connect.
 * @property {Array<string | Uint8Array>} [mirrors]    Blind-peer public keys. Handles and files are mirrored through them so peers sync even when never online at the same time. Mirrors hold only encrypted blocks — they never read your data.
 * @property {{ active?: number, announced?: number, idle?: number }} [presence]  How many handles search, how many only announce, and the idle ms before the rest leave the swarm.
 * @property {(err: Error) => void} [onerror]            Where background errors go; the console without one.
 * @property {number} [recoveryTimeout]                Max wait to find another device and be admitted, in ms. Defaults to 30000.
 * @property {Uint8Array} [storageKey]                 32-byte key encrypting local key material (master seed, device keypairs) at rest. Source it from the OS keychain — cero never stores it.
 * @property {import('./extensions/index.js').Extension[]} [extensions]  The extensions this instance runs, instead of the ones the spec carries. Build with the same list.
 * @property {{ on?: boolean, topic?: string, backend?: object | null, maxOutbound?: number, maxInbound?: number, pipe?: 'l2cap' | 'gatt' }} [bluetooth]  Bluetooth at start: `on` (off by default) and `topic` (the default one, else the channel's own); the app turns the radio on and off with `cero.nearby`, and nothing is stored. `maxOutbound`/`maxInbound` cap concurrent outbound links and inbound sessions. `pipe` picks the data pipe, `'l2cap'` (default, faster) or `'gatt'`; both peers must match. `backend` injects a bare-bluetooth-shaped backend (tests); with none on the host, `status.nearby` reads `'unsupported'`.
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
 * Restore a cero instance from a recovery phrase.
 *
 * @param {Context} me  The root to restore.
 * @param {string} phrase  The identity's BIP-39 phrase, as `cero.phrase(me)` gives it.
 * @returns {Promise<Handle>}  Freshly restored root handle.
 */
export declare function restore(me: Context, phrase: string): Promise<Handle>;
/** @type {typeof start & typeof verbs & { t: typeof t, schema: typeof schema, peek: typeof peek, restore: typeof restore }} */
export declare const cero: typeof start & typeof verbs & {
    t: typeof t;
    schema: typeof schema;
    peek: typeof peek;
    restore: typeof restore;
};
