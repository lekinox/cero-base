export type KeyPair = {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    id: string;
};
export type IdentityFields = {
    /**
     * The identity's public key.
     */
    publicKey: Uint8Array;
    /**
     * Its root encryption key, derived from the seed.
     */
    encryptionKey: Uint8Array;
    /**
     * This device's signing keypair.
     */
    device: KeyPair;
    /**
     * The device's chain of attestations back to the identity.
     */
    proof: Uint8Array;
    /**
     * The phrase's entropy: on the device that created or recovered the identity, never on a linked one.
     */
    seed?: Uint8Array | null;
};
export type Verified = {
    identity: Uint8Array;
    device: Uint8Array;
};
/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array, id: string }} KeyPair
 *
 * @typedef {object} IdentityFields
 * @property {Uint8Array} publicKey        The identity's public key.
 * @property {Uint8Array} encryptionKey    Its root encryption key, derived from the seed.
 * @property {KeyPair} device              This device's signing keypair.
 * @property {Uint8Array} proof            The device's chain of attestations back to the identity.
 * @property {Uint8Array | null} [seed]    The phrase's entropy: on the device that created or recovered the identity, never on a linked one.
 *
 * @typedef {{ identity: Uint8Array, device: Uint8Array }} Verified
 */
/**
 * A user identity, as one of its devices holds it. The identity's secret key signs exactly one
 * thing, a device's first proof, and is never kept: everything else is signed by the device key
 * and carries the proof, so a stolen device leaks only itself.
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
    /** @type {KeyPair} */
    device: KeyPair;
    /** @type {Uint8Array} */
    proof: Uint8Array;
    /** @type {Uint8Array | null} */
    seed: Uint8Array | null;
    /** @param {IdentityFields} fields */
    constructor({ publicKey, encryptionKey, device, proof, seed }: IdentityFields);
    /**
     * Redacted — the device secret, encryptionKey and seed must never reach JSON.stringify or a
     * structured logger.
     *
     * @returns {{ id: string }}
     */
    toJSON(): {
        id: string;
    };
    /**
     * A proof over `data`: this device's signature, under its chain to the identity.
     *
     * @param {Uint8Array} data
     * @returns {Uint8Array}
     */
    sign(data: Uint8Array): Uint8Array;
    /**
     * A proof for a new device: this device attests it, one link further down the chain.
     *
     * @param {Uint8Array} publicKey
     * @returns {Uint8Array}
     */
    link(publicKey: Uint8Array): Uint8Array;
    /**
     * A device with no identity yet: it signs as itself, its own key standing for the identity,
     * until one attests it.
     *
     * @param {KeyPair} [device]  A fresh keypair by default.
     * @returns {Promise<Identity>}
     */
    static bare(device?: KeyPair): Promise<Identity>;
    /**
     * The keys a proof chains through: the identity, then each device down to the signer.
     *
     * @param {Uint8Array} proof
     * @returns {Uint8Array[]}  Empty when it is not a proof.
     */
    static chain(proof: Uint8Array): Uint8Array[];
    /**
     * Open a sealed box addressed to this device.
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
     * An identity from its seed, 16 or 32 bytes; a fresh one without. The identity key attests
     * `device` and is dropped.
     *
     * @param {{ seed?: Uint8Array | null, words?: 12 | 24, device?: KeyPair }} [opts]  `words` sizes a fresh seed; `device` is a fresh keypair by default.
     * @returns {Promise<Identity>}
     */
    static create({ seed, words, device }?: {
        seed?: Uint8Array | null;
        words?: 12 | 24;
        device?: KeyPair;
    }): Promise<Identity>;
    /**
     * The identity keypair a seed writes, for what only the identity itself may sign: the pointer
     * core it is created with. Nothing else ever takes it.
     *
     * @param {Uint8Array} seed
     * @returns {Promise<{ publicKey: Uint8Array, secretKey: Uint8Array }>}
     */
    static keyPair(seed: Uint8Array): Promise<{
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    }>;
    /**
     * The identity as a stored or linked device holds it. The proof must chain `device` to it.
     *
     * @param {IdentityFields} fields
     * @returns {Identity}
     */
    static from({ publicKey, encryptionKey, device, proof, seed }: IdentityFields): Identity;
    /**
     * Who signed `data`: the identity a proof chains to and the device that signed, or null.
     *
     * @param {Uint8Array} proof
     * @param {Uint8Array | null} [data]        What the proof signs; null verifies the chain alone.
     * @param {Uint8Array | null} [publicKey]   The identity expected, any when omitted.
     * @returns {Verified | null}
     */
    static verify(proof: Uint8Array, data?: Uint8Array | null, publicKey?: Uint8Array | null): Verified | null;
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
     * Seal a message to a device's Ed25519 public key (sealed box over the curve25519 conversion).
     *
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} message
     * @returns {Uint8Array}
     */
    static seal(publicKey: Uint8Array, message: Uint8Array): Uint8Array;
    /**
     * Generate a fresh Ed25519 keypair (for devices, writers, blind invites).
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
