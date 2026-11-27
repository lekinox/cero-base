#!/usr/bin/env node

// What is behind its latest release, in one table: the root, the packages, the services, then the
// examples. It reads each package.json, what is installed, and asks the registry once per name.

import { existsSync, readFileSync, readdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KINDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const folders = (parent) =>
  readdirSync(join(root, parent))
    .map((name) => join(parent, name))
    .filter((dir) => existsSync(join(root, dir, 'package.json')))

const dirs = ['.', ...folders('packages'), ...folders('services'), ...folders('example')]
const local = new Set(dirs.map((dir) => read(join(root, dir, 'package.json')).name))

// the copy a folder resolves: its own node_modules, else the root's
function installed(dir, name) {
  for (const base of [join(root, dir), root]) {
    const file = join(base, 'node_modules', name, 'package.json')
    if (existsSync(file)) return read(file).version
  }
  return null
}

const numbers = (version) => version.split('-')[0].split('.').map(Number)
const newer = (a, b) => {
  const [x, y] = [numbers(a), numbers(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

const wanted = []
for (const dir of dirs) {
  const pkg = read(join(root, dir, 'package.json'))
  for (const kind of KINDS) {
    for (const [name, range] of Object.entries(pkg[kind] || {})) {
      // a registry range only: not a sibling, a path, a url or an alias
      if (local.has(name) || !/^[\^~>=<\d*x]/.test(range)) continue
      wanted.push({ name, range, where: dir === '.' ? 'root' : dir, has: installed(dir, name) })
    }
  }
}

const latest = new Map()
await Promise.all(
  [...new Set(wanted.map((d) => d.name))].map(async (name) => {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`)
    latest.set(name, res.ok ? (await res.json()).version : null)
  })
)

// one row per name and version, with every folder that has it
const rows = new Map()
for (const d of wanted) {
  const now = latest.get(d.name)
  const from = d.has || d.range.replace(/^[^\d]*/, '')
  if (!now || !/^\d/.test(from) || !newer(now, from)) continue
  const key = `${d.name} ${from} ${d.range} ${d.where.startsWith('example/')}`
  const row = rows.get(key) || {
    name: d.name,
    installed: d.has || '-',
    range: d.range,
    latest: now
  }
  row.where = [...new Set([...(row.where || []), d.where])]
  rows.set(key, row)
}

const example = (row) => row.where.every((dir) => dir.startsWith('example/'))
const found = [...rows.values()].sort(
  (a, b) => example(a) - example(b) || a.name.localeCompare(b.name)
)
const cols = ['name', 'installed', 'range', 'latest', 'where']
const text = (row, key) => (key === 'where' ? row.where.join(', ') : row[key])
const width = (key) => Math.max(key.length, ...found.map((row) => text(row, key).length))
const line = (cells) => cols.map((key, i) => cells[i].padEnd(width(key))).join('  ')

if (found.length === 0) {
  console.log(`${latest.size} dependencies, all on their latest release`)
} else {
  console.log(line(cols))
  found.forEach((row, i) => {
    if (example(row) && (i === 0 || !example(found[i - 1]))) console.log('\nexamples')
    console.log(line(cols.map((key) => text(row, key))))
  })
  console.log(`\n${found.length} of ${latest.size} dependencies behind their latest release`)
}
