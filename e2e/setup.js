import { execFileSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// the apps run what the repo holds: the backend's spec and the window's bundle, built from it
export default function setup() {
  const run = (...args) => execFileSync('npm', args, { cwd: root, stdio: 'inherit' })
  run('run', 'build', '-w', 'chat-backend')
  run('run', 'build', '-w', 'chat-desktop')
}
