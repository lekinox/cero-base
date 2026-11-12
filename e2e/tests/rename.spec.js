import { test, expect } from '../fixtures.js'

async function signUp(launch, name, folder = name.toLowerCase()) {
  const app = await launch(folder)
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

async function enter(page, room) {
  await page.getByText(room, { exact: true }).click()
  await expect(page.getByPlaceholder('Message...')).toBeVisible()
}

async function back(page) {
  await page.getByRole('button', { name: '←' }).click()
  await expect(page.getByPlaceholder('Room name')).toBeVisible()
}

async function members(page) {
  await page.getByRole('button', { name: /members$/ }).click()
  return page.getByRole('listitem')
}

// the phone shows a device invite in Settings, the laptop links with it, the phone approves and stays in Settings
async function link(launch, phone) {
  await phone.page.getByRole('button', { name: /Alice/ }).click()
  await phone.page.getByRole('button', { name: 'Show Device Invite' }).click()
  const section = phone.page.getByText('Link a Device', { exact: true }).locator('..')
  const code = await section.locator('.font-mono').first().textContent()

  const laptop = await launch('laptop')
  await laptop.page.getByPlaceholder('Device invite from your other device').fill(code)
  await laptop.page.getByRole('button', { name: 'Link Device' }).click()
  await expect(laptop.page.getByText('Approve this device on your other device')).toBeVisible()
  const request = await laptop.page.locator('.font-mono').textContent()

  await expect(phone.page.getByText(request, { exact: true })).toBeVisible()
  await phone.page.getByRole('button', { name: 'Approve' }).click()
  await expect(laptop.page.getByPlaceholder('Room name')).toBeVisible()
  return laptop
}

// what Bob reads in "clinic": a writer name on each of Alice's two runs of messages, none of them the old one
async function bobReads(page) {
  await expect(page.getByText('new from alice', { exact: true })).toBeVisible()
  await expect(page.getByText('Alice Cruz', { exact: true })).toHaveCount(2)
  await expect(page.getByText('Alice', { exact: true })).toHaveCount(0)
  const list = await members(page)
  await expect(list.filter({ hasText: 'Alice Cruz' })).toHaveCount(1)
  await expect(list.getByText('Alice', { exact: true })).toHaveCount(0)
}

async function carolReads(page) {
  await expect(page.getByText('in the lab', { exact: true })).toBeVisible()
  await expect(page.getByText('Alice Cruz', { exact: true })).toBeVisible()
  await expect(page.getByText('Alice', { exact: true })).toHaveCount(0)
}

async function showsName(page) {
  await expect(page.getByRole('button', { name: /Alice Cruz/ })).toBeVisible()
  await expect(page.getByText('Alice', { exact: true })).toHaveCount(0)
}

test('a profile rename reaches her other device, a room open with Bob and a room she left that Carol opens later', async ({
  launch
}) => {
  const phone = await signUp(launch, 'Alice', 'phone')
  const bob = await signUp(launch, 'Bob')
  const carol = await signUp(launch, 'Carol')

  await create(phone.page, 'clinic')
  await join(bob.page, await invite(phone.page))
  await send(phone.page, 'old from alice')
  await expect(bob.page.getByText('old from alice', { exact: true })).toBeVisible()
  await send(bob.page, 'from bob')
  await expect(phone.page.getByText('from bob', { exact: true })).toBeVisible()
  await back(phone.page)

  await create(phone.page, 'lab')
  await join(carol.page, await invite(phone.page))
  await send(phone.page, 'in the lab')
  await expect(carol.page.getByText('in the lab', { exact: true })).toBeVisible()
  await expect(carol.page.getByText('Alice', { exact: true })).toBeVisible()
  await back(phone.page)
  await carol.close()

  const laptop = await link(launch, phone)
  const field = phone.page.getByPlaceholder('Your name')
  await field.fill('Alice Cruz')
  await field.blur()
  await back(phone.page)
  await showsName(phone.page)
  await showsName(laptop.page)

  await enter(phone.page, 'clinic')
  await send(phone.page, 'new from alice')
  await bobReads(bob.page)

  const again = await launch('carol', { storage: carol.storage })
  await enter(again.page, 'lab')
  await carolReads(again.page)

  for (const app of [phone, laptop, bob, again]) await app.close()

  // each opens alone, so what it shows comes from its own folder
  for (const { name, storage } of [phone, laptop]) {
    const { page, close } = await launch(name, { storage })
    await showsName(page)
    await close()
  }
  const bobAgain = await launch('bob', { storage: bob.storage })
  await enter(bobAgain.page, 'clinic')
  await bobReads(bobAgain.page)
  await bobAgain.close()
  const carolAgain = await launch('carol', { storage: carol.storage })
  await enter(carolAgain.page, 'lab')
  await carolReads(carolAgain.page)
})

test('a room rename reaches a member with the room open and one with it closed, in the header and the list', async ({
  launch
}) => {
  const alice = await signUp(launch, 'Alice')
  const bob = await signUp(launch, 'Bob')
  const carol = await signUp(launch, 'Carol')
  await create(alice.page, 'clinic')
  await join(bob.page, await invite(alice.page))
  await back(alice.page)
  await enter(alice.page, 'clinic')
  await join(carol.page, await invite(alice.page))
  for (const { page } of [alice, bob, carol]) {
    await expect(page.getByText('3 members', { exact: true })).toBeVisible()
  }
  await back(carol.page)
  await carol.close()

  await alice.page.getByRole('button', { name: 'Rename' }).click()
  await alice.page.getByPlaceholder('New name').fill('Clinic North')
  await alice.page.getByRole('button', { name: 'Save' }).click()
  await expect(alice.page.getByText('Clinic North', { exact: true })).toBeVisible()
  await expect(alice.page.getByText('clinic', { exact: true })).toHaveCount(0)

  // Bob has the room open
  await expect(bob.page.getByText('Clinic North', { exact: true })).toBeVisible()
  await expect(bob.page.getByText('clinic', { exact: true })).toHaveCount(0)
  await back(bob.page)
  await expect(bob.page.getByText('Clinic North', { exact: true })).toBeVisible()
  await expect(bob.page.getByText('clinic', { exact: true })).toHaveCount(0)

  // Carol had it closed: her list learns the name from the room, once she opens it
  const again = await launch('carol', { storage: carol.storage })
  await again.page.getByText(/^(clinic|Clinic North)$/).click()
  await expect(again.page.getByPlaceholder('Message...')).toBeVisible()
  await expect(again.page.getByText('Clinic North', { exact: true })).toBeVisible()
  await expect(again.page.getByText('clinic', { exact: true })).toHaveCount(0)
  await back(again.page)
  await expect(again.page.getByText('Clinic North', { exact: true })).toBeVisible()
  await expect(again.page.getByText('clinic', { exact: true })).toHaveCount(0)

  await back(alice.page)
  await expect(alice.page.getByText('Clinic North', { exact: true })).toBeVisible()
  await expect(alice.page.getByText('clinic', { exact: true })).toHaveCount(0)

  for (const app of [alice, bob, again]) await app.close()

  for (const { name, storage } of [alice, bob, carol]) {
    const { page, close } = await launch(name, { storage })
    await expect(page.getByText('Clinic North', { exact: true })).toBeVisible()
    await expect(page.getByText('clinic', { exact: true })).toHaveCount(0)
    await enter(page, 'Clinic North')
    await expect(page.getByText('Clinic North', { exact: true })).toBeVisible()
    await expect(page.getByText('clinic', { exact: true })).toHaveCount(0)
    await close()
  }
})
