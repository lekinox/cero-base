// What does the dry-run cost on the write path?
//
// Each arm gets a FRESH database, so both write into an equally-sized store —
// the previous version of this benchmark ran both arms against one growing db
// and measured dataset growth instead of the dry-run.
//
//   N=300 npx brittle-bare test/manual/bench-write.mjs
import test from 'brittle'

import { Database } from '../../src/database/index.js'
import { Identity } from '../../src/identity/index.js'
import { makeStore } from '../helpers/index.js'
import { spec } from '../fixtures/spec/index.js'

const N = Number(process.env.N || 300)

test.configure({ timeout: 900000 })

async function open(t) {
  const { store } = await makeStore(t, { columnFamilies: ['cero/local'] })
  const identity = await Identity.generate()
  const db = new Database({ store, identity, spec })
  await db.ready()
  await db.bootstrap({ name: 'bench', isMobile: false })
  t.teardown(() => db.close().catch(() => {}), { order: 5 })
  return db
}

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6

// one arm = a fresh db, N single-row writes, dry-run live or stubbed
async function arm(t, { dry }) {
  const db = await open(t)
  if (!dry) db._dryRun = async () => {}
  for (let i = 0; i < 20; i++) await db.put('messages', { text: `warm${i}` })
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < N; i++) await db.put('messages', { text: `row${i}` })
  return ms(t0)
}

test(`bench: dry-run cost over ${N} writes (fresh db per arm, both orders)`, async (t) => {
  // run A,B then B,A — cancels any warm-up drift favouring whoever goes first
  const a1 = await arm(t, { dry: true })
  const b1 = await arm(t, { dry: false })
  const b2 = await arm(t, { dry: false })
  const a2 = await arm(t, { dry: true })

  const withDry = (a1 + a2) / 2
  const withoutDry = (b1 + b2) / 2
  const perOp = (withDry - withoutDry) / N

  console.log(`\n  ${N} single-row writes, fresh db per arm`)
  console.log(`    with dry-run    ${withDry.toFixed(0)} ms   (${(withDry / N).toFixed(3)} ms/op)`)
  console.log(
    `    without         ${withoutDry.toFixed(0)} ms   (${(withoutDry / N).toFixed(3)} ms/op)`
  )
  console.log(`    dry-run costs   ${perOp.toFixed(3)} ms/op`)
  console.log(`    overhead        ${((withDry / withoutDry - 1) * 100).toFixed(0)}%`)
  console.log(
    `    raw             dry=[${a1.toFixed(0)}, ${a2.toFixed(0)}]  no-dry=[${b1.toFixed(0)}, ${b2.toFixed(0)}]\n`
  )

  t.pass('measured')
})

test('bench: does per-write cost grow with collection size?', async (t) => {
  const db = await open(t)
  const STEP = 200
  const marks = []

  for (let block = 0; block < 5; block++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < STEP; i++) await db.put('messages', { text: `b${block}-${i}` })
    marks.push({ upTo: (block + 1) * STEP, perOp: ms(t0) / STEP })
  }

  console.log('\n  per-write cost as the collection grows')
  for (const m of marks) {
    console.log(`    rows ${String(m.upTo).padStart(5)}   ${m.perOp.toFixed(3)} ms/op`)
  }
  // The first block is always the cheapest — a shallow tree with everything
  // cached — so last/first overstates growth. What matters is whether cost is
  // still climbing once the tree has settled, so compare the tail instead.
  const settled = marks.slice(1)
  const trend = settled[settled.length - 1].perOp / settled[0].perOp
  console.log(
    `    last/first      ${(marks[marks.length - 1].perOp / marks[0].perOp).toFixed(1)}x  (front-loaded — ignore)`
  )
  console.log(
    `    tail trend      ${trend.toFixed(2)}x  ${trend > 1.5 ? '← still climbing, worth chasing' : '(flat — tree depth settled)'}\n`
  )

  t.pass('measured')
})
