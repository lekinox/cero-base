#!/usr/bin/env node

// Clean-room packaging gate. Two checks per package:
//
//   1. Static: every bare import in the shipped source resolves to a declared
//      dependency, a Node builtin, or a `#` subpath import. Non-`#` keys in the
//      "imports" map do NOT count: Node ignores them, so a module importable
//      only under Bare would slip through.
//   2. Install: pack each package, install the tarballs into an empty project
//      (default hoisting, like a real `npm install`), and import each under
//      plain Node — catches dead import maps, bad exports, and ESM breakage.
//
// Together these catch phantom deps and Bare-only imports, which the
// monorepo's own node_modules hoisting hides.

import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { builtinModules } from 'module'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['packages/core', 'packages/cero', 'packages/tools']
const NAMES = ['@cero-base/core', '@cero-base/cero', '@cero-base/tools']

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

// The package root of a bare specifier: '@scope/n/sub' → '@scope/n', 'pkg/sub' → 'pkg'.
function pkgRoot(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function* jsFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // optional source dir (e.g. no bin/)
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* jsFiles(p)
    else if (e.name.endsWith('.js')) yield p
  }
}

// Bare (non-relative, non-#) specifiers imported anywhere in a package's source.
function imports(pkgDir, sources) {
  const found = new Set()
  for (const sub of sources) {
    for (const file of jsFiles(join(pkgDir, sub))) {
      // strip block comments so JSDoc `@example import ... from '...'` isn't scanned
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
        const spec = m[1]
        // a template placeholder is emitted code, not an import of this package
        if (spec.startsWith('.') || spec.startsWith('#') || spec.includes('${')) continue
        found.add(pkgRoot(spec))
      }
    }
  }
  return found
}

function staticCheck() {
  console.log('\nStatic dependency check (declared deps + builtins only):')
  let bad = 0
  for (const dir of PACKAGES) {
    const pkg = readJson(join(root, dir, 'package.json'))
    // self-references resolve through the package's own exports map (valid in Node)
    const declared = new Set([...Object.keys(pkg.dependencies || {}), pkg.name])
    const undeclared = [...imports(join(root, dir), ['src', 'bin'])].filter(
      (s) => !declared.has(s) && !BUILTINS.has(s)
    )
    if (undeclared.length) {
      console.error(`  ✗ ${pkg.name}: undeclared imports → ${undeclared.join(', ')}`)
      bad++
    } else {
      console.log(`  ✓ ${pkg.name}`)
    }
  }
  if (bad) throw new Error(`${bad} package(s) import undeclared dependencies`)
}

function installCheck() {
  const work = mkdtempSync(join(tmpdir(), 'cero-smoke-'))
  const packDir = join(work, 'tarballs')
  const proj = join(work, 'app')
  mkdirSync(packDir)
  mkdirSync(proj)
  // No shell: arguments pass directly, so temp paths never need quoting.
  const npm = (args, cwd) =>
    execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  try {
    console.log(`\nClean-room install + import → ${work}`)
    const tarballs = []
    for (const dir of PACKAGES) {
      const [{ filename }] = JSON.parse(
        npm(['pack', '-w', dir, '--json', '--pack-destination', packDir], root)
      )
      tarballs.push(join(packDir, filename))
      console.log(`  packed ${dir}`)
    }

    writeFileSync(
      join(proj, 'package.json'),
      JSON.stringify({ name: 'cero-smoke', private: true, type: 'module' }, null, 2) + '\n'
    )

    console.log('  installing tarballs (registry deps fetched)...')
    npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', ...tarballs], proj)

    console.log('  importing every exports subpath under plain Node...')
    const subs = []
    for (let i = 0; i < PACKAGES.length; i++) {
      const pkg = readJson(join(root, PACKAGES[i], 'package.json'))
      for (const key of Object.keys(pkg.exports || {})) {
        if (key.includes('package.json')) continue
        subs.push(NAMES[i] + key.slice(1))
      }
    }
    const js = subs.map((n) => `await import('${n}')`).join('; ') + "; console.log('imports ok')"
    execFileSync('node', ['--input-type=module', '-e', js], {
      cwd: proj,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    console.log('  ✓ all three install and import in a clean room')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

try {
  staticCheck()
  installCheck()
  console.log('\n✓ smoke passed\n')
} catch (err) {
  process.stderr.write(`\n✗ smoke FAILED\n${err.stdout || ''}${err.stderr || ''}${err.message}\n\n`)
  process.exitCode = 1
}
