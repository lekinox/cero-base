import b4a from 'b4a'

const DEFAULT_DENY =
  /^(seed|secret|secretkey|password|passphrase|token|private|privatekey|encryptionkey|mnemonic)$/i

/**
 * Build a row masker for devtools. A field is masked when its dotted path is in `fields`,
 * its name matches `deny` (default denylist above), or `match(key, value, path)` returns
 * true.
 *
 * @param {{ fields?: string[], deny?: RegExp | false, match?: (key: string, value: any, path: string) => boolean }} [config]
 * @returns {(ref: string, row: any) => any}
 */
export function redact(config = {}) {
  const fields = new Set(config.fields || [])
  const deny = config.deny === false ? null : config.deny || DEFAULT_DENY
  const match = typeof config.match === 'function' ? config.match : null

  const isBytes = (v) => b4a.isBuffer(v)
  const mask = (v) =>
    isBytes(v) ? `‹redacted:bytes(${v.length})›` : `‹redacted:${v === null ? 'null' : typeof v}›`

  const walk = (value, path) => {
    if (isBytes(value)) return value
    if (Array.isArray(value)) return value.map((v) => walk(v, path))
    if (value && typeof value === 'object') {
      const out = {}
      for (const k of Object.keys(value)) {
        const p = path ? `${path}.${k}` : k
        const v = value[k]
        out[k] =
          fields.has(p) || (deny && deny.test(k)) || (match && match(k, v, p))
            ? mask(v)
            : walk(v, p)
      }
      return out
    }
    return value
  }

  return (ref, row) => (row && typeof row === 'object' && !isBytes(row) ? walk(row, '') : row)
}
