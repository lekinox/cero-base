import { test, expect } from '../fixtures.js'

async function start(launch, name) {
  const opened = await launch(name.toLowerCase())
  await opened.page.getByPlaceholder('Your name').fill(name)
  await opened.page.getByRole('button', { name: 'Continue' }).click()
  await expect(opened.page.getByPlaceholder('Room name')).toBeVisible()
  return opened
}

async function create(page, name, message) {
  await page.getByPlaceholder('Room name').fill(name)
  await page.getByRole('button', { name: 'New' }).click()
  await expect(page.getByPlaceholder('Message...')).toBeVisible()
  if (message) {
    await page.getByPlaceholder('Message...').fill(message)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText(message, { exact: true })).toBeVisible()
  }
  await back(page)
}

async function back(page) {
  await page.getByRole('button', { name: '←' }).click()
  await expect(page.getByPlaceholder('Room name')).toBeVisible()
}

test('each room a person makes shows in the list with its name', async ({ launch }) => {
  const { page } = await start(launch, 'Alice')
  const names = ['clinic', 'pharmacy', 'front desk']
  for (const name of names) await create(page, name)

  for (const name of names) await expect(page.getByText(name, { exact: true })).toHaveCount(1)
})

test('a room opened from the list shows that room, and back returns to the list', async ({
  launch
}) => {
  const { page } = await start(launch, 'Alice')
  await create(page, 'clinic', 'in the clinic')
  await create(page, 'pharmacy', 'in the pharmacy')

  await page.getByText('clinic', { exact: true }).click()
  await expect(page.getByText('in the clinic', { exact: true })).toBeVisible()
  await expect(page.getByText('in the pharmacy', { exact: true })).toHaveCount(0)
  await back(page)

  await page.getByText('pharmacy', { exact: true }).click()
  await expect(page.getByText('in the pharmacy', { exact: true })).toBeVisible()
  await expect(page.getByText('in the clinic', { exact: true })).toHaveCount(0)
  await back(page)
  await expect(page.getByText('clinic', { exact: true })).toBeVisible()
})

test('the room list and its rooms survive a restart', async ({ launch }) => {
  const alice = await start(launch, 'Alice')
  await create(alice.page, 'clinic', 'in the clinic')
  await create(alice.page, 'pharmacy', 'in the pharmacy')
  await alice.close()

  const { page } = await launch('alice', { storage: alice.storage })
  await expect(page.getByText('clinic', { exact: true })).toBeVisible()
  await expect(page.getByText('pharmacy', { exact: true })).toBeVisible()

  await page.getByText('clinic', { exact: true }).click()
  await expect(page.getByText('in the clinic', { exact: true })).toBeVisible()
  await back(page)
  await page.getByText('pharmacy', { exact: true }).click()
  await expect(page.getByText('in the pharmacy', { exact: true })).toBeVisible()
})

test('a room name with spaces and non-ASCII characters shows as typed', async ({ launch }) => {
  const { page } = await start(launch, 'Alice')
  const name = 'Sala de espera — niños, Ärzte 診療所 🩺'
  await create(page, name)

  await expect(page.getByText(name, { exact: true })).toBeVisible()
})

test('a code that is not an invite shows an error and adds no room', async ({ launch }) => {
  const { page } = await start(launch, 'Bob')
  await page.getByPlaceholder('Invite code').fill('not-an-invite-at-all')
  await page.getByRole('button', { name: 'Join' }).click()

  await expect(page.getByText(/not an invite/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Join' })).toBeEnabled()
  await expect(page.getByText('Rooms', { exact: true })).toHaveCount(0)
})

test('a room joined by invite shows once in the list, also when joined twice with the same code', async ({
  launch
}) => {
  const alice = await start(launch, 'Alice')
  await alice.page.getByPlaceholder('Room name').fill('clinic')
  await alice.page.getByRole('button', { name: 'New' }).click()
  await alice.page.getByRole('button', { name: 'Invite' }).click()
  const copy = alice.page.getByRole('button', { name: 'Copy' })
  await expect(copy).toBeVisible()
  const invite = (await copy.locator('..').locator('span').textContent()).trim()

  const bob = await start(launch, 'Bob')
  await bob.page.getByPlaceholder('Invite code').fill(invite)
  await bob.page.getByRole('button', { name: 'Join' }).click()
  await expect(bob.page.getByText('2 members')).toBeVisible()
  await back(bob.page)
  await expect(bob.page.getByText('clinic', { exact: true })).toHaveCount(1)

  await bob.page.getByPlaceholder('Invite code').fill(invite)
  await bob.page.getByRole('button', { name: 'Join' }).click()
  await expect(bob.page.getByPlaceholder('Message...')).toBeVisible()
  await back(bob.page)
  await expect(bob.page.getByText('clinic', { exact: true })).toHaveCount(1)
  await expect(bob.page.getByText(/^[0-9a-z]{12}\.\.\.$/)).toHaveCount(1)
})
