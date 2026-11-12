import { test, expect } from '../fixtures.js'

test('a phrase no device answers for waits for one, Cancel goes back to setup, and the profile comes in once a device of it is online', async ({
  launch
}) => {
  const alice = await launch('alice')
  await alice.page.getByPlaceholder('Your name').fill('Alice')
  await alice.page.getByRole('button', { name: 'Continue' }).click()
  await alice.page.getByPlaceholder('Room name').fill('clinic')
  await alice.page.getByRole('button', { name: 'New' }).click()
  await expect(alice.page.getByPlaceholder('Message...')).toBeVisible()
  await alice.page.getByRole('button', { name: '←' }).click()
  await alice.page.getByRole('button', { name: 'Alice' }).click()
  await alice.page.getByRole('button', { name: 'Show Seed' }).click()
  const phrase = await alice.page.getByText(/^\s*([a-z]+ ){11}[a-z]+\s*$/).innerText()
  await alice.close()

  const fresh = await launch('fresh')
  const recover = async () => {
    await fresh.page.getByPlaceholder('Enter your 12-word seed phrase').fill(phrase.trim())
    await fresh.page.getByRole('button', { name: 'Use Existing Seed' }).click()
    await expect(fresh.page.getByText('Looking for your other device')).toBeVisible({
      timeout: 2000
    })
  }

  await recover()
  await fresh.page.getByRole('button', { name: 'Cancel' }).click()
  await expect(fresh.page.getByPlaceholder('Your name')).toBeVisible()

  await recover()
  await launch('alice', { storage: alice.storage })
  await expect(fresh.page.getByText('clinic', { exact: true })).toBeVisible()
  await expect(fresh.page.getByRole('button', { name: 'Alice' })).toBeVisible()
})
