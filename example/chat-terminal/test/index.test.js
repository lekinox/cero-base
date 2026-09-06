import test from 'brittle'
import { spawn } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import createTestnet from '@hyperswarm/testnet'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'index.js')

test('two terminal instances pair + exchange messages', { timeout: 120000 }, async (t) => {
  const net = await createTestnet(3)
  t.teardown(() => net.destroy(), { order: 100 })
  const bootstrap = net.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')

  const host = launch(t, [
    '--create',
    '--name',
    'host',
    '--storage',
    tmp(),
    '--bootstrap',
    bootstrap
  ])
  // invite is a single z32 line, well over 40 chars, no spaces, no leading '#'
  const inv = await waitFor(host, (line) => /^[a-z0-9]{60,}$/.test(line))

  const guest = launch(t, [
    '--join',
    inv,
    '--name',
    'guest',
    '--storage',
    tmp(),
    '--bootstrap',
    bootstrap
  ])

  // Wait for guest to print its boot banner ("# room: ...") so we know it's wired
  await waitFor(guest, (line) => line.startsWith('# room:'))

  host.stdin.write('hello from host\n')
  await waitFor(guest, (line) => line.includes('hello from host'))
  t.pass('guest saw host message')

  guest.stdin.write('hi back\n')
  await waitFor(host, (line) => line.includes('hi back'))
  t.pass('host saw guest message')
})

function tmp() {
  return mkdtempSync(join(tmpdir(), 'chat-terminal-test-'))
}

function launch(t, args) {
  const proc = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  proc.lines = []
  proc.waiters = []
  let buf = ''
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      proc.lines.push(line)
      for (const w of proc.waiters.splice(0)) {
        if (w.pred(line)) w.resolve(line)
        else proc.waiters.push(w)
      }
    }
  })
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[${args[0]}] ${chunk}`)
  })
  t.teardown(() => {
    proc.kill('SIGTERM')
  })
  return proc
}

function waitFor(proc, pred, timeoutMs = 60000) {
  for (const line of proc.lines) if (pred(line)) return Promise.resolve(line)
  return new Promise((resolve, reject) => {
    const w = { pred, resolve }
    proc.waiters.push(w)
    const t = setTimeout(() => {
      proc.waiters = proc.waiters.filter((x) => x !== w)
      reject(new Error(`timeout waiting for line. saw:\n${proc.lines.join('\n')}`))
    }, timeoutMs)
    const orig = w.resolve
    w.resolve = (line) => {
      clearTimeout(t)
      orig(line)
    }
  })
}
