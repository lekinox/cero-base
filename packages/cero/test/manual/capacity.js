// One process of `npm run test:capacity`: scripts/capacity.js runs it and reads the line of JSON it prints.
//   build <dir> <from> <count>   adds handles rows to the root in <dir>
//   launch <dir> <id>            launches it, then changes the row <id> a few times
import process from 'process'
import createTestnet from '@hyperswarm/testnet'

import { cero } from '../../src/index.js'
import { spec } from '../fixtures/spec/index.js'
import { addHandles, waitUntil } from '../helpers/index.js'

const BATCH = 1000
const CHANGES = 5

const now = () => Number(process.hrtime.bigint()) / 1e6

async function build(me, from, count) {
  let written = 0
  me.on('topics', () => written++)
  let id = null
  // a batch at a time, so the topics rows keep up with the handles rows
  for (let done = 0; done < count; done += BATCH) {
    const size = Math.min(BATCH, count - done)
    ;[id] = await addHandles(me, size, from + done)
    await waitUntil(() => written >= done + size, 600000, 5)
  }
  return { id }
}

async function launch(dir, opts, id) {
  const before = process.memoryUsage().rss
  const start = now()
  const me = await cero(dir, spec, opts)
  const launch = now() - start
  const rss = process.memoryUsage().rss - before

  // the quickest of a few: the first ones pay for what a fresh process has yet to load
  const changes = []
  for (let i = 0; i < CHANGES; i++) {
    const followed = new Promise((resolve) => me.once('topics', resolve))
    const at = now()
    await me.store.set('handles', { id, name: `renamed ${at}` })
    await followed
    changes.push(now() - at)
  }
  return { me, launch, rss, change: Math.min(...changes) }
}

const [mode, dir, ...rest] = process.argv.slice(2)
const testnet = await createTestnet(3)
const opts = { bootstrap: testnet.bootstrap }

let me = null
let result = null
if (mode === 'build') {
  me = await cero(dir, spec, opts)
  result = await build(me, Number(rest[0]), Number(rest[1]))
} else {
  ;({ me, ...result } = await launch(dir, opts, rest[0]))
}
// the pass over the changed rows has finished: the next launch has none to read
await me._indexing
await me.close()
await testnet.destroy()
console.log(JSON.stringify(result))
