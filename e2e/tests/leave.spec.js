import { test, expect } from '../fixtures.js'

async function signUp(launch, name) {
  const app = await launch(name.toLowerCase())
  await app.page.getByPlaceholder('Your name').fill(name)
  await app.page.getByRole('button', { name: 'Continue' }).click()
  await expect(app.page.getByPlaceholder('Room name')).toBeVisible()
  return app
}

async function create(page, name) {
  await page.getByPlaceholder('Room name').fill(name)
  await page.getByRole('button', { name: 'New' }).click()
  await expect(page.getByPlaceholder('Message...')).toBeVisible()
}

async function invite(page) {
  await page.getByRole('button', { name: 'Invite' }).click()
  const copy = page.getByRole('button', { name: 'Copy' })
  await expect(copy).toBeVisible()
  return copy.locator('xpath=preceding-sibling::span').textContent()
}

async function join(page, code) {
  await page.getByPlaceholder('Invite code').fill(code)
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder('Message...')).toBeVisible()
}

async function send(page, text) {
  await page.getByPlaceholder('Message...').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(text, { exact: true })).toBeVisible()
}

async function back(page) {
  await page.getByRole('button', { name: '←' }).click()
  await expect(page.getByPlaceholder('Room name')).toBeVisible()
}

// Bob in Alice's room "clinic", with a room of his own so his list is known to have loaded
async function joined(launch) {
  const alice = await signUp(launch, 'Alice')
  const bob = await signUp(launch, 'Bob')
  await create(bob.page, 'notes')
  await back(bob.page)
  await create(alice.page, 'clinic')
  await join(bob.page, await invite(alice.page))
  await expect(alice.page.getByText('2 members')).toBeVisible()
  return { alice, bob }
}

test('a member who leaves a room is back on his list and the room is not in it', async ({
  launch
}) => {
  const { bob } = await joined(launch)

  await bob.page.getByRole('button', { name: 'Leave' }).click()
  await expect(bob.page.getByPlaceholder('Room name')).toBeVisible()
  await expect(bob.page.getByText('notes', { exact: true })).toBeVisible()
  await expect(bob.page.getByText('clinic', { exact: true })).toHaveCount(0)
})

test('a member who leaves is gone from the members of the room', async ({ launch }) => {
  const { alice, bob } = await joined(launch)

  await bob.page.getByRole('button', { name: 'Leave' }).click()
  await expect(bob.page.getByPlaceholder('Room name')).toBeVisible()
  await expect(alice.page.getByText('1 members')).toBeVisible()
})

test('a member who left joins again with a new invite and finds the room and its old messages', async ({
  launch
}) => {
  const { alice, bob } = await joined(launch)
  await send(alice.page, 'before he left')
  await expect(bob.page.getByText('before he left', { exact: true })).toBeVisible()

  await bob.page.getByRole('button', { name: 'Leave' }).click()
  await expect(alice.page.getByText('1 members')).toBeVisible()

  await back(alice.page)
  await alice.page.getByText('clinic', { exact: true }).click()
  await join(bob.page, await invite(alice.page))
  await expect(bob.page.getByText('before he left', { exact: true })).toBeVisible()
  await expect(alice.page.getByText('2 members')).toBeVisible()

  await back(bob.page)
  await expect(bob.page.getByText('clinic', { exact: true })).toBeVisible()
})

test('the last owner of a room others are in sees an error on leaving and stays in', async ({
  launch
}) => {
  const { alice } = await joined(launch)

  await alice.page.getByRole('button', { name: 'Leave' }).click()
  await expect(alice.page.getByText(/last owner cannot leave/)).toBeVisible()
  await expect(alice.page.getByPlaceholder('Message...')).toBeVisible()
  await expect(alice.page.getByText('2 members')).toBeVisible()

  await back(alice.page)
  await expect(alice.page.getByText('clinic', { exact: true })).toBeVisible()
})
