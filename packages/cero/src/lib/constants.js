export const NS = 'cero'
export const COUNTERS = 'counters'
export const EPOCHS = 'epochs'

// Writer-admission / pairing timeout (ms), and the initial discovery-flush wait (ms).
export const TIMEOUT = 30000
export const FLUSH = 500

// schema-DSL primitive → HyperDB type (used by the builder).
export const DB_TYPE = {
  string: 'string',
  uint: 'uint',
  int: 'int',
  bool: 'bool',
  bytes: 'buffer',
  json: 'json',
  fixed32: 'fixed32',
  fixed64: 'fixed64',
  file: 'string'
}
