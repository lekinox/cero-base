export type KeyPair = {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    id: string;
};
export type IdentityFields = {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    encryptionKey: Uint8Array;
    seed: Uint8Array;
};
/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array, id: string }} KeyPair
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array, encryptionKey: Uint8Array, seed: Uint8Array }} IdentityFields
 */
/**
 * Long-lived user identity derived from a BIP-39 seed phrase.
 */
export declare class Identity {
    /**
     * Canonical z32-encoded public key.
     *
     * @type {string}
     */
    id: string;
    /** @type {Uint8Array} */
    publicKey: Uint8Array;
    /** @type {Uint8Array} */
    secretKey: Uint8Array;
    /**
     * Symmetric key for encrypting per-identity payloads.
     *
     * @type {Uint8Array}
     */
    encryptionKey: Uint8Array;
    /**
     * Hash of the public key — used as the swarm topic.
     *
     * @type {Uint8Array}
     */
    topic: Uint8Array;
    /**
     * Original 16- or 32-byte entropy.
     *
     * @type {Uint8Array}
     */
    seed: Uint8Array;
    /** @param {IdentityFields} keys */
    constructor(keys: IdentityFields);
    /**
     * Redacted — secretKey/encryptionKey/seed must never reach JSON.stringify
     * or a structured logger.
     *
     * @returns {{ id: string }}
     */
    toJSON(): {
        id: string;
    };
    /**
     * Detached Ed25519 signature over `message`.
     *
     * @param {Uint8Array} message
     * @returns {Uint8Array}
     */
    sign(message: Uint8Array): Uint8Array;
    /**
     * Verify a signature against this identity's public key.
     *
     * @param {Uint8Array} message
     * @param {Uint8Array} signature
     * @returns {boolean}
     */
    verify(message: Uint8Array, signature: Uint8Array): boolean;
    /**
     * Open a sealed box addressed to this identity (any device holding the seed-derived
     * keypair can open it).
     *
     * @param {Uint8Array} sealed
     * @returns {Uint8Array | null}
     */
    unseal(sealed: Uint8Array): Uint8Array | null;
    /**
     * Render the underlying seed as a BIP-39 mnemonic phrase.
     *
     * @returns {string}
     */
    toPhrase(): string;
    /**
     * An identity from its seed, 16 or 32 bytes; a fresh one without.
     *
     * @param {{ seed?: Uint8Array | null, words?: 12 | 24 }} [opts]  `words` sizes a fresh one.
     * @returns {Promise<Identity>}
     */
    static create({ seed, words }?: {
        seed?: Uint8Array | null;
        words?: 12 | 24;
    }): Promise<Identity>;
    /**
     * The seed a BIP-39 phrase writes out.
     *
     * @param {string} phrase
     * @returns {Uint8Array}
     */
    static toSeed(phrase: string): Uint8Array;
    /**
     * A seed written out as a BIP-39 phrase.
     *
     * @param {Uint8Array} seed
     * @returns {string}
     */
    static toPhrase(seed: Uint8Array): string;
    /**
     * Verify a signature against an arbitrary public key.
     *
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} message
     * @param {Uint8Array} signature
     * @returns {boolean}
     */
    static verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
    /**
     * Seal a message to an identity's Ed25519 public key (sealed box over the curve25519
     * conversion).
     *
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} message
     * @returns {Uint8Array}
     */
    static seal(publicKey: Uint8Array, message: Uint8Array): Uint8Array;
    /**
     * Generate a fresh Ed25519 keypair (for devices, blind invites, etc.).
     *
     * @returns {KeyPair}
     */
    static randomKeyPair(): KeyPair;
    /**
     * N bytes from a CSPRNG.
     *
     * @param {number} [n]
     * @returns {Uint8Array}
     */
    static randomBytes(n?: number): Uint8Array;
}
