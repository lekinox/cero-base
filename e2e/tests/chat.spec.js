import { test, expect } from '../fixtures.js'

async function profile(page, name) {
  await page.getByPlaceholder('Your name').fill(name)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByPlaceholder('Room name')).toBeVisible()
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

// Alice makes "clinic" and invites Bob; both end up inside the room
async function clinic(launch) {
  const alice = await launch('alice')
  const bob = await launch('bob')
  await profile(alice.page, 'Alice')
  await profile(bob.page, 'Bob')

  await alice.page.getByPlaceholder('Room name').fill('clinic')
  await alice.page.getByRole('button', { name: 'New' }).click()
  await alice.page.getByRole('button', { name: 'Invite' }).click()
  const copy = alice.page.getByRole('button', { name: 'Copy' })
  await expect(copy).toBeVisible()
  const invite = await copy.locator('xpath=preceding-sibling::span').textContent()

  await bob.page.getByPlaceholder('Invite code').fill(invite)
  await bob.page.getByRole('button', { name: 'Join' }).click()
  await expect(bob.page.getByPlaceholder('Message...')).toBeVisible()
  return { alice, bob }
}

test('a person joins a room with the invite read off the inviter screen and finds it in their list', async ({
  launch
}) => {
  const { bob } = await clinic(launch)
  await bob.page.getByRole('button', { name: '←' }).click()
  await enter(bob.page, 'clinic')
})

test('a message reaches the other member with its writer name', async ({ launch }) => {
  const { alice, bob } = await clinic(launch)
  await send(alice.page, 'hello from alice')
  await expect(bob.page.getByText('hello from alice', { exact: true })).toBeVisible()
  await expect(bob.page.getByText('Alice', { exact: true })).toBeVisible()
})

test('a reply reaches the first writer with the replier name', async ({ launch }) => {
  const { alice, bob } = await clinic(launch)
  await send(alice.page, 'hello from alice')
  await expect(bob.page.getByText('hello from alice', { exact: true })).toBeVisible()
  await send(bob.page, 'hello back from bob')
  await expect(alice.page.getByText('hello back from bob', { exact: true })).toBeVisible()
  await expect(alice.page.getByText('Bob', { exact: true })).toBeVisible()
})

test('messages back and forth keep their order on both sides', async ({ launch }) => {
  const { alice, bob } = await clinic(launch)
  const turns = ['turn 1', 'turn 2', 'turn 3', 'turn 4', 'turn 5', 'turn 6']
  for (const [i, text] of turns.entries()) {
    const [writer, reader] = i % 2 === 0 ? [alice, bob] : [bob, alice]
    await send(writer.page, text)
    await expect(reader.page.getByText(text, { exact: true })).toBeVisible()
  }
  await expect(alice.page.getByText(/^turn \d$/)).toHaveText(turns)
  await expect(bob.page.getByText(/^turn \d$/)).toHaveText(turns)
})

test('both members show in the room on both sides', async ({ launch }) => {
  const { alice, bob } = await clinic(launch)
  await expect(alice.page.getByText('2 members', { exact: true })).toBeVisible()
  await expect(bob.page.getByText('2 members', { exact: true })).toBeVisible()
})

test('a message written while the other app is closed is there when it opens again', async ({
  launch
}) => {
  const { alice, bob } = await clinic(launch)
  await bob.close()
  await send(alice.page, 'written while bob was away')

  const again = await launch('bob', { storage: bob.storage })
  await enter(again.page, 'clinic')
  await expect(again.page.getByText('written while bob was away', { exact: true })).toBeVisible()
  await expect(again.page.getByText('Alice', { exact: true })).toBeVisible()
})

test('the room and its messages are still there after both apps restart', async ({ launch }) => {
  const { alice, bob } = await clinic(launch)
  await send(alice.page, 'before the restart')
  await expect(bob.page.getByText('before the restart', { exact: true })).toBeVisible()
  await send(bob.page, 'bob before the restart')
  await expect(alice.page.getByText('bob before the restart', { exact: true })).toBeVisible()
  await alice.close()
  await bob.close()

  // each opens alone, so what it shows comes from its own folder
  for (const { name, storage } of [alice, bob]) {
    const { page, close } = await launch(name, { storage })
    await enter(page, 'clinic')
    await expect(page.getByText(/before the restart$/)).toHaveText([
      'before the restart',
      'bob before the restart'
    ])
    await close()
  }
})
