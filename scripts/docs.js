#!/usr/bin/env node

// fails when a doc names API the source no longer has: imports, facade verbs, methods of core objects
import { readFileSync, readdirSync } from 'fs'
import { resolve, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

import { cero } from '@cero-base/cero'
import { cero as client } from '@cero-base/cero/client'
import { Database } from '@cero-base/core/database'
import { Pairing } from '@cero-base/core/pairing'
import { Request } from '../packages/core/src/pairing/request.js'
import { Mailbox } from '@cero-base/core/mailbox'
import { Network } from '@cero-base/core/network'
import { Identity } from '@cero-base/core/identity'
import { Invite } from '@cero-base/core/invite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  ...readdirSync(resolve(root, 'docs'))
    .filter((f) => f.endsWith('.md') && f !== 'CLAUDE.md')
    .map((f) => `docs/${f}`),
  'skills/cero/SKILL.md',
  'README.md',
  'packages/cero/README.md',
  'packages/core/README.md'
]

// a core doc names objects by these variables; everywhere else a context has no methods
const CORE = {
  db: Database.prototype,
  room: Database.prototype,
  pairing: Pairing.prototype,
  request: Request.prototype,
  mailbox: Mailbox.prototype,
  net: Network.prototype,
  network: Network.prototype,
  identity: Identity.prototype,
  Database,
  Pairing,
  Mailbox,
  Network,
  Identity,
  Invite
}
const CONTEXTS = new Set(['me', 'room', 'client'])

const problems = []

for (const file of files) {
  const text = readFileSync(resolve(root, file), 'utf8')
  const core = file === 'docs/core.md' || file === 'packages/core/README.md'
  for (const [n, line] of text.split('\n').entries()) {
    const at = `${file}:${n + 1}`
    for (const [, names, from] of line.matchAll(
      /import \{([^}]+)\} from '(@cero-base\/[\w/-]+)'/g
    )) {
      const mod = await import(from).catch(() => null)
      if (!mod) problems.push(`${at}: '${from}' does not resolve`)
      for (const name of names.split(',').map((s) => s.trim().split(/\s+as\s+/)[0])) {
        if (mod && name && !(name in mod)) problems.push(`${at}: '${from}' exports no '${name}'`)
      }
    }
    for (const [, verb] of line.matchAll(/\bcero\.(\w+)\(/g)) {
      if (!(verb in cero) && !(verb in client)) problems.push(`${at}: cero.${verb} does not exist`)
    }
    for (const [, name, method] of line.matchAll(/(?<![\w.])(\w+)\.(\w+)\(/g)) {
      if (core && CORE[name] && !(method in CORE[name])) {
        problems.push(`${at}: ${name}.${method}() does not exist`)
      } else if (!core && CONTEXTS.has(name)) {
        problems.push(
          `${at}: ${name}.${method}() — a context has no methods, use cero.${method}(${name})`
        )
      }
    }
  }
}

// every js block parses as written, imports and exports aside, and every link lands
const AsyncFunction = (async () => {}).constructor
const slug = (h) =>
  h
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .replace(/ /g, '-')
const anchors = (file) =>
  new Set(
    readFileSync(resolve(root, file), 'utf8')
      .split('\n')
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) => slug(l.replace(/^#+ /, '')))
  )

for (const file of files) {
  const text = readFileSync(resolve(root, file), 'utf8')
  for (const [block, code] of text.matchAll(/```js\n([\s\S]*?)```/g)) {
    const line = text.slice(0, text.indexOf(block)).split('\n').length
    const body = code.replace(/^import .*$/gm, '').replace(/^export (default )?/gm, '')
    try {
      new AsyncFunction(body)
    } catch (err) {
      problems.push(`${file}:${line}: the block does not parse: ${err.message}`)
    }
  }
  if (!file.startsWith('docs/')) continue
  for (const [, target, hash] of text.matchAll(/\]\((?!https?:)([\w-]*\.md)?(?:#([\w-]+))?\)/g)) {
    const to = target ? `docs/${target}` : file
    if (target && !files.includes(to)) {
      problems.push(`${file}: links to ${target}, which does not exist`)
    } else if (hash && !anchors(to).has(hash)) {
      problems.push(`${file}: links to ${to}#${hash}, no such heading`)
    }
  }
}

for (const p of problems) console.error(p)
if (problems.length) {
  console.error(`\n${problems.length} doc problem(s)`)
  process.exit(1)
}
console.log(`docs: ${files.length} files match the source`)
