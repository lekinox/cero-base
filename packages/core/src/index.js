/**
 * @cero-base/core — primitives for building p2p applications. This barrel
 * re-exports the canonical surface: identity, storage, network, database,
 * blobs, rpc, pairing, the schema DSL, the error class, and shared utils.
 *
 * Tree-shake-friendly: subpath imports (`@cero-base/core/identity`, etc.)
 * are also available for consumers that need a smaller graph.
 */

export * from './identity/index.js'
// colliding typedef names from storage and pairing are re-exported under aliases
export { Storage } from './storage/index.js'
/**
 * `Ref` / `SingleResult` / `ListResult` are JSDoc typedefs (types, not runtime exports),
 * so they are re-exported as namespaced type aliases — `export { Ref as StorageRef }`
 * fails at import because the.
 *
 * @typedef {import('./storage/index.js').Ref} StorageRef
 * @typedef {import('./storage/index.js').SingleResult} StorageSingleResult
 * @typedef {import('./storage/index.js').ListResult} StorageListResult
 * @typedef {import('./storage/index.js').StorageOpts} StorageOpts
 * @typedef {import('./storage/index.js').StoredRow} StoredRow
 * @typedef {import('./storage/index.js').GetByIdResult} GetByIdResult
 */
export * from './network/index.js'
export * from './database/index.js'
export * from './blobs/index.js'
export * from './rpc/index.js'
export * from './pairing/index.js'
export { Invite } from './pairing/invite.js'
/**
 * `CreateInviteOpts` is a typedef (not a runtime export); re-export it as a type alias.
 * @typedef {import('./pairing/invite.js').CreateInviteOpts} MintInviteOpts
 * @typedef {import('./pairing/invite.js').InviteFields} InviteFields
 * @typedef {import('./pairing/invite.js').ParseInviteOpts} ParseInviteOpts
 */
export * from './lib/schema.js'
export * from './lib/utils.js'
export * from './lib/errors.js'
