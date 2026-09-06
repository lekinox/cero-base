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
     * Build an identity from 16- or 32-byte entropy.
     *
     * @param {Uint8Array} seed
     * @returns {Promise<Identity>}
     */
    static fromSeed(seed: Uint8Array): Promise<Identity>;
    /**
     * Build an identity from a BIP-39 mnemonic.
     *
     * @param {string} phrase
     * @returns {Promise<Identity>}
     */
    static fromPhrase(phrase: string): Promise<Identity>;
    /**
     * Generate a fresh identity from CSPRNG entropy.
     *
     * @param {{ words?: 12 | 24 }} [opts]
     * @returns {Promise<Identity>}
     */
    static generate({ words }?: {
        words?: 12 | 24;
    }): Promise<Identity>;
    /**
     * Generate a random BIP-39 mnemonic.
     *
     * @param {12 | 24} [words]
     * @returns {string}
     */
    static genPhrase(words?: 12 | 24): string;
    /**
     * Phrase → seed entropy.
     *
     * @param {string} phrase
     * @returns {Uint8Array}
     */
    static toSeed(phrase: string): Uint8Array;
    /**
     * Seed entropy → phrase.
     *
     * @param {Uint8Array} seed
     * @returns {string}
     */
    static toPhrase(seed: Uint8Array): string;
    /**
     * Validate that a value is a 16- or 32-byte buffer.
     *
     * @param {any} x
     * @returns {x is Uint8Array}
     */
    static isSeed(x: any): x is Uint8Array;
    /**
     * Validate that a string is a BIP-39 mnemonic.
     *
     * @param {unknown} x
     * @returns {x is string}
     */
    static isPhrase(x: unknown): x is string;
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
    /**
     * Fresh seed entropy sized for the chosen mnemonic length.
     *
     * @param {12 | 24} [words]
     * @returns {Uint8Array}
     */
    static randomSeed(words?: 12 | 24): Uint8Array;
}
