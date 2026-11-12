import { test as base, expect, _electron as electron } from '@playwright/test'
import createTestnet from '@hyperswarm/testnet'
import { createRequire } from 'module'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = path.join(root, 'example', 'chat-desktop')
const executablePath = createRequire(path.join(app, 'package.json'))('electron')

export const test = base.extend({
  // one local network per test: its apps find each other there, never on the public one
  testnet: async ({}, use) => {
    const testnet = await createTestnet(3)
    await use(testnet)
    await testnet.destroy()
  },

  // launch(name) opens an app with a folder of its own; launch(name, { storage }) opens that folder again
  launch: async ({ testnet }, use) => {
    const opened = []
    const folders = new Set()
    const bootstrap = testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
    const launch = async (name, { storage } = {}) => {
      const dir = storage ?? (await mkdtemp(path.join(tmpdir(), `cero-e2e-${name}-`)))
      folders.add(dir)
      const electronApp = await electron.launch({
        executablePath,
        cwd: app,
        args: [app, '--no-updates', '--no-devtools', '--storage', dir, '--bootstrap', bootstrap]
      })
      opened.push(electronApp)
      const page = await electronApp.firstWindow()
      return { name, app: electronApp, page, storage: dir, close: () => electronApp.close() }
    }
    await use(launch)
    for (const electronApp of opened) await electronApp.close().catch(() => {})
    for (const dir of folders) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

export { expect }
