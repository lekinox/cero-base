import { crc32, deflateSync } from 'zlib'
import { test, expect } from '../fixtures.js'

const PHRASE = /^[a-z]+( [a-z]+){11}$/

const images = { red: png(255, 0, 0), green: png(0, 255, 0), blue: png(0, 0, 255) }

// a 1x1 PNG of one colour
function png(r, g, b) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.from([0, r, g, b]))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

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

async function settings(page, name = 'Alice') {
  await page.getByRole('button', { name }).click()
  await expect(page.getByText('Devices', { exact: true })).toBeVisible()
}

// picks an image file for the avatar, in Settings
async function pick(page, colour) {
  await page.locator('input[type=file]').setInputFiles({
    name: `${colour}.png`,
    mimeType: 'image/png',
    buffer: images[colour]
  })
}

// the phone, in Settings, shows a device invite, the laptop links with it and the phone approves
async function link(launch, phone) {
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

// Alice and Bob in her room "clinic", both with it open
async function clinic(launch) {
  const alice = await signUp(launch, 'Alice')
  const bob = await signUp(launch, 'Bob')
  await create(alice.page, 'clinic')
  await join(bob.page, await invite(alice.page))
  await expect(alice.page.getByText('2 members', { exact: true })).toBeVisible()
  return { alice, bob }
}

// the member rows of the room's people panel, opened from its "N members" button once
async function members(page) {
  const panel = page.getByRole('region', { name: 'Members' })
  if (!(await panel.count())) await page.getByRole('button', { name: /members$/ }).click()
  await expect(panel).toBeVisible()
  return panel.getByRole('listitem')
}

// her avatar on her row of the room's people panel
async function member(page) {
  const list = await members(page)
  return list.filter({ hasText: 'Alice' }).getByRole('img')
}

// her avatar where a page shows it once: Settings, the header of the room list, beside what she wrote
function avatar(page) {
  return page.getByRole('img', { name: 'Alice' })
}

// the image the one <img> shows once the page has drawn it, told by the bytes behind its url
async function shown(img) {
  const drawn = await img.evaluateAll((all) =>
    all.map((el) => el.complete && el.naturalWidth > 0 && el.currentSrc)
  )
  if (drawn.length !== 1 || !drawn[0]) return null
  const bytes = Buffer.from(await (await fetch(drawn[0])).arrayBuffer())
  return Object.keys(images).find((colour) => images[colour].equals(bytes)) ?? null
}

function shows(img, colour) {
  return expect.poll(() => shown(img)).toBe(colour)
}

test('an avatar picked in Settings shows there and in the header, and still does after a restart', async ({
  launch
}) => {
  const alice = await signUp(launch, 'Alice')
  await settings(alice.page)
  await pick(alice.page, 'red')
  await shows(avatar(alice.page), 'red')
  await back(alice.page)
  await shows(avatar(alice.page), 'red')
  await alice.close()

  const again = await launch('alice', { storage: alice.storage })
  await shows(avatar(again.page), 'red')
  await settings(again.page)
  await shows(avatar(again.page), 'red')
})

test('a member of her room sees her avatar among its people once she picks it, one who joins later sees it there and beside what she wrote, and each keeps it', async ({
  launch
}) => {
  const { alice, bob } = await clinic(launch)
  const carol = await signUp(launch, 'Carol')
  await send(alice.page, 'from alice')
  const seen = await member(bob.page)
  await expect(seen).toHaveCount(0)

  await back(alice.page)
  await settings(alice.page)
  await pick(alice.page, 'red')
  await shows(seen, 'red')

  await back(alice.page)
  await enter(alice.page, 'clinic')
  await shows(await member(alice.page), 'red')
  await join(carol.page, await invite(alice.page))
  await shows(avatar(carol.page), 'red')
  await shows(await member(carol.page), 'red')

  for (const app of [alice, bob, carol]) await app.close()

  // each opens alone, so what it shows comes from its own folder
  for (const { name, storage } of [bob, carol]) {
    const { page, close } = await launch(name, { storage })
    await enter(page, 'clinic')
    await shows(await member(page), 'red')
    await close()
  }
})

test('a new avatar takes the place of the old one for a member of her room', async ({ launch }) => {
  const { alice, bob } = await clinic(launch)
  await back(alice.page)
  await settings(alice.page)
  await pick(alice.page, 'red')
  const seen = await member(bob.page)
  await shows(seen, 'red')

  await pick(alice.page, 'green')
  await shows(avatar(alice.page), 'green')
  await shows(seen, 'green')
})

test('an avatar picked on her phone shows on the laptop she links, and one picked on the laptop shows on the phone and to a member of her room', async ({
  launch
}) => {
  const { alice: phone, bob } = await clinic(launch)
  await back(phone.page)
  await settings(phone.page)
  await pick(phone.page, 'red')
  await shows(avatar(phone.page), 'red')

  const laptop = await link(launch, phone)
  await shows(avatar(laptop.page), 'red')
  await settings(laptop.page)
  await shows(avatar(laptop.page), 'red')

  await pick(laptop.page, 'blue')
  await shows(avatar(laptop.page), 'blue')
  await shows(avatar(phone.page), 'blue')
  await back(phone.page)
  await shows(avatar(phone.page), 'blue')
  await shows(await member(bob.page), 'blue')
})

test('a fresh app given her seed phrase shows her avatar, in a room of hers too, and keeps it', async ({
  launch
}) => {
  const alice = await signUp(launch, 'Alice')
  await create(alice.page, 'clinic')
  await back(alice.page)
  await settings(alice.page)
  await pick(alice.page, 'red')
  await shows(avatar(alice.page), 'red')
  await alice.page.getByRole('button', { name: 'Show Seed' }).click()
  const phrase = await alice.page.getByText(PHRASE).textContent()

  const recovered = await launch('recovered')
  await recovered.page.getByPlaceholder('Enter your 12-word seed phrase').fill(phrase)
  await recovered.page.getByRole('button', { name: 'Use Existing Seed' }).click()
  await shows(avatar(recovered.page), 'red')
  await settings(recovered.page)
  await shows(avatar(recovered.page), 'red')
  await back(recovered.page)
  await enter(recovered.page, 'clinic')
  await shows(await member(recovered.page), 'red')

  for (const app of [alice, recovered]) await app.close()

  const { page } = await launch('recovered', { storage: recovered.storage })
  await shows(avatar(page), 'red')
  await enter(page, 'clinic')
  await shows(await member(page), 'red')
})

test('a member whose app was closed when she changed her avatar sees the new one once it is open again', async ({
  launch
}) => {
  const { alice, bob } = await clinic(launch)
  await back(alice.page)
  await settings(alice.page)
  await pick(alice.page, 'red')
  await shows(await member(bob.page), 'red')
  await bob.close()

  await pick(alice.page, 'green')
  await shows(avatar(alice.page), 'green')

  const again = await launch('bob', { storage: bob.storage })
  await enter(again.page, 'clinic')
  await shows(await member(again.page), 'green')
})

test('an avatar picked after a restart, before she opens her room again, reaches a member of it', async ({
  launch
}) => {
  const { alice, bob } = await clinic(launch)
  await alice.close()

  const again = await launch('alice', { storage: alice.storage })
  await settings(again.page)
  await pick(again.page, 'red')
  await shows(await member(bob.page), 'red')
})

test('after a member is removed, one who joins sees the avatar she had, and a new one reaches him and the member left', async ({
  launch
}) => {
  const { alice, bob } = await clinic(launch)
  const carol = await signUp(launch, 'Carol')
  const dave = await signUp(launch, 'Dave')
  await back(alice.page)
  await settings(alice.page)
  await pick(alice.page, 'red')
  await shows(await member(bob.page), 'red')
  await back(alice.page)
  await enter(alice.page, 'clinic')
  await join(carol.page, await invite(alice.page))
  await expect(alice.page.getByText('3 members', { exact: true })).toBeVisible()

  const list = await members(alice.page)
  await list.filter({ hasText: 'Carol' }).getByRole('button', { name: 'Remove' }).click()
  await expect(alice.page.getByText('2 members', { exact: true })).toBeVisible()

  await back(alice.page)
  await enter(alice.page, 'clinic')
  await join(dave.page, await invite(alice.page))
  await shows(await member(dave.page), 'red')

  await back(alice.page)
  await settings(alice.page)
  await pick(alice.page, 'green')
  await shows(await member(bob.page), 'green')
  await shows(await member(dave.page), 'green')
})

test('a reader who has an avatar shows by name among the people of the room, and sees the avatar of a member', async ({
  launch
}) => {
  const alice = await signUp(launch, 'Alice')
  const bob = await signUp(launch, 'Bob')
  await settings(alice.page)
  await pick(alice.page, 'red')
  await shows(avatar(alice.page), 'red')
  await back(alice.page)
  await settings(bob.page, 'Bob')
  await pick(bob.page, 'blue')
  await expect(bob.page.getByRole('img', { name: 'Bob' })).toBeVisible()
  await back(bob.page)

  await create(alice.page, 'clinic')
  const list = await members(alice.page)
  await alice.page.getByRole('combobox', { name: 'Role' }).selectOption('reader')
  await alice.page.getByRole('button', { name: 'Create code' }).click()
  const code = alice.page.getByRole('textbox', { name: 'Code' })
  await expect(code).toBeVisible()
  await join(bob.page, await code.inputValue())

  await expect(list.filter({ hasText: 'Bob · reader' })).toHaveCount(1)
  await shows(await member(bob.page), 'red')
})
