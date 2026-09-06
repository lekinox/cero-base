import process from 'process'
import b4a from 'b4a'

const ROW_MAX = 80
const E = '\x1b['
const COLOR = !process.env.NO_COLOR && !!(process.stdout && process.stdout.isTTY)
const paint = (code) => (s) => (COLOR ? `${E}${code}m${s}${E}0m` : String(s))
const c = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
  magenta: paint(35),
  gray: paint(90)
}

function shortRow(row) {
  if (row == null) return ''
  const s = JSON.stringify(row)
  return s.length > ROW_MAX ? s.slice(0, ROW_MAX - 1) + '…' : s
}

function shortKey(key) {
  if (key == null) return ''
  if (b4a.isBuffer(key)) return b4a.toString(key, 'hex').slice(0, 8)
  return String(key).slice(0, 8)
}

/**
 * Render a handle tree (`[{ id, type }]`) as a short colored list.
 *
 * @param {Array<{ id: string, type: string | null }>} tree
 * @returns {string}
 */
export function formatHandles(tree) {
  if (!tree || !tree.length) return c.dim('handles: (none)')
  const lines = tree.map((h) => `  ${c.cyan(h.type || 'root')} ${c.gray(h.id)}`)
  return `${c.bold(`handles (${tree.length})`)}\n${lines.join('\n')}`
}

/**
 * Render a `get()` reply — `{ data, total, size }` for collections or
 * `{ data }` for single refs — as a compact summary.
 *
 * @param {string} ref
 * @param {{ data: any, total?: number, size?: number }} result
 * @returns {string}
 */
export function formatState(ref, result) {
  const data = result?.data
  if (Array.isArray(data)) {
    const total = result.total ?? data.length
    const head = data.slice(0, 3).map((r) => '  ' + c.dim(shortRow(r)))
    return `${c.cyan(ref)} ${c.gray(`(${total})`)}\n${head.join('\n')}`
  }
  return `${c.cyan(ref)} ${c.dim(shortRow(data))}`
}

/**
 * Render a failed ref lookup as one line (so the CLI keeps going).
 *
 * @param {string} ref
 * @param {{ message?: string }} err
 * @returns {string}
 */
export function formatError(ref, err) {
  return `${c.red('✗')} ${c.cyan(ref)}  ${c.dim(err.message || String(err))}`
}

const OP_COLOR = { add: c.green, set: c.yellow, del: c.red, claim: c.magenta }

/**
 * Render one applied-op event as a single colored line.
 *
 * @param {{ op: string, name: string, row: any, writerKey?: any, seq?: number }} e
 * @returns {string}
 */
export function formatEvent(e) {
  const writer = shortKey(e.writerKey)
  const tail = writer ? c.gray(` ${writer}`) : ''
  const op = (OP_COLOR[e.op] || c.cyan)(e.op)
  return `${c.gray('#' + (e.seq ?? '?'))} ${op} ${c.cyan(e.name)} ${c.dim(shortRow(e.row))}${tail}`
}

/**
 * Render a stats snapshot as a single colored line.
 *
 * @param {{ network?: { connections: number, peers: number }, bee?: { local: number }, cores?: any[] }} s
 * @returns {string}
 */
export function formatStats(s) {
  const conns = s?.network?.connections ?? 0
  const peers = s?.network?.peers ?? 0
  const local = s?.bee?.local ?? 0
  const cores = s?.cores?.length ?? 0
  return `${c.gray('net')} ${c.cyan(conns + 'c')}/${c.cyan(peers + 'p')}  ${c.gray('bee')} ${c.cyan(local)}  ${c.gray('cores')} ${c.cyan(cores)}`
}
