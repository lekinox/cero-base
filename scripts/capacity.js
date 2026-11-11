#!/usr/bin/env node

// A root as the handles it holds grow, outside the suite: built up to 1,000, 10,000 and 100,000 handles rows (a
// million with `--max 1000000`, about half an hour), launched three times at each, one row changed after a launch.
// Fails when the best launch or change takes over three times what it does at 1,000, or the lightest launch adds
// over 64 MB more resident memory than it does there.

import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bare = join(root, 'node_modules/.bin/bare')
const worker = join(root, 'packages/cero/test/manual/capacity.js')

const RUNS = 3
const FACTOR = 3
const MEMORY = 64
// a root that stays open grows as it writes: a process to every 100,000 rows
const CHUNK = 100000
const LIMITS = {
  'launch ms': (base) => base * FACTOR,
  'change ms': (base) => base * FACTOR,
  'launch MB': (base) => base + MEMORY
}

const flag = process.argv.indexOf('--max')
const max = flag === -1 ? 100000 : Number(process.argv[flag + 1])
const sizes = [1000, 10000, 100000, 1000000].filter((size) => size <= max)
if (!sizes.length) throw new Error('--max takes a number of handles, 1000 or more')

const run = (...args) => JSON.parse(execFileSync(bare, [worker, ...args], { encoding: 'utf8' }))
const round = (value) => Math.round(value * 10) / 10

const dir = mkdtempSync(join(tmpdir(), 'cero-capacity-'))
const rows = []
try {
  let built = 0
  let id = null
  for (const handles of sizes) {
    const start = Date.now()
    while (built < handles) {
      const count = Math.min(CHUNK, handles - built)
      ;({ id } = run('build', dir, built, count))
      built += count
    }
    const build = (Date.now() - start) / 1000
    const runs = Array.from({ length: RUNS }, () => run('launch', dir, id))
    // what else the machine does only adds, as does the launch right after a build: the least is the steady one
    const best = (name) => Math.min(...runs.map((r) => r[name]))
    rows.push({
      handles,
      'build s': round(build),
      'launch ms': round(best('launch')),
      'change ms': round(best('change')),
      'launch MB': round(best('rss') / 1048576)
    })
    console.error(`${handles} handles measured`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.table(rows)

const [base, ...larger] = rows
const over = []
for (const row of larger) {
  for (const [name, limit] of Object.entries(LIMITS)) {
    if (row[name] <= limit(base[name])) continue
    over.push(`${name} at ${row.handles} handles: ${row[name]}, over ${round(limit(base[name]))}`)
  }
}
if (over.length) {
  console.error(over.join('\n'))
  process.exit(1)
}
