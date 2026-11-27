export declare const STAMPED = 2;
export type InviteFields = {
    /**
     * Absolute expiry timestamp; `0` means never.
     */
    expires: number;
    /**
     * Key of the database the invite opens.
     */
    key: Uint8Array;
    /**
     * Where a join is sealed to: the invite's own address, or the database's.
     */
    address: Uint8Array;
    /**
     * The invite's secret; its keypair proves a join.
     */
    seed: Uint8Array;
    /**
     * The node that added its record: a join links it, so no member applies the join first.
     */
    link: {
        key: Uint8Array;
        length: number;
    } | null;
    /**
     * The app's payload, readable before joining. Unsigned: a hint, not proof.
     */
    data?: Uint8Array | null;
    /**
     * The stamp its record was written with, which its joins take; `0` for none.
     */
    stamp?: number;
    /**
     * The invite's form: `STAMPED` once the stamp is past its database's start, or with an address of its own.
     */
    version?: number;
    /**
     * Whether the address is the invite's own: its join names it and its answers are tagged.
     */
    own?: boolean;
};
/**
 * @typedef {object} InviteFields
 * @property {number} expires           Absolute expiry timestamp; `0` means never.
 * @property {Uint8Array} key           Key of the database the invite opens.
 * @property {Uint8Array} address       Where a join is sealed to: the invite's own address, or the database's.
 * @property {Uint8Array} seed          The invite's secret; its keypair proves a join.
 * @property {{ key: Uint8Array, length: number } | null} link  The node that added its record: a join links it, so no member applies the join first.
 * @property {Uint8Array | null} [data] The app's payload, readable before joining. Unsigned: a hint, not proof.
 * @property {number} [stamp]           The stamp its record was written with, which its joins take; `0` for none.
 * @property {number} [version]         The invite's form: `STAMPED` once the stamp is past its database's start, or with an address of its own.
 * @property {boolean} [own]            Whether the address is the invite's own: its join names it and its answers are tagged.
 */
/**
 * An invite: the database it opens, the address a join is sealed to, its own or the database's,
 * and a seed whose keypair proves the joiner holds the invite. Role and expiry come from the
 * database's own record; `expires` is here so a joiner fails fast.
 */
export declare class Invite {
    version: number;
    expires: number;
    key: Uint8Array<ArrayBufferLike>;
    address: Uint8Array<ArrayBufferLike>;
    seed: Uint8Array<ArrayBufferLike>;
    link: {
        key: Uint8Array;
        length: number;
    };
    data: Uint8Array<ArrayBufferLike>;
    stamp: number;
    own: boolean;
    /** @private */
    _str;
    /** @private */
    _keyPair;
    /** @param {InviteFields & { _str?: string }} fields */
    constructor({ version, expires, key, address, seed, link, data, stamp, own, _str }: InviteFields & {
        _str?: string;
    });
    /** @returns {boolean} Whether the invite is past its expiry (never when `expires === 0`). */
    get expired(): boolean;
    /** @returns {Uint8Array} Discovery key of the database the invite opens. */
    get discoveryKey(): Uint8Array;
    /** @returns {Uint8Array} The invite's id: the public key of its seed's keypair. */
    get id(): Uint8Array;
    /**
     * Sign a writer with the invite's key, proving the join in that writer's core comes from its
     * holder.
     *
     * @param {Uint8Array} writer
     * @returns {Uint8Array}
     */
    prove(writer: Uint8Array): Uint8Array;
    /** @returns {string} The z32 wire form. */
    toString(): string;
    /** @private */
    private _pair;
    /**
     * Whether `proof` is the invite `id`'s signature over `writer`.
     *
     * @param {Uint8Array} id
     * @param {Uint8Array} writer
     * @param {Uint8Array} proof
     * @returns {boolean}
     */
    static proven(id: Uint8Array, writer: Uint8Array, proof: Uint8Array): boolean;
    /**
     * A new invite with a fresh seed.
     *
     * @param {{ ttl?: number | string, key: Uint8Array, address: Uint8Array, link?: { key: Uint8Array, length: number } | null, data?: Uint8Array | null, own?: boolean }} opts
     * @returns {Invite}
     */
    static create({ ttl, key, address, link, data, own }: {
        ttl?: number | string;
        key: Uint8Array;
        address: Uint8Array;
        link?: {
            key: Uint8Array;
            length: number;
        } | null;
        data?: Uint8Array | null;
        own?: boolean;
    }): Invite;
    /**
     * Parse an invite string.
     *
     * @param {string} str
     * @returns {Invite}
     */
    static parse(str: string): Invite;
}
