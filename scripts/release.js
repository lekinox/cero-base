#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const PACKAGES = ['packages/core', 'packages/cero', 'packages/tools']
const SCOPE = '@cero-base/'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const bump = args.find((a) => ['patch', 'minor', 'major'].includes(a))

if (!bump) {
  console.error('Usage: node scripts/release.js <patch|minor|major> [--dry-run]')
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number)
  if (type === 'major') return `${major + 1}.0.0`
  if (type === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`)
  if (!dryRun || opts.force) {
    return execSync(cmd, { cwd: root, stdio: 'inherit', ...opts })
  }
}

function exec(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim()
}

function generateChangelog(version) {
  const lastTag = exec('git describe --tags --abbrev=0 2>/dev/null || echo ""')
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
  const log = exec(`git log ${range} --pretty=format:"%s" --no-merges`)
  if (!log) return null

  const categories = {
    feat: { title: 'Features', items: [] },
    fix: { title: 'Bug Fixes', items: [] },
    refactor: { title: 'Refactoring', items: [] },
    perf: { title: 'Performance', items: [] },
    docs: { title: 'Documentation', items: [] },
    chore: { title: 'Chores', items: [] }
  }
  const other = []

  for (const line of log.split('\n')) {
    // subjects carry a leading emoji
    const match = line.replace(/^[^\w]+/, '').match(/^(\w+)(?:\(.+?\))?:\s*(.+)/)
    if (match && categories[match[1]]) {
      categories[match[1]].items.push(match[2])
    } else if (!line.startsWith('release:')) {
      other.push(line)
    }
  }

  const date = new Date().toISOString().split('T')[0]
  let md = `## ${version} (${date})\n\n`

  for (const cat of Object.values(categories)) {
    if (cat.items.length === 0) continue
    md += `### ${cat.title}\n\n`
    for (const item of cat.items) md += `- ${item}\n`
    md += '\n'
  }

  if (other.length > 0) {
    md += '### Other\n\n'
    for (const item of other) md += `- ${item}\n`
    md += '\n'
  }

  return md
}

// 0. Preflight — fail fast, before any mutation, on a real release.
if (!dryRun) {
  const dirty = exec('git status --porcelain')
  if (dirty) {
    console.error(
      '\n✗ working tree is not clean — commit or stash first so the release commit\n' +
        '  contains only the version bump:\n\n' +
        dirty +
        '\n'
    )
    process.exit(1)
  }
  const branch = exec('git rev-parse --abbrev-ref HEAD')
  if (branch !== 'main' && !args.includes('--any-branch')) {
    console.error(`\n✗ releasing from '${branch}' — merge to main first (or pass --any-branch)\n`)
    process.exit(1)
  }
  exec('git fetch origin')
  const behind = exec(`git rev-list --count HEAD..origin/${branch} 2>/dev/null || echo 0`)
  if (Number(behind) > 0) {
    console.error(`\n✗ ${branch} is ${behind} commit(s) behind origin — pull first\n`)
    process.exit(1)
  }
  try {
    console.log(`  npm user: ${exec('npm whoami')}`)
  } catch {
    console.error('\n✗ not authenticated to npm — run `npm login` before releasing\n')
    process.exit(1)
  }
}

// 1. Read current version
const rootPkg = readJson(resolve(root, 'package.json'))
const current = rootPkg.version
const next = bumpVersion(current, bump)

console.log(`\nReleasing ${current} → ${next} (${bump})${dryRun ? ' [dry run]' : ''}\n`)

// 2. Update root version
rootPkg.version = next
console.log(`  root: ${current} → ${next}`)
if (!dryRun) writeJson(resolve(root, 'package.json'), rootPkg)

// 3. Update each package version + internal deps
for (const dir of PACKAGES) {
  const pkgPath = resolve(root, dir, 'package.json')
  const pkg = readJson(pkgPath)
  const old = pkg.version
  pkg.version = next

  for (const depType of ['dependencies', 'peerDependencies']) {
    if (!pkg[depType]) continue
    for (const dep of Object.keys(pkg[depType])) {
      if (dep.startsWith(SCOPE)) {
        pkg[depType][dep] = `^${next}`
      }
    }
  }

  console.log(`  ${pkg.name}: ${old} → ${next}`)
  if (!dryRun) writeJson(pkgPath, pkg)
}

// 4. Generate changelog
console.log('\nGenerating changelog...')
const entry = generateChangelog(next)
if (entry) {
  if (dryRun) {
    console.log(entry)
  } else {
    const changelogPath = resolve(root, 'CHANGELOG.md')
    const existing = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : ''
    const header = '# Changelog\n\n'
    const body = existing.startsWith(header) ? existing.slice(header.length) : existing
    writeFileSync(changelogPath, header + entry + body)
    console.log('  Updated CHANGELOG.md')
  }
} else {
  console.log('  No commits to include')
}

// 5. Sync lockfile + regenerate types BEFORE the release commit
console.log('\nSyncing lockfile...')
run('npm install --package-lock-only')

console.log('\nRegenerating types...')
run('npm run build:types --workspaces --if-present')

// 6. Format + test (uncached — turbo caches `test` and a cache hit is not a gate)
console.log('\nFormatting...')
run('npm run format')

console.log('\nRunning tests...')
run('npm test -- --force', { force: true })

console.log('\nSmoke-testing a clean-room install...')
run('node scripts/smoke-install.js', { force: true })

// 7. Git commit + tag
console.log('\nCommitting...')
run('git add -A')
run(`git commit -m "release: v${next}"`)
run(`git tag v${next}`)

// 8. Publish to npm (local) — skip-if-published so a partial publish
// (network death between packages) is recoverable by re-running.
console.log('\nPublishing...')
for (const dir of PACKAGES) {
  const name = readJson(resolve(root, dir, 'package.json')).name
  let published = false
  try {
    published = exec(`npm view ${name}@${next} version 2>/dev/null`) === next
  } catch {}
  if (published) {
    console.log(`  ${name}@${next} already on npm — skipping`)
    continue
  }
  run(`npm publish -w ${dir}`)
}

// 9. Push
console.log('\nPushing...')
run(`git push && git push origin v${next}`)

console.log(`\n✓ Released v${next}${dryRun ? ' (dry run — nothing published or pushed)' : ''}`)
