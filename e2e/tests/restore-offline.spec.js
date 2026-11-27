import { Identity } from '@cero-base/core/identity'
import { test, expect } from '../fixtures.js'

// Alice's app, with a room, closed once her phrase is read
async function offline(launch) {
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
  return { storage: alice.storage, phrase: phrase.trim() }
}

test('a phrase no device answers for waits for one, Cancel goes back to setup, and the profile comes in once a device of it is online', async ({
  launch
}) => {
  const alice = await offline(launch)
  const fresh = await launch('fresh')
  const recover = async () => {
    await fresh.page.getByPlaceholder('Enter your 12-word seed phrase').fill(alice.phrase)
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

// an app stores a recovery before it looks for a device of the profile: found looking, a quit keeps it
async function looking(testnet, phrase) {
  const { topic } = await Identity.create({ seed: Identity.toSeed(phrase) })
  const node = testnet.createNode()
  try {
    await expect
      .poll(async () => {
        for await (const { peers } of node.lookup(topic)) if (peers.length) return true
        return false
      })
      .toBe(true)
  } finally {
    await node.destroy()
  }
}

test('quitting while it waits for another device opens again to the wait, and the profile comes in once a device of it is online', async ({
  launch,
  testnet
}) => {
  const alice = await offline(launch)
  const fresh = await launch('fresh')
  await fresh.page.getByPlaceholder('Enter your 12-word seed phrase').fill(alice.phrase)
  await fresh.page.getByRole('button', { name: 'Use Existing Seed' }).click()
  await expect(fresh.page.getByText('Looking for your other device')).toBeVisible()
  await looking(testnet, alice.phrase)
  await fresh.close()

  const again = await launch('fresh', { storage: fresh.storage })
  await expect(again.page.getByText('Looking for your other device')).toBeVisible()
  await expect(again.page.getByPlaceholder('Your name')).toHaveCount(0)

  await launch('alice', { storage: alice.storage })
  await expect(again.page.getByText('clinic', { exact: true })).toBeVisible()
  await expect(again.page.getByRole('button', { name: 'Alice' })).toBeVisible()
})
