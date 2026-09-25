#!/usr/bin/env node

// writes the skill's references from docs/: the nav line goes, links outside the skill become text
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docs = resolve(root, 'docs')
const refs = resolve(root, 'skills/cero/references')

const files = readdirSync(refs).filter((f) => existsSync(resolve(docs, f)))

for (const f of files) {
  const md = readFileSync(resolve(docs, f), 'utf8')
    .replace(/^\[Docs\]\(README\.md\).*\n\n/m, '')
    .replace(/\[([^\]]+)\]\(([\w-]+\.md)(#[^)]*)?\)/g, (link, text, file) =>
      files.includes(file) ? link : text
    )
  writeFileSync(resolve(refs, f), md)
}
