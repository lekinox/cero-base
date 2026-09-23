import AbortController from 'bare-abort-controller';
/**
 * One handle being joined. It knocks with the latest invite and waits as long as it takes: the
 * caller's timeout only ends the caller's wait. What it learns is saved as it goes, the writer
 * before the first knock and the keys once the reply lands, so a join resumed after a restart
 * picks up where it stopped. It ends admitted, denied, expired or cancelled; a close only pauses
 * it. How it ends reaches the caller, or `onerror` once nobody waits.
 */
export declare class Join {
    root: import("./index.js").Handle;
    type: string;
    id: string;
    routes: Record<string, Function>;
    invite: string;
    waiting: number;
    cancelled: boolean;
    _knocking: AbortController;
    _row: any;
    done: Promise<any>;
    _resolve: (value: any) => void;
    _reject: (reason?: any) => void;
    _onend: () => void;
    /**
     * @param {import('./index.js').Handle} root
     * @param {{ type: string, discoveryKey: Uint8Array, routes?: Record<string, Function>, onend: () => void }} opts
     */
    constructor(root: import('./index.js').Handle, { type, discoveryKey, routes, onend }: {
        type: string;
        discoveryKey: Uint8Array;
        routes?: Record<string, Function>;
        onend: () => void;
    });
    /**
     * Knock with `invite`, taking over from an older knock: the writer stays, so a reply to the
     * older one still lands.
     *
     * @param {string} invite
     */
    knock(invite: string): Promise<void>;
    close(): void;
    cancel(): Promise<void>;
    _save(fields: any): Promise<any>;
    _keep(reply: any): Promise<any>;
    _forget(): Promise<void>;
    _end(settle: any, value: any): void;
}
/**
 * Wait for a join, but stop waiting after `ms`; the join itself goes on.
 *
 * @param {Promise<any>} done
 * @param {number} ms  `0` waits as long as the join takes.
 */
export declare function wait(done: Promise<any>, ms: number): Promise<any>;
