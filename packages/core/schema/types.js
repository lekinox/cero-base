// Internal envelope types for @cero-base/core primitives.
// Edit this file then run `node schema/build.js` to regenerate src/lib/schema/.

export const NS = 'cero'

export const types = [
  // Pairing invite, z32-encoded as the wire form: where to knock and the seed that proves it.
  {
    name: 'invite',
    compact: false,
    fields: [
      { name: 'version', type: 'uint', required: true },
      { name: 'expires', type: 'uint', required: true },
      { name: 'discoveryKey', type: 'fixed32', required: true },
      { name: 'address', type: 'fixed32', required: true },
      { name: 'seed', type: 'fixed32', required: true },
      { name: 'data', type: 'buffer', required: false }
    ]
  },
  // Pairing knock — sealed to the invite's address. `proof` is the invite's signature over `reply`,
  // `signature` the joiner identity's over the knock, so the member it becomes is proven.
  {
    name: 'knock',
    compact: false,
    fields: [
      { name: 'id', type: 'fixed32', required: true },
      { name: 'reply', type: 'fixed32', required: true },
      { name: 'proof', type: 'fixed64', required: true },
      { name: 'identity', type: 'fixed32', required: true },
      { name: 'writer', type: 'fixed32', required: true },
      { name: 'signature', type: 'fixed64', required: true }
    ]
  },
  // One encryption epoch a new member needs to read the history before it joined.
  {
    name: 'epoch',
    compact: true,
    fields: [
      { name: 'epoch', type: 'uint', required: true },
      { name: 'stamp', type: 'uint', required: true },
      { name: 'entropy', type: 'fixed32', required: true }
    ]
  },
  // Pairing confirm/deny response — sealed to the joiner's reply address.
  {
    name: 'confirm',
    compact: false,
    fields: [
      { name: 'status', type: 'uint', required: true }, // 0 = confirm, 1 = deny
      { name: 'reason', type: 'string', required: false },
      { name: 'key', type: 'fixed32', required: false },
      { name: 'encryptionKey', type: 'buffer', required: false },
      { name: 'epochs', type: '@cero/epoch', required: false, array: true }
    ]
  },

  // ─── Wire envelope types for @cero-base/core/rpc codec ─────────────────────────

  // Array of pre-encoded row buffers — used for collection responses.
  {
    name: 'rows',
    compact: false,
    fields: [{ name: 'data', type: 'buffer', required: false, array: true }]
  },

  // Parallel arrays of pre-encoded row buffers for delta batches — an empty
  // buffer marks a missing side (insert has no prev, delete no next).
  {
    name: 'changes',
    compact: false,
    fields: [
      { name: 'prev', type: 'buffer', required: false, array: true },
      { name: 'next', type: 'buffer', required: false, array: true }
    ]
  },

  // Typed query envelope — standard filter fields + a json escape hatch.
  {
    name: 'query',
    compact: false,
    fields: [
      { name: 'gt', type: 'string', required: false },
      { name: 'gte', type: 'string', required: false },
      { name: 'lt', type: 'string', required: false },
      { name: 'lte', type: 'string', required: false },
      { name: 'limit', type: 'uint', required: false },
      { name: 'reverse', type: 'bool', required: false },
      { name: 'data', type: 'json', required: false }
    ]
  },

  // Handle creation input envelope.
  {
    name: 'create',
    compact: false,
    fields: [
      { name: 'id', type: 'string', required: false },
      { name: 'name', type: 'string', required: false },
      { name: 'role', type: 'string', required: false },
      // inverted so the non-default (accept: false) survives truthy-presence encoding
      { name: 'noAccept', type: 'bool', required: false }
    ]
  },

  // Self-describing blob locator — z32-encoded as a durable file id.
  {
    name: 'blob-id',
    compact: false,
    fields: [
      { name: 'coreKey', type: 'fixed32', required: true },
      { name: 'blockOffset', type: 'uint', required: true },
      { name: 'blockLength', type: 'uint', required: true },
      { name: 'byteOffset', type: 'uint', required: true },
      { name: 'byteLength', type: 'uint', required: true },
      { name: 'type', type: 'string', required: true }
    ]
  }
]
