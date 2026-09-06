export type InviteFields = {
    /**
     * Signer's long-lived public key.
     */
    publicKey: Uint8Array;
    /**
     * Optional role tag baked into the signed body.
     */
    role: string;
    /**
     * Absolute expiry timestamp; `0` means never.
     */
    expires: number;
    /**
     * Encoded payload (raw or via `encoding`).
     */
    data: Uint8Array | null;
    /**
     * Raw blind-pairing invite handed to candidates.
     */
    blind: Uint8Array;
    /**
     * Ed25519 signature over the canonical body.
     */
    sig?: Uint8Array;
    /**
     * Cached z32 string form.
     */
    _str?: string | null;
};
export type CreateInviteOpts = {
    /**
     * 64-byte Ed25519 secret key used to sign.
     */
    secretKey: Uint8Array;
    /**
     * 32-byte Ed25519 public key matching `secretKey`.
     */
    publicKey: Uint8Array;
    /**
     * Optional role tag for the joiner.
     */
    role: string;
    /**
     * TTL in ms from now; `0` means never expires.
     */
    expiresIn: number;
    /**
     * Caller payload; encoded via `encoding` when provided.
     */
    data: any;
    /**
     * Raw blind-pairing invite to wrap.
     */
    blind: Uint8Array;
    /**
     * compact-encoding type used to encode `data`.
     */
    encoding?: any;
};
export type ParseInviteOpts = {
    /**
     * compact-encoding type used to decode the embedded payload.
     */
    encoding?: any;
};
/**
 * @typedef {object} InviteFields
 * @property {Uint8Array} publicKey                 Signer's long-lived public key.
 * @property {string} role                          Optional role tag baked into the signed body.
 * @property {number} expires                       Absolute expiry timestamp; `0` means never.
 * @property {Uint8Array | null} data               Encoded payload (raw or via `encoding`).
 * @property {Uint8Array} blind                     Raw blind-pairing invite handed to candidates.
 * @property {Uint8Array} [sig]                     Ed25519 signature over the canonical body.
 * @property {string | null} [_str]                 Cached z32 string form.
 *
 * @typedef {object} CreateInviteOpts
 * @property {Uint8Array} secretKey                 64-byte Ed25519 secret key used to sign.
 * @property {Uint8Array} publicKey                 32-byte Ed25519 public key matching `secretKey`.
 * @property {string} role                          Optional role tag for the joiner.
 * @property {number} expiresIn                     TTL in ms from now; `0` means never expires.
 * @property {any} data                             Caller payload; encoded via `encoding` when provided.
 * @property {Uint8Array} blind                     Raw blind-pairing invite to wrap.
 * @property {any} [encoding]                       compact-encoding type used to encode `data`.
 *
 * @typedef {object} ParseInviteOpts
 * @property {any} [encoding]                       compact-encoding type used to decode the embedded payload.
 */
/**
 * Signed, expirable pairing invite. Wraps a blind-pairing invite with a role, optional
 * payload and an Ed25519 signature so the host can be authenticated by the joiner before
 * any handshake happens.
 *
 * @property {any} [_rawData]                         Decoded payload kept alongside the encoded `data` for convenience.
 * @property {Uint8Array} _discoveryKey               Cached discovery key of the wrapped blind invite.
 */
export declare class Invite {
    version: number;
    publicKey: Uint8Array<ArrayBufferLike>;
    role: string;
    expires: number;
    data: Uint8Array<ArrayBufferLike>;
    blind: Uint8Array<ArrayBufferLike>;
    sig: Uint8Array<ArrayBufferLike>;
    _str: string;
    _discoveryKey: any;
    /** @param {InviteFields} fields */
    constructor(fields: InviteFields);
    /**
     * Whether the invite is past its TTL (always `false` when `expires === 0`).
     *
     * @returns {boolean}
     */
    get expired(): boolean;
    /**
     * Discovery key of the wrapped blind-pairing invite — the topic it targets.
     *
     * @returns {Uint8Array}
     */
    get discoveryKey(): Uint8Array;
    /**
     * Verify the embedded signature against the encoded body.
     *
     * @returns {boolean}
     */
    verify(): boolean;
    /**
     * Serialise to the canonical z32 wire form (cached).
     *
     * @returns {string}
     */
    toString(): string;
    /**
     * Build and sign a new invite envelope wrapping a blind-pairing invite.
     *
     * @param {CreateInviteOpts} opts
     * @returns {Invite}
     */
    static create({ secretKey, publicKey, role, expiresIn, data, blind, encoding }: CreateInviteOpts): Invite;
    /**
     * Parse a z32 invite string, verify its signature and (optionally) decode
     * its payload.
     *
     * @param {string} str
     * @param {ParseInviteOpts} [opts]
     * @returns {Invite}
     */
    static parse(str: string, { encoding }?: ParseInviteOpts): Invite;
    /**
     * Cheap structural test — does `str` decode as an invite envelope? Does not
     * verify the signature.
     *
     * @param {unknown} str
     * @returns {boolean}
     */
    static isInvite(str: unknown): boolean;
}
