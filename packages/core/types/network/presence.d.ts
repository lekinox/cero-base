export type Slot = {
    mode: 'active' | 'passive' | null;
    touch: () => void;
    off: () => void;
    remove: () => void;
};
/**
 * Which handles swarm. Ranked by last touch: the latest `active` search and announce, the
 * next `announced` announce only, the rest leave their topic. A handle moves up at once and
 * down only after `idle` ms. A pinned handle always searches, outside the budget.
 *
 * @typedef {{ mode: 'active' | 'passive' | null, touch: () => void, off: () => void, remove: () => void }} Slot
 */
export declare class Presence {
    network: import("./index.js").Network;
    active: number;
    announced: number;
    idle: number;
    entries: Map<any, any>;
    /**
     * @param {import('./index.js').Network} network
     * @param {{ active?: number, announced?: number, idle?: number }} [opts]
     */
    constructor(network: import('./index.js').Network, { active, announced, idle }?: {
        active?: number;
        announced?: number;
        idle?: number;
    });
    /**
     * Register a topic. One entry per topic, shared by every slot on it until all are removed;
     * a new entry starts untouched, at the bottom.
     *
     * @param {Uint8Array} topic
     * @param {{ pinned?: boolean }} [opts]
     * @returns {Slot}
     */
    add(topic: Uint8Array, { pinned }?: {
        pinned?: boolean;
    }): Slot;
    /**
     * @param {Uint8Array} topic
     * @returns {'active' | 'passive' | null}
     */
    mode(topic: Uint8Array): 'active' | 'passive' | null;
    refresh(): void;
    close(): void;
    _want(e: any, mode: any): void;
    _settle(e: any): void;
    _leave(e: any): void;
}
