export type InviteFields = {
    /**
     * Absolute expiry timestamp; `0` means never.
     */
    expires: number;
    /**
     * Discovery key of the database the invite opens.
     */
    discoveryKey: Uint8Array;
    /**
     * Where a knock is sent.
     */
    address: Uint8Array;
    /**
     * The invite's secret; its keypair proves a knock.
     */
    seed: Uint8Array;
    /**
     * The app's payload, readable before joining. Unsigned: a hint, not proof.
     */
    data?: Uint8Array | null;
};
/**
 * @typedef {object} InviteFields
 * @property {number} expires           Absolute expiry timestamp; `0` means never.
 * @property {Uint8Array} discoveryKey  Discovery key of the database the invite opens.
 * @property {Uint8Array} address       Where a knock is sent.
 * @property {Uint8Array} seed          The invite's secret; its keypair proves a knock.
 * @property {Uint8Array | null} [data] The app's payload, readable before joining. Unsigned: a hint, not proof.
 */
/**
 * An invite: where to knock (its address), the database it opens, and a seed
 * whose keypair proves the knocker holds the invite. Role and expiry are enforced by the member
 * that answers, from its own record; `expires` is here so a joiner fails fast.
 */
export declare class Invite {
    version: number;
    expires: number;
    discoveryKey: Uint8Array<ArrayBufferLike>;
    address: Uint8Array<ArrayBufferLike>;
    seed: Uint8Array<ArrayBufferLike>;
    data: Uint8Array<ArrayBufferLike>;
    _str: string;
    _keyPair: any;
    /** @param {InviteFields & { _str?: string }} fields */
    constructor({ expires, discoveryKey, address, seed, data, _str }: InviteFields & {
        _str?: string;
    });
    /** @returns {boolean} Whether the invite is past its expiry (never when `expires === 0`). */
    get expired(): boolean;
    /** @returns {Uint8Array} The invite's id: the public key of its seed's keypair. */
    get id(): Uint8Array;
    /**
     * Sign a reply address with the invite's key, proving the knock comes from its holder.
     *
     * @param {Uint8Array} reply
     * @returns {Uint8Array}
     */
    prove(reply: Uint8Array): Uint8Array;
    /** @returns {string} The z32 wire form. */
    toString(): string;
    _pair(): any;
    /**
     * Whether `proof` is the invite `id`'s signature over `reply`.
     *
     * @param {Uint8Array} id
     * @param {Uint8Array} reply
     * @param {Uint8Array} proof
     * @returns {boolean}
     */
    static proven(id: Uint8Array, reply: Uint8Array, proof: Uint8Array): boolean;
    /**
     * A new invite with a fresh seed.
     *
     * @param {{ ttl?: number | string, discoveryKey: Uint8Array, address: Uint8Array, data?: Uint8Array | null }} opts
     * @returns {Invite}
     */
    static create({ ttl, discoveryKey, address, data }: {
        ttl?: number | string;
        discoveryKey: Uint8Array;
        address: Uint8Array;
        data?: Uint8Array | null;
    }): Invite;
    /**
     * Parse an invite string.
     *
     * @param {string} str
     * @returns {Invite}
     */
    static parse(str: string): Invite;
}
