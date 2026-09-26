/**
 * @cero-base/core — primitives for building p2p applications. This barrel
 * re-exports the canonical surface: identity, storage, network, database,
 * blobs, rpc, pairing, the schema DSL, the error class, and shared utils.
 *
 * Tree-shake-friendly: subpath imports (`@cero-base/core/identity`, etc.)
 * are also available for consumers that need a smaller graph.
 */
export * from './identity/index.js';
export { Storage } from './storage/index.js';
export type StorageRef = import('./storage/index.js').Ref;
export type StorageOpts = import('./storage/index.js').StorageOpts;
/**
 * The database exports its `Ref` already, so storage's typedefs come under storage names; rows
 * and results are the database's.
 *
 * @typedef {import('./storage/index.js').Ref} StorageRef
 * @typedef {import('./storage/index.js').StorageOpts} StorageOpts
 */
export * from './network/index.js';
export * from './database/index.js';
export * from './blobs/index.js';
export * from './rpc/index.js';
export * from './mailbox/index.js';
export * from './pairing/index.js';
export { Invite } from './pairing/invite.js';
export type InviteFields = import('./pairing/invite.js').InviteFields;
/**
 * @typedef {import('./pairing/invite.js').InviteFields} InviteFields
 */
export * from './lib/schema.js';
export * from './lib/utils.js';
export * from './lib/errors.js';
