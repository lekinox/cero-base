import test from 'brittle'

import { Presence } from '../../src/network/presence.js'
import { randomTopic, waitFor } from '../helpers/index.js'

// a network that records joins instead of touching the DHT
function stub() {
  const network = {
    closing: false,
    closed: false,
    joined: [],
    flips: 0,
    join(topic, { mode }) {
      const d = {
        topic,
        mode,
        destroyed: false,
        async activate() {
          this.mode = 'active'
          network.flips++
        },
        async deactivate() {
          this.mode = 'passive'
          network.flips++
        },
        async destroy() {
          this.destroyed = true
        }
      }
      network.joined.push(d)
      return d
    }
  }
  return network
}

function open(presence, n) {
  return Array.from({ length: n }, () => presence.add(randomTopic()))
}

const pending = (presence) => [...presence.entries.values()].filter((e) => e.timer !== null).length

test('presence: the latest search, the next announce, the rest never join', (t) => {
  const network = stub()
  const presence = new Presence(network, { active: 2, announced: 1 })
  const slots = open(presence, 5)
  t.alike(
    slots.map((s) => s.mode),
    ['active', 'active', 'passive', null, null]
  )
  t.is(network.joined.length, 3, 'only the budget joined')
})

test('presence: a touch promotes at once, the least recent slides down after idle', async (t) => {
  const network = stub()
  const presence = new Presence(network, { active: 2, announced: 1, idle: 20 })
  const [a, b, c, d] = open(presence, 4)
  d.touch()
  t.alike([a.mode, b.mode, c.mode, d.mode], ['active', 'active', 'passive', 'active'])
  t.is(network.flips, 0, 'nothing flipped yet')
  await waitFor(() => c.mode === null)
  t.ok(network.joined[2].destroyed, 'the topic past the budget left')
  t.is(b.mode, 'passive', 'b settled to announce only')
  t.is(network.flips, 1)
})

test('presence: rooms fighting over the edge of the budget do not churn', async (t) => {
  const network = stub()
  const presence = new Presence(network, { active: 1, announced: 0, idle: 20 })
  const [a, b] = open(presence, 2)
  for (let i = 0; i < 20; i++) {
    b.touch()
    a.touch()
  }
  t.is(network.joined.length, 2, 'each joined once')
  t.is(network.flips, 0, 'and never flipped')
  t.is(pending(presence), 1, 'the loser is on its way out')
  await waitFor(() => b.mode === null)
  t.is(a.mode, 'active', 'the last touched stayed')
})

test('presence: a touch before idle cancels the leave', (t) => {
  const network = stub()
  const presence = new Presence(network, { active: 1, announced: 0 })
  const [a, b] = open(presence, 2)
  b.touch()
  t.is(pending(presence), 1, 'a is on its way out')
  a.touch()
  t.is(pending(presence), 1, 'now b is')
  t.is(a.mode, 'active')
  t.is(network.joined.length, 2, 'a rejoined nothing, its topic never left')
})

test('presence: pinned always searches, outside the budget', (t) => {
  const network = stub()
  const presence = new Presence(network, { active: 1, announced: 0 })
  const root = presence.add(randomTopic(), { pinned: true })
  const [a, b] = open(presence, 2)
  b.touch()
  t.is(root.mode, 'active')
  t.is(b.mode, 'active', 'the budget is spent on b, not the root')
  t.is(a.mode, 'active', 'a keeps its topic until idle')
})

test('presence: off leaves after idle, the next touch rejoins', async (t) => {
  const network = stub()
  const presence = new Presence(network, { active: 2, announced: 0, idle: 20 })
  const [a, b] = open(presence, 2)
  a.off()
  await waitFor(() => a.mode === null)
  t.is(b.mode, 'active')
  a.touch()
  t.is(a.mode, 'active', 'rejoined')
  t.is(network.joined.length, 3, 'with a fresh topic session')
})

test('presence: remove leaves at once and drops the slot', (t) => {
  const network = stub()
  const presence = new Presence(network, { active: 1, announced: 0, idle: 20 })
  const [a, b] = open(presence, 2)
  b.touch()
  t.is(pending(presence), 1)
  a.remove()
  t.ok(network.joined[0].destroyed, 'left without waiting for idle')
  t.is(presence.entries.size, 1)
  t.is(pending(presence), 0, 'and its idle timer is gone')
})

test('presence: the same topic is one entry, held until every slot is removed', (t) => {
  const network = stub()
  const presence = new Presence(network, { active: 1, announced: 0 })
  const topic = randomTopic()
  const a = presence.add(topic)
  const b = presence.add(topic)
  t.is(presence.entries.size, 1)
  t.is(network.joined.length, 1)
  a.remove()
  t.is(network.joined[0].destroyed, false, 'b still holds the topic')
  b.remove()
  t.is(network.joined[0].destroyed, true)
  t.is(presence.entries.size, 0)
})

test('presence: close clears the idle timers', async (t) => {
  const network = stub()
  const presence = new Presence(network, { active: 1, announced: 0, idle: 20 })
  const [a, b] = open(presence, 2)
  b.touch()
  presence.close()
  await new Promise((r) => setTimeout(r, 40))
  t.is(network.joined[0].destroyed, false, 'nothing fired after close')
  t.is(presence.entries.size, 0)
  t.is(a.mode, 'active', 'the network tears the sessions down, not the timer')
})
