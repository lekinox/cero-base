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
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  const copy = page.getByRole('button', { name: 'Copy' })
  await expect(copy).toBeVisible()
  return copy.locator('xpath=preceding-sibling::span').textContent()
}

async function join(page, code) {
  await page.getByPlaceholder('Invite code').fill(code)
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(page.getByPlaceholder('Message...')).toBeVisible()
}

async function send(page, text) {
  await page.getByPlaceholder('Message...').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(text, { exact: true })).toBeVisible()
}

// the rooms on the list, apart from the joins waiting or ended
function rooms(page) {
  return page.getByRole('region', { name: 'Rooms' })
}

async function enter(page, room) {
  await rooms(page).getByText(room, { exact: true }).click()
  await expect(page.getByPlaceholder('Message...')).toBeVisible()
}

async function back(page) {
  await page.getByRole('button', { name: '←' }).click()
  await expect(page.getByPlaceholder('Room name')).toBeVisible()
}

// opens the room's people panel from its "N members" button, once
async function people(page) {
  const members = page.getByRole('region', { name: 'Members' })
  if (!(await members.count())) await page.getByRole('button', { name: /members$/ }).click()
  await expect(members).toBeVisible()
}

function addable(page) {
  return page.getByRole('region', { name: 'Add from another room' })
}

function seated(page) {
  return page
    .getByRole('region', { name: 'Invites' })
    .getByText('seat for Ben, member', { exact: true })
}

// fails if the locator shows up at any point in the window
async function absent(locator, window = 10_000) {
  const until = Date.now() + window
  await expect
    .poll(async () => {
      if (await locator.count()) return 'shown'
      return Date.now() > until ? 'absent' : 'watching'
    })
    .toBe('absent')
}

// Ana makes "general" and lets Ben in with a code: she ends on her list, he inside the room
async function share(ana, ben) {
  await create(ana.page, 'general')
  await join(ben.page, await invite(ana.page))
  await expect(ana.page.getByText('2 members', { exact: true })).toBeVisible()
  await back(ana.page)
}

// Ana makes "plans" and, from its people panel, adds Ben from "general": she stays inside "plans"
async function add(page) {
  await create(page, 'plans')
  await people(page)
  await expect(addable(page).getByText('Ben · general', { exact: true })).toBeVisible()
  await addable(page).getByRole('button', { name: 'Add' }).click()
  await expect(seated(page)).toBeVisible()
  await expect(addable(page)).toHaveCount(0)
}

// Ben signs up on his phone and links his laptop to it from Settings; both end on their list
async function linked(launch) {
  const phone = await signUp(launch, 'Ben', 'phone')
  await phone.page.getByRole('button', { name: /Ben/ }).click()
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
  await phone.page.getByRole('button', { name: '←' }).click()
  await expect(phone.page.getByPlaceholder('Room name')).toBeVisible()
  return { phone, laptop }
}

test('a person added from a room both are in finds the new room on his list with no code, and they write to each other in it', async ({
  launch
}) => {
  const ana = await signUp(launch, 'Ana')
  const ben = await signUp(launch, 'Ben')
  await share(ana, ben)
  // "general" stays open on his device once he is back on his list: the app closes no room it entered
  await back(ben.page)

  await add(ana.page)
  await expect(rooms(ben.page).getByText('plans', { exact: true })).toBeVisible()
  await expect(ana.page.getByText('2 members', { exact: true })).toBeVisible()

  await enter(ben.page, 'plans')
  await send(ana.page, 'welcome to plans')
  await expect(ben.page.getByText('welcome to plans', { exact: true })).toBeVisible()
  await send(ben.page, 'glad to be in')
  await expect(ana.page.getByText('glad to be in', { exact: true })).toBeVisible()
})

test('a person added while his app is closed finds the room once he launches again and opens the room they share', async ({
  launch
}) => {
  const ana = await signUp(launch, 'Ana')
  const ben = await signUp(launch, 'Ben')
  await share(ana, ben)
  await ben.close()

  await add(ana.page)

  const again = await launch('ben', { storage: ben.storage })
  await enter(again.page, 'general')
  await back(again.page)
  await expect(rooms(again.page).getByText('plans', { exact: true })).toBeVisible()
  await enter(again.page, 'plans')
  await send(again.page, 'in after a restart')
  await expect(ana.page.getByText('in after a restart', { exact: true })).toBeVisible()
})

test('a room a person is added to shows on his linked laptop too, with what is written in it', async ({
  launch
}) => {
  const ana = await signUp(launch, 'Ana')
  const { phone, laptop } = await linked(launch)
  await share(ana, phone)
  await back(phone.page)
  await expect(rooms(laptop.page).getByText('general', { exact: true })).toBeVisible()

  await add(ana.page)
  await send(ana.page, 'for both devices')
  for (const { page } of [phone, laptop]) {
    await expect(rooms(page).getByText('plans', { exact: true })).toBeVisible()
  }
  await enter(laptop.page, 'plans')
  await expect(laptop.page.getByText('for both devices', { exact: true })).toBeVisible()
})

test('a seat revoked while his app is closed never puts the room on his list, once he opens the room they share either', async ({
  launch
}) => {
  const ana = await signUp(launch, 'Ana')
  const ben = await signUp(launch, 'Ben')
  await share(ana, ben)
  await ben.close()

  await add(ana.page)
  await ana.page
    .getByRole('region', { name: 'Invites' })
    .getByRole('button', { name: 'Revoke' })
    .click()
  await expect(seated(ana.page)).toHaveCount(0)
  await expect(addable(ana.page).getByText('Ben · general', { exact: true })).toBeVisible()
  // written after the seat: once Ben reads it, his device has read the seat before it
  await back(ana.page)
  await enter(ana.page, 'general')
  await send(ana.page, 'after the revoke')

  const again = await launch('ben', { storage: ben.storage })
  await enter(again.page, 'general')
  await expect(again.page.getByText('after the revoke', { exact: true })).toBeVisible()
  await back(again.page)
  await absent(rooms(again.page).getByText('plans', { exact: true }))
})
