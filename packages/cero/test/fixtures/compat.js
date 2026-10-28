// the previous published release, installed once per version for the compatibility tests
import { execSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '.compat')
const version = execSync('npm view @cero-base/cero version', { encoding: 'utf8' }).trim()
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
