import { Identity } from '@cero-base/core/identity';
import { Handle, Ref } from './handle/index.js';
import { Local } from './local/index.js';
import { put, set, get, del, watch, changes, call, open, rotate, before, after } from './lib/operators.js';
import { peek } from './lib/peek.js';
import { t, schema } from './lib/spec.js';
export { Handle, Ref, Local };
export { put, set, get, del, watch, changes, call, open, rotate, before, after } from './lib/operators.js';
export { peek } from './lib/peek.js';
export { t, schema } from './lib/spec.js';
export type CeroHandle = import('./handle/index.js').CeroHandle;
export type CeroOpts = {
    /**
     * Pre-resolved identity. If absent, derived from `seed`/`phrase` or generated.
     */
    identity?: Identity;
    /**
     * 16- or 32-byte seed entropy.
     */
    seed?: Uint8Array;
    /**
     * BIP-39 mnemonic — alternative to `seed`.
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
     * Custom RPC routes for the database dispatcher.
     */
    routes?: Record<string, Function>;
    /**
     * Background-task error handler.
     */
    onerror?: (err: any) => void;
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
     * The operators to bind, instead of the ones the spec carries.
     */
    operators?: Record<string, any>;
    /**
     * `true` enables nearby (Bluetooth) sync via `me.bluetooth` (auto-started). `{ autoStart: false }` creates the facade without starting the radio — the app calls `me.bluetooth.start()`/`stop()` (user toggle). `backend` injects a bare-bluetooth-shaped backend (tests). `maxOutbound`/`maxInbound` cap concurrent outbound links and inbound sessions. `pipe` picks the data pipe — `'l2cap'` (default, faster) or `'gatt'`; both peers must match. Absent backend on an unsupported host → `me.bluetooth.state === 'unsupported'`.
     */
    bluetooth?: boolean | {
        autoStart?: boolean;
        backend?: any;
        maxOutbound?: number;
        maxInbound?: number;
        pipe?: 'l2cap' | 'gatt';
    };
};
/**
 * @typedef {import('./handle/index.js').CeroHandle} CeroHandle
 */
/**
 * @typedef {object} CeroOpts
 * @property {Identity} [identity]                     Pre-resolved identity. If absent, derived from `seed`/`phrase` or generated.
 * @property {Uint8Array} [seed]                       16- or 32-byte seed entropy.
 * @property {string} [phrase]                         BIP-39 mnemonic — alternative to `seed`.
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
 * @property {Record<string, Function>} [routes]       Custom RPC routes for the database dispatcher.
 * @property {(err: any) => void} [onerror]            Background-task error handler.
 * @property {number} [recoveryTimeout]                Max wait to find another device and be admitted, in ms. Defaults to 30000.
 * @property {Uint8Array} [storageKey]                 32-byte key encrypting local key material (master seed, device keypairs) at rest. Source it from the OS keychain — cero never stores it.
 * @property {import('./extensions/index.js').Extension[]} [extensions]  The extensions this instance runs, instead of the ones the spec carries. Build with the same list.
 * @property {Record<string, any>} [operators]  The operators to bind, instead of the ones the spec carries.
 * @property {boolean | { autoStart?: boolean, backend?: any, maxOutbound?: number, maxInbound?: number, pipe?: 'l2cap' | 'gatt' }} [bluetooth]  `true` enables nearby (Bluetooth) sync via `me.bluetooth` (auto-started). `{ autoStart: false }` creates the facade without starting the radio — the app calls `me.bluetooth.start()`/`stop()` (user toggle). `backend` injects a bare-bluetooth-shaped backend (tests). `maxOutbound`/`maxInbound` cap concurrent outbound links and inbound sessions. `pipe` picks the data pipe — `'l2cap'` (default, faster) or `'gatt'`; both peers must match. Absent backend on an unsupported host → `me.bluetooth.state === 'unsupported'`.
 */
/**
 * Open (or create) a cero handle at `dir`.
 *
 * @param {string} dir       Data directory.
 * @param {any} spec         Built spec — output of `cero/build`.
 * @param {CeroOpts} [opts]
 * @returns {Promise<CeroHandle>}
 */
export declare function cero(dir: string, spec: any, opts?: CeroOpts): Promise<CeroHandle>;
export declare namespace cero {
    export { t };
    export { put };
    export { set };
    export { get };
    export { del };
    export { watch };
    export { changes };
    export { call };
    export { open };
    export { rotate };
    export { before };
    export { after };
    export { peek };
    export { restore };
    export { schema };
}
/**
 * Restore a cero instance from a mnemonic phrase.
 *
 * @param {Handle} me   Existing root handle to restore.
 * @param {string} phrase   BIP-39 mnemonic phrase.
 * @returns {Promise<Handle>}  Freshly restored root handle.
 */
export declare function restore(me: Handle, phrase: string): Promise<Handle>;
