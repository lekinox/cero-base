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

async function members(page) {
  await page.getByRole('button', { name: /members$/ }).click()
  return page.getByRole('listitem')
}

// fails as soon as the text shows on the page, passes once it has stayed away for five seconds
async function staysAbsent(page, text) {
  const start = Date.now()
  let seen = false
  await expect
    .poll(
      async () => {
        seen ||= (await page.getByText(text, { exact: true }).count()) > 0
        if (seen) return 'read'
        return Date.now() - start > 5000 ? 'absent' : 'waiting'
      },
      { timeout: 15_000 }
    )
    .toBe('absent')
}

// Alice's room "clinic" with Bob and Carol in it by invite, and "before" read by both;
// Bob has a room of his own so his list is known to have loaded
async function clinic(launch) {
  const alice = await signUp(launch, 'Alice')
  const bob = await signUp(launch, 'Bob')
  const carol = await signUp(launch, 'Carol')
  await create(bob.page, 'notes')
  await back(bob.page)
  await create(alice.page, 'clinic')
  await join(bob.page, await invite(alice.page))
  await back(alice.page)
  await alice.page.getByText('clinic', { exact: true }).click()
  await join(carol.page, await invite(alice.page))
  await expect(alice.page.getByText('3 members')).toBeVisible()
  await expect(bob.page.getByText('3 members')).toBeVisible()
  await expect(carol.page.getByText('3 members')).toBeVisible()

  await send(alice.page, 'before')
  await expect(bob.page.getByText('before', { exact: true })).toBeVisible()
  await expect(carol.page.getByText('before', { exact: true })).toBeVisible()
  return { alice, bob, carol }
}

async function remove(alice, name) {
  const list = await members(alice.page)
  await list.filter({ hasText: name }).getByRole('button', { name: 'Remove' }).click()
  await expect(alice.page.getByText('2 members')).toBeVisible()
  await expect(list.filter({ hasText: name })).toHaveCount(0)
}

test('a member the owner removes no longer finds the room in his list', async ({ launch }) => {
  const { alice, bob } = await clinic(launch)
  await remove(alice, 'Bob')

  await bob.page.getByRole('button', { name: '←' }).click()
  await expect(bob.page.getByText('notes', { exact: true })).toBeVisible()
  await expect(bob.page.getByText('clinic', { exact: true })).toHaveCount(0)
})

test('what is written after a removal reaches the members left and not the removed one, who keeps what came before', async ({
  launch
}) => {
  const { alice, bob, carol } = await clinic(launch)
  await remove(alice, 'Bob')

  // Bob still has the room on screen, and it has seen him go
  await expect(bob.page.getByText('2 members')).toBeVisible()
  await send(alice.page, 'after')
  await expect(carol.page.getByText('after', { exact: true })).toBeVisible()
  await staysAbsent(bob.page, 'after')

  await send(carol.page, 'from carol')
  await expect(alice.page.getByText('from carol', { exact: true })).toBeVisible()
  await staysAbsent(bob.page, 'from carol')

  await expect(bob.page.getByText('before', { exact: true })).toBeVisible()
  await expect(carol.page.getByText('before', { exact: true })).toBeVisible()
})

test('a removed member who joins again with a new invite reads everything and his writes reach both', async ({
  launch
}) => {
  const { alice, bob, carol } = await clinic(launch)
  await remove(alice, 'Bob')
  await send(alice.page, 'after')
  await send(carol.page, 'from carol')
  await expect(alice.page.getByText('from carol', { exact: true })).toBeVisible()
  await back(bob.page)
  await expect(bob.page.getByText('clinic', { exact: true })).toHaveCount(0)

  await back(alice.page)
  await alice.page.getByText('clinic', { exact: true }).click()
  await join(bob.page, await invite(alice.page))
  await expect(alice.page.getByText('3 members')).toBeVisible()
  for (const text of ['before', 'after', 'from carol']) {
    await expect(bob.page.getByText(text, { exact: true })).toBeVisible()
  }

  await send(bob.page, 'bob is back')
  await expect(alice.page.getByText('bob is back', { exact: true })).toBeVisible()
  await expect(carol.page.getByText('bob is back', { exact: true })).toBeVisible()

  await back(bob.page)
  await expect(bob.page.getByText('clinic', { exact: true })).toBeVisible()
})

test('the owner sees a Remove button on each other member and a member sees none', async ({
  launch
}) => {
  const { alice, carol } = await clinic(launch)

  const owner = await members(alice.page)
  await expect(owner).toHaveCount(3)
  await expect(owner.filter({ hasText: 'Alice' }).getByRole('button')).toHaveCount(0)
  await expect(owner.getByRole('button', { name: 'Remove' })).toHaveCount(2)

  const member = await members(carol.page)
  await expect(member).toHaveCount(3)
  await expect(member.filter({ hasText: 'Alice' })).toHaveCount(1)
  await expect(member.getByRole('button', { name: 'Remove' })).toHaveCount(0)
})
