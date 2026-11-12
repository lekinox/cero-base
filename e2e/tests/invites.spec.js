import { test, expect } from '../fixtures.js'

async function person(launch, name) {
  const opened = await launch(name.toLowerCase())
  await opened.page.getByPlaceholder('Your name').fill(name)
  await opened.page.getByRole('button', { name: 'Continue' }).click()
  await expect(opened.page.getByPlaceholder('Room name')).toBeVisible()
  return opened
}

// Alice makes "clinic" and stays inside it
async function host(launch) {
  const alice = await person(launch, 'Alice')
  await alice.page.getByPlaceholder('Room name').fill('clinic')
  await alice.page.getByRole('button', { name: 'New' }).click()
  await expect(alice.page.getByPlaceholder('Message...')).toBeVisible()
  return alice
}

// mints a code with the room's invite options and reads it off the screen
async function code(page, { confirm = false, role = 'member', reuse = false } = {}) {
  const field = page.getByRole('textbox', { name: 'Code' })
  const previous = (await field.count()) ? await field.inputValue() : ''
  await page.getByRole('checkbox', { name: 'Needs approval' }).setChecked(confirm)
  await page.getByRole('combobox', { name: 'Role' }).selectOption(role)
  await page.getByRole('checkbox', { name: 'Reusable' }).setChecked(reuse)
  await page.getByRole('button', { name: 'Create code' }).click()
  await expect(field).not.toHaveValue(previous)
  return field.inputValue()
}

