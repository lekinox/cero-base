import { test, expect } from '../fixtures.js'

// an invite or a request id: one long lowercase word, never a device row
const token = /^[a-z0-9]{40,}$/

async function profile(page) {
  await page.getByPlaceholder('Your name').fill('Alice')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByPlaceholder('Room name')).toBeVisible()
}

async function settings(page) {
  await page.getByRole('button', { name: /Alice/ }).click()
  await expect(page.getByText('(current)')).toBeVisible()
}

async function back(page) {
  await page.getByRole('button', { name: '←' }).click()
  await expect(page.getByPlaceholder('Room name')).toBeVisible()
}

async function create(page, room) {
  await page.getByPlaceholder('Room name').fill(room)
  await page.getByRole('button', { name: 'New' }).click()
  await expect(page.getByPlaceholder('Message...')).toBeVisible()
}

async function open(page, room) {
  await page.getByText(room, { exact: true }).click()
  await expect(page.getByPlaceholder('Message...')).toBeVisible()
}

async function send(page, text) {
  await page.getByPlaceholder('Message...').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(text, { exact: true })).toBeVisible()
}

// from Settings on an open device, link a new one with a device invite and approve it there
async function link(launch, from, name) {
  await from.page.getByRole('button', { name: 'Show Device Invite' }).click()
  const invite = await from.page.getByText(token).textContent()

  const device = await launch(name)
  await device.page.getByPlaceholder('Device invite from your other device').fill(invite)
  await device.page.getByRole('button', { name: 'Link Device' }).click()
  await expect(device.page.getByText('Approve this device on your other device')).toBeVisible()
  const request = await device.page.getByText(token).textContent()

  await expect(from.page.getByText(request, { exact: true })).toBeVisible()
  await from.page.getByRole('button', { name: 'Approve' }).click()
  await expect(device.page.getByPlaceholder('Room name')).toBeVisible()
  return device
}

// absent on every look for ten seconds after the writer shows it
async function absent(page, text) {
  const shown = Date.now()
  await expect
    .poll(
      async () => {
        if (await page.getByText(text, { exact: true }).count()) return 'shown'
        return Date.now() - shown > 10_000 ? 'absent' : 'waiting'
      },
      { timeout: 20_000 }
    )
    .toBe('absent')
}

// Alice's phone links her laptop and has two rooms: clinic, open on both, and lab, never opened on the laptop
async function lost(launch) {
  const phone = await launch('phone')
  await profile(phone.page)
  await create(phone.page, 'clinic')
  await send(phone.page, 'from the phone')
  await back(phone.page)

  await settings(phone.page)
  const laptop = await link(launch, phone, 'laptop')
  await back(phone.page)
  await create(phone.page, 'lab')
  await send(phone.page, 'lab from the phone')
  await back(phone.page)
  await open(phone.page, 'clinic')

  await expect(laptop.page.getByText('lab', { exact: true })).toBeVisible()
  await open(laptop.page, 'clinic')
  await expect(laptop.page.getByText('from the phone', { exact: true })).toBeVisible()
  await back(laptop.page)

  // the phone is lost: the laptop removes it
  await settings(laptop.page)
  await expect(laptop.page.getByRole('button', { name: 'Remove' })).toHaveCount(1)
  await laptop.page.getByRole('button', { name: 'Remove' }).click()
  await expect(laptop.page.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  return { phone, laptop }
}

test('after the laptop removes the lost phone it reads and writes in a room it had open', async ({
  launch
}) => {
  const { laptop } = await lost(launch)
  await back(laptop.page)
  await open(laptop.page, 'clinic')
  await expect(laptop.page.getByText('from the phone', { exact: true })).toBeVisible()
  await send(laptop.page, 'after the removal')
})

test('the removed phone does not receive what the laptop writes after in a room it has open', async ({
  launch
}) => {
  // fails today: the removed phone, with the room open, still shows what the laptop writes there after
  test.fail()
  const { phone, laptop } = await lost(launch)
  await back(laptop.page)
  await open(laptop.page, 'clinic')
  await send(laptop.page, 'after the removal')
  await absent(phone.page, 'after the removal')
})

test('after the laptop removes the lost phone it opens a room the phone made and it never opened', async ({
  launch
}) => {
  const { laptop } = await lost(launch)
  await back(laptop.page)
  await open(laptop.page, 'lab')
  await expect(laptop.page.getByText('lab from the phone', { exact: true })).toBeVisible()
  await send(laptop.page, 'lab from the laptop')
})

test('after the laptop removes the lost phone it links a tablet, which reads both rooms', async ({
  launch
}) => {
  // fails today: the tablet waits on its request for good after the laptop approves it; with no removal it links
  test.fail()
  const { laptop } = await lost(launch)
  await back(laptop.page)
  await open(laptop.page, 'clinic')
  await send(laptop.page, 'after the removal')
  await back(laptop.page)

  await settings(laptop.page)
  const tablet = await link(launch, laptop, 'tablet')
  await open(tablet.page, 'clinic')
  await expect(tablet.page.getByText('from the phone', { exact: true })).toBeVisible()
  await expect(tablet.page.getByText('after the removal', { exact: true })).toBeVisible()
  await back(tablet.page)
  await open(tablet.page, 'lab')
  await expect(tablet.page.getByText('lab from the phone', { exact: true })).toBeVisible()
})

// the phone still lists the laptop with Remove: pressing it is refused, NOT_WRITABLE, and nothing changes
test('the removed phone shows it was removed and its Remove of the laptop is refused', async ({
  launch
}) => {
  const { phone, laptop } = await lost(launch)
  const errors = []
  phone.page.on('pageerror', (err) => errors.push(err.message))
  await back(phone.page)
  await phone.page.getByRole('button', { name: /Alice/ }).click()
  await expect(phone.page.getByText('This device was removed from your profile')).toBeVisible()
  await expect(phone.page.getByText('(current)')).toHaveCount(0)

  await phone.page.getByRole('button', { name: 'Remove' }).click()
  await expect.poll(() => errors).toContainEqual(expect.stringMatching(/^NOT_WRITABLE/))
  await expect(phone.page.getByRole('button', { name: 'Remove' })).toHaveCount(1)
  await expect(laptop.page.getByText('(current)')).toBeVisible()
  await back(laptop.page)
  await open(laptop.page, 'clinic')
  await send(laptop.page, 'still here')
})
