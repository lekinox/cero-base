import os from 'os'
import { test, expect } from '../fixtures.js'

// an invite or a request id: one long word
const token = /^[a-z0-9]{40,}$/
// every device of the example is named after the machine it runs on
const host = os.hostname()

// Alice makes a profile on her phone, then links her laptop to it from Settings
async function linked(launch) {
  const phone = await launch('phone')
  await profile(phone.page)
  await settings(phone.page)
  await phone.page.getByRole('button', { name: 'Show Device Invite' }).click()
  const invite = await phone.page.getByText(token).textContent()

  const laptop = await launch('laptop')
  await laptop.page.getByPlaceholder('Device invite from your other device').fill(invite)
  await laptop.page.getByRole('button', { name: 'Link Device' }).click()
  await expect(laptop.page.getByText('Approve this device on your other device')).toBeVisible()
  const request = await laptop.page.getByText(token).textContent()

  await expect(phone.page.getByText(request, { exact: true })).toBeVisible()
  await phone.page.getByRole('button', { name: 'Approve' }).click()
  await expect(laptop.page.getByPlaceholder('Room name')).toBeVisible()
  return { phone, laptop }
}

async function profile(page) {
  await page.getByPlaceholder('Your name').fill('Alice')
  await expect(page.getByPlaceholder('Your name')).toHaveValue('Alice')
  await page.getByRole('button', { name: 'Continue' }).click()
}

async function settings(page) {
  await page.getByRole('button', { name: /Alice/ }).click()
  await expect(page.getByText('(current)')).toBeVisible()
}

// the name field on this device's row, or on the other device's, the row with a Remove button
function field(page, other = false) {
  const mark = other ? page.getByRole('button', { name: 'Remove' }) : page.getByText('(current)')
  return page
    .locator('div')
    .filter({ has: mark })
    .filter({ has: page.getByPlaceholder('Device name') })
    .last()
    .getByPlaceholder('Device name')
}

async function rename(page, name, other = false) {
  await field(page, other).fill(name)
  await field(page, other).press('Tab')
}

async function restart(launch, device) {
  await device.close()
  const again = await launch(device.name, { storage: device.storage })
  await settings(again.page)
  return again
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

test('a device alone on its profile has no Remove button', async ({ launch }) => {
  const { page } = await launch('phone')
  await profile(page)
  await settings(page)
  await expect(page.getByPlaceholder('Device name')).toHaveValue(host)
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0)
})

test('each linked device shows one Remove button, beside the other device', async ({ launch }) => {
  const { phone, laptop } = await linked(launch)
  await settings(laptop.page)
  for (const { page } of [phone, laptop]) {
    await expect(field(page, true)).toHaveValue(host)
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(1)
    await expect(page.getByPlaceholder('Device name')).toHaveCount(2)
  }
})

test('renaming this device shows the new name on both devices, and after a restart', async ({
  launch
}) => {
  let { phone, laptop } = await linked(launch)
  await settings(laptop.page)

  await rename(phone.page, 'Alice phone')
  await expect(field(laptop.page, true)).toHaveValue('Alice phone')

  phone = await restart(launch, phone)
  await expect(field(phone.page)).toHaveValue('Alice phone')
  laptop = await restart(launch, laptop)
  await expect(field(laptop.page, true)).toHaveValue('Alice phone')
})

test('renaming the other device, on it, shows the new name on both devices, and after a restart', async ({
  launch
}) => {
  let { phone, laptop } = await linked(launch)
  await settings(laptop.page)

  await rename(laptop.page, 'Alice laptop')
  await expect(field(phone.page, true)).toHaveValue('Alice laptop')

  laptop = await restart(launch, laptop)
  await expect(field(laptop.page)).toHaveValue('Alice laptop')
  phone = await restart(launch, phone)
  await expect(field(phone.page, true)).toHaveValue('Alice laptop')
})

test('renaming the laptop from the phone shows the new name on both devices, and after a restart', async ({
  launch
}) => {
  let { phone, laptop } = await linked(launch)
  await settings(laptop.page)

  await rename(phone.page, 'Alice laptop', true)
  await expect(field(laptop.page)).toHaveValue('Alice laptop')
  await expect(field(phone.page, true)).toHaveValue('Alice laptop')

  laptop = await restart(launch, laptop)
  await expect(field(laptop.page)).toHaveValue('Alice laptop')
  phone = await restart(launch, phone)
  await expect(field(phone.page, true)).toHaveValue('Alice laptop')
})

test('removing the other device takes it out of the list on both devices', async ({ launch }) => {
  const { phone, laptop } = await linked(launch)
  await settings(laptop.page)
  await expect(phone.page.getByPlaceholder('Device name')).toHaveCount(2)

  await phone.page.getByRole('button', { name: 'Remove' }).click()
  await expect(phone.page.getByPlaceholder('Device name')).toHaveCount(1)
  await expect(phone.page.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  await expect(laptop.page.getByText('(current)')).toHaveCount(0)
})

test('a removed device does not receive what Alice writes in a room after', async ({ launch }) => {
  const { phone, laptop } = await linked(launch)
  await phone.page.getByRole('button', { name: '←' }).click()
  await phone.page.getByPlaceholder('Room name').fill('clinic')
  await phone.page.getByRole('button', { name: 'New' }).click()
  await send(phone.page, 'before the removal')
  await open(laptop.page, 'clinic')
  await expect(laptop.page.getByText('before the removal', { exact: true })).toBeVisible()

  await phone.page.getByRole('button', { name: '←' }).click()
  await settings(phone.page)
  await phone.page.getByRole('button', { name: 'Remove' }).click()
  await expect(phone.page.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  await phone.page.getByRole('button', { name: '←' }).click()
  await open(phone.page, 'clinic')
  await send(phone.page, 'after the removal')

  // absent on every look for ten seconds after the phone shows it
  const shown = Date.now()
  await expect
    .poll(
      async () => {
        const seen = await laptop.page.getByText('after the removal', { exact: true }).count()
        if (seen) return 'shown'
        return Date.now() - shown > 10_000 ? 'absent' : 'waiting'
      },
      { timeout: 20_000 }
    )
    .toBe('absent')
  await expect(laptop.page.getByText('before the removal', { exact: true })).toBeVisible()
})
