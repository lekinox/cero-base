import { test, expect } from '../fixtures.js'

const PHRASE = /^[a-z]+( [a-z]+){11}$/

async function alice(launch) {
  const app = await launch('alice')
  const { page } = app
  await page.getByPlaceholder('Your name').fill('Alice')
  await page.getByRole('button', { name: 'Continue' }).click()

  await page.getByPlaceholder('Room name').fill('clinic')
  await page.getByRole('button', { name: 'New' }).click()
  await send(page, 'first visit')
  await send(page, 'second visit')
  await page.getByRole('button', { name: '←' }).click()

  await page.getByRole('button', { name: 'Alice' }).click()
  await page.getByRole('button', { name: 'Show Seed' }).click()
  const phrase = await page.getByText(PHRASE).textContent()
  await page.getByRole('button', { name: '←' }).click()
  return { ...app, phrase }
}

async function send(page, text) {
  await page.getByPlaceholder('Message...').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(text, { exact: true })).toBeVisible()
}

async function recover(launch, phrase) {
  const app = await launch('recovered')
  await app.page.getByPlaceholder('Enter your 12-word seed phrase').fill(phrase)
  await app.page.getByRole('button', { name: 'Use Existing Seed' }).click()
  return app
}

test('a fresh app given the seed phrase becomes the same profile, with its room and messages', async ({
  launch
}) => {
  const { phrase } = await alice(launch)
  const { page } = await recover(launch, phrase)

  await expect(page.getByRole('button', { name: 'Alice' })).toBeVisible()
  await page.getByText('clinic', { exact: true }).click()
  await expect(page.getByText('first visit', { exact: true })).toBeVisible()
  await expect(page.getByText('second visit', { exact: true })).toBeVisible()
})

test('after recovery a message written on either app shows on the other', async ({ launch }) => {
  const first = await alice(launch)
  const second = await recover(launch, first.phrase)

  await expect(second.page.getByText('clinic', { exact: true })).toBeVisible()
  await second.page.getByText('clinic', { exact: true }).click()
  await expect(second.page.getByText('second visit', { exact: true })).toBeVisible()
  await first.page.getByText('clinic', { exact: true }).click()

  await send(second.page, 'from the recovered app')
  await expect(first.page.getByText('from the recovered app', { exact: true })).toBeVisible()

  await send(first.page, 'from the first app')
  await expect(second.page.getByText('from the first app', { exact: true })).toBeVisible()
})

test('twelve words that are not her phrase wait for a device of theirs, and Cancel leaves no profile behind', async ({
  launch
}) => {
  const { phrase } = await alice(launch)
  const other =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  expect(other).not.toBe(phrase)
  const { page, storage, close } = await recover(launch, other)

  await expect(page.getByText('Looking for your other device')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByPlaceholder('Your name')).toBeVisible()
  await close()

  const again = await launch('recovered', { storage })
  await expect(again.page.getByPlaceholder('Your name')).toBeVisible()
})

test('an eleven-word phrase shows an error', async ({ launch }) => {
  const { phrase } = await alice(launch)
  const { page } = await recover(launch, eleven(phrase))

  await expect(page.getByText(/BIP-39 mnemonic/)).toBeVisible()
})

test('a wrong phrase leaves no profile behind', async ({ launch }) => {
  const { phrase } = await alice(launch)
  const { page, storage, close } = await recover(launch, eleven(phrase))
  await expect(page.getByText(/BIP-39 mnemonic/)).toBeVisible()
  await close()

  const again = await launch('recovered', { storage })
  const setup = again.page.getByPlaceholder('Your name')
  await expect(setup.or(again.page.getByPlaceholder('Room name'))).toBeVisible()
  expect(await setup.count()).toBe(1)
})

function eleven(phrase) {
  return phrase.split(' ').slice(0, 11).join(' ')
}
