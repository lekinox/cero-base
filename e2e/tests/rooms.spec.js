import { test, expect } from '../fixtures.js'

test('a new profile creates a room and finds it in its room list', async ({ launch }) => {
  const { page } = await launch('alice')
  await page.getByPlaceholder('Your name').fill('Alice')
  await page.getByRole('button', { name: 'Continue' }).click()

  await page.getByPlaceholder('Room name').fill('clinic')
  await page.getByRole('button', { name: 'New' }).click()
  await expect(page.getByPlaceholder('Message...')).toBeVisible()

  await page.getByRole('button', { name: '←' }).click()
  await expect(page.getByText('clinic', { exact: true })).toBeVisible()
})
