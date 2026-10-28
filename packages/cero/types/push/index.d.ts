/**
 * A push verified against the handles the topics rows name, with the row it wrote when the block
 * rode along and this device holds the handle's keys.
 *
 * @param {import('hypercore-storage')} storage
 * @param {import('../lib/spec.js').Spec} spec
 * @param {Uint8Array} payload
 * @param {Array<{ id: string, handle: string, type: string, key: Uint8Array, name: string | null, encryptionKey?: Uint8Array | null, epochs?: Uint8Array | null }>} rows  The root's `topics` rows.
 * @returns {Promise<{ id: string, type: string, name: string | null, newer: boolean, ref: string | null, row: object | null } | null>}
 */
export declare function read(storage: import('hypercore-storage'), spec: import('../lib/spec.js').Spec, payload: Uint8Array, rows: Array<{
    id: string;
    handle: string;
    type: string;
    key: Uint8Array;
    name: string | null;
    encryptionKey?: Uint8Array | null;
    epochs?: Uint8Array | null;
}>): Promise<{
    id: string;
    type: string;
    name: string | null;
    newer: boolean;
    ref: string | null;
    row: object | null;
} | null>;
/**
 * A push the platform delivered while the app is dead, verified from its storage opened
 * read-only. `null` while the live app holds the storage, which shows the activity itself, and
 * for a push that is forged or about no handle here.
 *
 * @param {string} dir  The directory `cero()` opened.
 * @param {import('../lib/spec.js').Spec} spec
 * @param {Uint8Array} payload
 * @param {{ storageKey?: Uint8Array }} [opts]  The key `cero()` encrypts the local store with, if any.
 * @returns {Promise<{ id: string, type: string, name: string | null, newer: boolean, ref: string | null, row: object | null } | null>}
 */
export declare function receive(dir: string, spec: import('../lib/spec.js').Spec, payload: Uint8Array, { storageKey }?: {
    storageKey?: Uint8Array;
}): Promise<{
    id: string;
    type: string;
    name: string | null;
    newer: boolean;
    ref: string | null;
    row: object | null;
} | null>;
/**
 * The bare-kit push entry: on each push the OS hands this worklet, verify it and, for one about
 * new data on a handle this device holds, answer with what the show handler returns: the
 * notification, `{ title, body }`, or nothing. The request carries `storage`, `payload` (base64) and, when the
 * app encrypts its local store, `storageKey` (base64).
 *
 * @param {import('../lib/spec.js').Spec} spec
 * @param {(push: { id: string, type: string, name: string | null, newer: boolean, ref: string | null, row: object | null }) => { title: string, body: string } | null | undefined | Promise<{ title: string, body: string } | null | undefined>} show  The show handler: what to show for a verified push, as `cero.receive` would give it to the app.
 * @returns {void}
 */
export declare function push(spec: import('../lib/spec.js').Spec, show: (push: {
    id: string;
    type: string;
    name: string | null;
    newer: boolean;
    ref: string | null;
    row: object | null;
}) => {
    title: string;
    body: string;
} | null | undefined | Promise<{
    title: string;
    body: string;
} | null | undefined>): void;
