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

async function back(page) {
  await page.getByRole('button', { name: '←' }).click()
  await expect(page.getByPlaceholder('Room name')).toBeVisible()
}

async function people(page) {
  await page.getByRole('button', { name: 'People' }).click()
  await expect(page.getByRole('region', { name: 'Members' })).toBeVisible()
}

// an invite whose joins wait for a member to accept them, valid for ttl when given
async function approval(page, ttl) {
  await people(page)
  if (ttl) await page.getByPlaceholder('Expires in, e.g. 10s').fill(ttl)
  await page.getByRole('button', { name: 'Invite with approval' }).click()
  const code = page.getByRole('textbox', { name: 'Approval invite' })
  await expect(code).toHaveValue(/.+/)
  return code.inputValue()
}

async function ask(page, code) {
  await page.getByPlaceholder('Invite code').fill(code)
  await page.getByRole('button', { name: 'Join', exact: true }).click()
}

function waiting(page) {
  return page.getByRole('region', { name: 'Waiting' })
}

function ended(page) {
  return page.getByRole('region', { name: 'Ended' })
}

// a count that is still 0 after ms, never seen above it in between
async function stays(locator, ms = 5000) {
  const start = Date.now()
  let seen = 0
  await expect
    .poll(
      async () => {
        seen = Math.max(seen, await locator.count())
        return seen || Date.now() - start > ms ? seen : -1
      },
      { timeout: ms * 3 }
    )
    .toBe(0)
}

// Alice in her room "clinic" with an approval invite on screen, Bob on his list with a room of his own
async function asked(launch, ttl) {
  const alice = await signUp(launch, 'Alice')
  const bob = await signUp(launch, 'Bob')
  await create(bob.page, 'notes')
  await back(bob.page)
  await create(alice.page, 'clinic')
  const code = await approval(alice.page, ttl)
  await ask(bob.page, code)
  await expect(waiting(bob.page).getByText('Waiting for a member to let you in')).toBeVisible()
  return { alice, bob, code }
}

function requests(page) {
  return page.getByRole('region', { name: 'Requests' }).getByRole('button', { name: 'Accept' })
}

// Bob signs up on his phone and links his laptop to it from Settings
async function linked(launch) {
  const phone = await signUp(launch, 'Bob')
  await phone.page.getByRole('button', { name: /Bob/ }).click()
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

test("a join by an invite that needs approval shows under Waiting at once, on the joiner's other device too", async ({
  launch
}) => {
  const alice = await signUp(launch, 'Alice')
  const { phone, laptop } = await linked(launch)
  await create(alice.page, 'clinic')
  const code = await approval(alice.page)

  await ask(laptop.page, code)
  for (const { page } of [laptop, phone]) {
    await expect(waiting(page).getByText('Waiting for a member to let you in')).toBeVisible()
    await expect(waiting(page).getByRole('button', { name: 'Cancel' })).toBeVisible()
  }
  await expect(requests(alice.page)).toHaveCount(1)
})

test('a join its joiner cancels leaves Waiting', async ({ launch }) => {
  const { alice, bob } = await asked(launch)
  await expect(requests(alice.page)).toHaveCount(1)

  await waiting(bob.page).getByRole('button', { name: 'Cancel' }).click()
  await expect(waiting(bob.page)).toHaveCount(0)
  await expect(bob.page.getByText('notes', { exact: true })).toBeVisible()
  await expect(ended(bob.page)).toHaveCount(0)
})

test('the request of a join its joiner cancels goes from the room', async ({ launch }) => {
  test.fail(true, 'cero.cancel ends the join on the joiner side only: the room keeps its request')
  const { alice, bob } = await asked(launch)
  await expect(requests(alice.page)).toHaveCount(1)

  await waiting(bob.page).getByRole('button', { name: 'Cancel' }).click()
  await expect(waiting(bob.page)).toHaveCount(0)
  await expect(requests(alice.page)).toHaveCount(0)
})

test('a join a member denies moves to Ended with the reason', async ({ launch }) => {
  const { alice, bob } = await asked(launch)
  await expect(requests(alice.page)).toHaveCount(1)

  await alice.page.getByPlaceholder('Reason').fill('not today')
  await alice.page.getByRole('button', { name: 'Deny' }).click()
  await expect(requests(alice.page)).toHaveCount(0)

  await expect(ended(bob.page).getByText('Denied: not today', { exact: true })).toBeVisible()
  await expect(waiting(bob.page)).toHaveCount(0)
  await expect(alice.page.getByText('1 members', { exact: true })).toBeVisible()
})

test('an ended join the joiner dismisses is gone, after a restart too', async ({ launch }) => {
  test.fail(true, 'cero.del(me.room, id) rejects ROUTE_NOT_FOUND_BY_NAME: @cero/del-room')
  const { alice, bob } = await asked(launch)
  await expect(requests(alice.page)).toHaveCount(1)
  await alice.page.getByRole('button', { name: 'Deny' }).click()
  await expect(ended(bob.page).getByText('Denied', { exact: true })).toBeVisible()

  await ended(bob.page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(ended(bob.page)).toHaveCount(0)

  await bob.close()
  const again = await launch('bob', { storage: bob.storage })
  await expect(again.page.getByText('notes', { exact: true })).toBeVisible()
  await stays(ended(again.page))
  await expect(waiting(again.page)).toHaveCount(0)
})

test('a member a member removes leaves his list and shows under Ended as removed by her', async ({
  launch
}) => {
  const alice = await signUp(launch, 'Alice')
  const bob = await signUp(launch, 'Bob')
  await alice.page.getByRole('button', { name: /Alice/ }).click()
  const id = (await alice.page.getByText(/^\w{16}\.\.\.$/).textContent()).slice(0, 8)
  await back(alice.page)

  await create(alice.page, 'clinic')
  await alice.page.getByRole('button', { name: 'Invite', exact: true }).click()
  const copy = alice.page.getByRole('button', { name: 'Copy' })
  await expect(copy).toBeVisible()
  const code = await copy.locator('xpath=preceding-sibling::span').textContent()
  await ask(bob.page, code)
  await expect(bob.page.getByPlaceholder('Message...')).toBeVisible()
  await back(bob.page)
  await expect(bob.page.getByText('clinic', { exact: true })).toBeVisible()

  await people(alice.page)
  const members = alice.page.getByRole('region', { name: 'Members' })
  await expect(members.getByRole('button', { name: 'Remove' })).toHaveCount(1)
  await members.getByRole('button', { name: 'Remove' }).click()
  await expect(alice.page.getByText('1 members', { exact: true })).toBeVisible()

  await expect(ended(bob.page).getByText(`Removed by ${id}`, { exact: true })).toBeVisible()
  await expect(ended(bob.page).getByText('clinic', { exact: true })).toBeVisible()
  await expect(bob.page.getByText('clinic', { exact: true })).toHaveCount(1)
})

test('a join on an invite with a short expiry that nobody answers ends as expired', async ({
  launch
}) => {
  const { alice, bob } = await asked(launch, '10s')
  await expect(requests(alice.page)).toHaveCount(1)

  await expect(ended(bob.page).getByText('The invite expired', { exact: true })).toBeVisible()
  await expect(waiting(bob.page)).toHaveCount(0)
})
