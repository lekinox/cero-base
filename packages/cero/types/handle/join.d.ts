/**
 * One handle being joined. It joins with the latest invite and waits as long as it takes: the
 * caller's timeout only ends the caller's wait. What it learns is saved as it goes, the writer
 * before the join is written and the keys once the reply lands, so a join resumed after a restart
 * picks up where it stopped. It ends admitted, denied, expired or cancelled; a close only pauses
 * it. How it ends reaches the caller, or `onerror` once nobody waits.
 */
export declare class Join {
    root: import("./index.js").Handle;
    type: string;
    spec: object;
    id: string;
    invite: string;
    waiting: number;
    cancelled: boolean;
    /** @private */
    _running;
    /** @private */
    _row;
    /** @type {Promise<import('./index.js').Handle>} */
    done: Promise<import('./index.js').Handle>;
    /** @private */
    _resolve;
    /** @private */
    _reject;
    /** @private */
    _onend;
    /**
     * @param {import('./index.js').Handle} root
     * @param {{ type: string, spec: object, discoveryKey: Uint8Array, onend: () => void }} opts
     */
    constructor(root: import('./index.js').Handle, { type, spec, discoveryKey, onend }: {
        type: string;
        spec: object;
        discoveryKey: Uint8Array;
        onend: () => void;
    });
    /**
     * Join with `invite`, taking over from an older attempt: the writer stays, so a reply to the
     * older one still lands.
     *
     * @param {string} invite
     */
    start(invite: string): Promise<void>;
    close(): void;
    cancel(): Promise<void>;
    /** @private */
    private _save;
    /** @private */
    private _keep;
    /** @private */
    private _forget;
    /** @private */
    private _end;
}
/**
 * Wait for a join, but stop waiting after `ms`; the join itself goes on.
 *
 * @param {Promise<import('./index.js').Handle>} done
 * @param {number} ms  `0` waits as long as the join takes.
 * @returns {Promise<import('./index.js').Handle>}
 */
export declare function wait(done: Promise<import('./index.js').Handle>, ms: number): Promise<import('./index.js').Handle>;
