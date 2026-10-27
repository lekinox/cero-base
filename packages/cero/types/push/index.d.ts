/**
 * A push the platform delivered while the app is dead, verified from its storage opened
 * read-only. `null` while the live app holds the storage, which shows the activity itself, and
 * for a push that is forged or about no handle here.
 *
 * @param {string} dir  The directory `cero()` opened.
 * @param {import('../lib/spec.js').Spec} spec
 * @param {Uint8Array} payload
 * @param {{ storageKey?: Uint8Array }} [opts]  The key `cero()` encrypts the local store with, if any.
 * @returns {Promise<{ id: string, type: string, name: string | null, newer: boolean, ref: string | null } | null>}
 */
export declare function receive(dir: string, spec: import('../lib/spec.js').Spec, payload: Uint8Array, { storageKey }?: {
    storageKey?: Uint8Array;
}): Promise<{
    id: string;
    type: string;
    name: string | null;
    newer: boolean;
    ref: string | null;
} | null>;
/**
 * The bare-kit push entry: on each push the OS hands this worklet, verify it and, for one about
 * new data on a handle this device holds, answer with what `show` returns: the notification,
 * `{ title, body }`, or nothing. The request carries `storage`, `payload` (base64) and, when the
 * app encrypts its local store, `storageKey` (base64).
 *
 * @param {import('../lib/spec.js').Spec} spec
 * @param {(push: { id: string, type: string, name: string | null, newer: boolean, ref: string | null }) => { title: string, body: string } | null | undefined | Promise<{ title: string, body: string } | null | undefined>} show  What to show for a verified push, as `cero.receive` would give it to the app.
 * @returns {void}
 */
export declare function push(spec: import('../lib/spec.js').Spec, show: (push: {
    id: string;
    type: string;
    name: string | null;
    newer: boolean;
    ref: string | null;
}) => {
    title: string;
    body: string;
} | null | undefined | Promise<{
    title: string;
    body: string;
} | null | undefined>): void;