async function join(page, invite) {
  await page.getByPlaceholder('Invite code').fill(invite)
  await page.getByRole('button', { name: 'Join' }).click()
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

// fails if the locator shows up at any point in the window
async function absent(locator, window = 5_000) {
  const until = Date.now() + window
  await expect
    .poll(async () => {
      if (await locator.count()) return 'shown'
      return Date.now() > until ? 'absent' : 'watching'
    })
    .toBe('absent')
}

test('a join under an invite that needs approval waits until the owner approves, then the room is in the joiner list and he writes', async ({
  launch
}) => {
  const alice = await host(launch)
  const bob = await person(launch, 'Bob')
  const invite = await code(alice.page, { confirm: true })

  await join(bob.page, invite)
  await expect(bob.page.getByText('Waiting to be let in')).toBeVisible()
  await expect(alice.page.getByText(/^member · /)).toBeVisible()
  await alice.page.getByRole('button', { name: 'Approve' }).click()
  await expect(alice.page.getByRole('button', { name: 'Approve' })).toHaveCount(0)

  await expect(bob.page.getByPlaceholder('Message...')).toBeVisible()
  await bob.page.getByRole('button', { name: '←' }).click()
  await expect(bob.page.getByText('Waiting to be let in')).toHaveCount(0)
  await enter(bob.page, 'clinic')
  await send(bob.page, 'approved and in')
  await expect(alice.page.getByText('approved and in', { exact: true })).toBeVisible()
})

test('a join denied with a reason shows the joiner that reason and the room stays out of her list', async ({
  launch
}) => {
  const alice = await host(launch)
  const carol = await person(launch, 'Carol')
  const invite = await code(alice.page, { confirm: true })

  await join(carol.page, invite)
  await expect(carol.page.getByText('Waiting to be let in')).toBeVisible()
  await alice.page.getByPlaceholder('Reason').fill('not staff')
  await alice.page.getByRole('button', { name: 'Deny' }).click()
  await expect(alice.page.getByRole('button', { name: 'Deny' })).toHaveCount(0)

  await expect(carol.page.getByText('Turned away: not staff')).toBeVisible()
  await absent(carol.page.getByText('clinic', { exact: true }))
})

test('a single-use invite lets the first joiner in and turns the second away', async ({
  launch
}) => {
  const alice = await host(launch)
  const bob = await person(launch, 'Bob')
  const carol = await person(launch, 'Carol')
  const invite = await code(alice.page)

  await join(bob.page, invite)
  await expect(bob.page.getByPlaceholder('Message...')).toBeVisible()
  await expect(alice.page.getByText('Bob · member')).toBeVisible()

  await join(carol.page, invite)
  await expect(carol.page.getByText('Turned away: spent')).toBeVisible()
  await absent(carol.page.getByText('clinic', { exact: true }))
})

test('a reusable invite lets two joiners in', async ({ launch }) => {
  const alice = await host(launch)
  const bob = await person(launch, 'Bob')
  const carol = await person(launch, 'Carol')
  const invite = await code(alice.page, { reuse: true })

  await join(bob.page, invite)
  await expect(bob.page.getByPlaceholder('Message...')).toBeVisible()
  await join(carol.page, invite)
  await expect(carol.page.getByPlaceholder('Message...')).toBeVisible()

  await expect(alice.page.getByText('3 members', { exact: true })).toBeVisible()
  await send(carol.page, 'carol is in too')
  await expect(bob.page.getByText('carol is in too', { exact: true })).toBeVisible()
})

test('a revoked invite turns away the join that waited for approval under it and the next joiner', async ({
  launch
}) => {
  const alice = await host(launch)
  const carol = await person(launch, 'Carol')
  const dave = await person(launch, 'Dave')
  const invite = await code(alice.page, { confirm: true, reuse: true })

  await join(carol.page, invite)
  await expect(carol.page.getByText('Waiting to be let in')).toBeVisible()
  await expect(alice.page.getByRole('button', { name: 'Approve' })).toBeVisible()
  await expect(alice.page.getByText('member, reusable, needs approval')).toBeVisible()
  await alice.page.getByRole('button', { name: 'Revoke' }).click()
  await expect(alice.page.getByText('member, reusable, needs approval')).toHaveCount(0)

  await expect(carol.page.getByText('Turned away: revoked')).toBeVisible()
  await join(dave.page, invite)
  await expect(dave.page.getByText('Turned away: revoked')).toBeVisible()
  await absent(dave.page.getByText('clinic', { exact: true }))
  await expect(carol.page.getByText('clinic', { exact: true })).toHaveCount(0)
})

test('a reader reads the room and his write is refused', async ({ launch }) => {
  const alice = await host(launch)
  const bob = await person(launch, 'Bob')
  const invite = await code(alice.page, { role: 'reader' })

  await join(bob.page, invite)
  await expect(bob.page.getByText('Read only: readers cannot write here')).toBeVisible()
  // a reader writes nothing, its own name in the member row neither
  await expect(alice.page.getByText(/ · reader$/)).toBeVisible()
  await send(alice.page, 'for the reader')
  await expect(bob.page.getByText('for the reader', { exact: true })).toBeVisible()

  await bob.page.getByPlaceholder('Message...').fill('the reader writes')
  await bob.page.getByRole('button', { name: 'Send' }).click()
  await send(alice.page, 'after the reader tried')
  await expect(bob.page.getByText('after the reader tried', { exact: true })).toBeVisible()
  await absent(alice.page.getByText('the reader writes', { exact: true }))
  await expect(bob.page.getByText('the reader writes', { exact: true })).toHaveCount(0)
})

test('a removed joiner is turned away by the reusable code she saw and let in by a code minted after', async ({
  launch
}) => {
  const alice = await host(launch)
  const carol = await person(launch, 'Carol')
  const reusable = await code(alice.page, { reuse: true })

  await join(carol.page, reusable)
  await expect(carol.page.getByPlaceholder('Message...')).toBeVisible()
  await carol.page.getByRole('button', { name: '←' }).click()
  await expect(carol.page.getByText('clinic', { exact: true })).toBeVisible()

  await expect(alice.page.getByText('Carol · member')).toBeVisible()
  await alice.page.getByRole('button', { name: 'Remove' }).click()
  await expect(alice.page.getByText('Carol · member')).toHaveCount(0)
  await expect(carol.page.getByText(/^Removed by /)).toBeVisible()
  await expect(carol.page.getByText('clinic', { exact: true })).toHaveCount(0)

  await join(carol.page, reusable)
  await expect(carol.page.getByText('Denied: removed')).toBeVisible()
  await expect(carol.page.getByText(/^Removed by /)).toBeVisible()
  await absent(carol.page.getByText('clinic', { exact: true }))

  const fresh = await code(alice.page)
  await join(carol.page, fresh)
  await expect(carol.page.getByPlaceholder('Message...')).toBeVisible()
  await send(carol.page, 'back with a new code')
  await expect(alice.page.getByText('back with a new code', { exact: true })).toBeVisible()
})
