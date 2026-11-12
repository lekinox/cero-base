import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  globalSetup: './setup.js',
  // a test opens up to four apps that pair over a local network
  timeout: 180_000,
  expect: { timeout: 45_000 },
  workers: 2,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
})
