import { test, expect } from '../fixtures.js'

// Alice makes a profile and a room with a message on her phone, then links her laptop to it from Settings
async function linked(launch) {
  const phone = await launch('phone')
  await phone.page.getByPlaceholder('Your name').fill('Alice')
  await phone.page.getByRole('button', { name: 'Continue' }).click()
  await phone.page.getByPlaceholder('Room name').fill('clinic')
  await phone.page.getByRole('button', { name: 'New' }).click()
  await send(phone.page, 'from the phone')
  await phone.page.getByRole('button', { name: '←' }).click()

  await phone.page.getByRole('button', { name: /Alice/ }).click()
  await phone.page.getByRole('button', { name: 'Show Device Invite' }).click()
  const section = phone.page.getByText('Link a Device', { exact: true }).locator('..')
  const invite = await section.locator('.font-mono').first().textContent()

  const laptop = await launch('laptop')
  await laptop.page.getByPlaceholder('Device invite from your other device').fill(invite)
  await laptop.page.getByRole('button', { name: 'Link Device' }).click()
  await expect(laptop.page.getByText('Approve this device on your other device')).toBeVisible()
  const request = await laptop.page.locator('.font-mono').textContent()

  await expect(phone.page.getByText(request, { exact: true })).toBeVisible()
  await phone.page.getByRole('button', { name: 'Approve' }).click()
  await expect(laptop.page.getByPlaceholder('Room name')).toBeVisible()
  await phone.page.getByRole('button', { name: '←' }).click()
  return { phone, laptop }
}

async function send(page, text) {
  await page.getByPlaceholder('Message...').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(text, { exact: true })).toBeVisible()
}

async function open(page, room) {
  await page.getByText(room, { exact: true }).click()
  await expect(page.getByPlaceholder('Message...')).toBeVisible()
}

test('a linked laptop shows the profile name, its room and the message in it', async ({
  launch
}) => {
  const { laptop } = await linked(launch)
  await expect(laptop.page.getByRole('button', { name: /Alice/ })).toBeVisible()
  await open(laptop.page, 'clinic')
  await expect(laptop.page.getByText('from the phone', { exact: true })).toBeVisible()
})

test('a message written on either linked device shows on the other', async ({ launch }) => {
  const { phone, laptop } = await linked(launch)
  await open(phone.page, 'clinic')
  await open(laptop.page, 'clinic')

  await send(laptop.page, 'from the laptop')
  await expect(phone.page.getByText('from the laptop', { exact: true })).toBeVisible()

  await send(phone.page, 'again from the phone')
  await expect(laptop.page.getByText('again from the phone', { exact: true })).toBeVisible()
})

test('a room the linked laptop creates shows in the phone room list', async ({ launch }) => {
  const { phone, laptop } = await linked(launch)
  await laptop.page.getByPlaceholder('Room name').fill('lab')
  await laptop.page.getByRole('button', { name: 'New' }).click()
  await expect(laptop.page.getByPlaceholder('Message...')).toBeVisible()

  await expect(phone.page.getByText('lab', { exact: true })).toBeVisible()
})

test('both linked devices are listed in Settings on each of them', async ({ launch }) => {
  const { phone, laptop } = await linked(launch)
  for (const { page } of [phone, laptop]) {
    await page.getByRole('button', { name: /Alice/ }).click()
    const devices = page.getByText('Devices', { exact: true }).locator('..').locator('.font-mono')
    await expect(devices).toHaveCount(2)
    await expect(page.getByText('(current)')).toHaveCount(1)
  }
})
