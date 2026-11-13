// the previous published release, installed once per version for the compatibility tests
import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '.compat')
// the newest release below this one: a release and the main it lands on test the same pair
const own = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).version
const versions = JSON.parse(
  execSync('npm view @cero-base/cero versions --json', { encoding: 'utf8' })
)
const version = versions.filter((v) => !v.includes('-') && below(v, own)).reduce(newest)
const dir = join(root, version)

if (!existsSync(join(dir, 'node_modules', '@cero-base', 'cero'))) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  execSync(`npm install --no-package-lock --no-audit --no-fund @cero-base/cero@${version}`, {
    cwd: dir,
    stdio: 'inherit'
  })
}
writeFileSync(join(root, 'previous.json'), JSON.stringify({ version, root: dir }) + '\n')

function parts(v) {
  return v.split('.').map(Number)
}

function below(a, b) {
  const [x, y] = [parts(a), parts(b)]
  const i = x.findIndex((n, j) => n !== y[j])
  return i !== -1 && x[i] < y[i]
}

function newest(a, b) {
  return below(a, b) ? b : a
}
