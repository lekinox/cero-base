import { test, expect } from '../fixtures.js'

// from the window to the first screen; the goal is well under a second, the rest is slack for a busy machine
const limit = 2000

// another app is open, as a second instance or a test's other peer is
async function other(launch) {
  const { page } = await launch('other')
  await expect(page.getByPlaceholder('Your name')).toBeVisible()
}

async function shows(page, placeholder) {
  const start = Date.now()
  await expect(page.getByPlaceholder(placeholder)).toBeVisible()
  expect(Date.now() - start).toBeLessThan(limit)
}

test('a fresh app shows its setup screen within 2 s of its window', async ({ launch }) => {
  await other(launch)
  const { page } = await launch('alice')
  await shows(page, 'Your name')
})

test('a restart with a profile shows its room list within 2 s of its window', async ({
  launch
}) => {
  const alice = await launch('alice')
  await alice.page.getByPlaceholder('Your name').fill('Alice')
  await alice.page.getByRole('button', { name: 'Continue' }).click()
  await expect(alice.page.getByPlaceholder('Room name')).toBeVisible()
  await alice.close()

  await other(launch)
  const { page } = await launch('alice', { storage: alice.storage })
  await shows(page, 'Room name')
})
