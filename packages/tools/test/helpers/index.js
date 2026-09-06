import createTestnet from '@hyperswarm/testnet'
import process from 'process'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { promises as fs, rmSync } from 'fs'
import { cero, schema, t } from '@cero-base/cero'
import { build } from '@cero-base/cero/build'

const here = dirname(fileURLToPath(import.meta.url))
const buildRoot = join(here, '..', 'fixtures', '.build')
process.on('exit', () => rmSync(buildRoot, { recursive: true, force: true }))

// `t` here is the cero schema DSL; inside the helpers it is shadowed by the
// brittle test object passed as the first arg (same pattern as cero's tests).
export const appSchema = schema({
  profile: t.single({ name: t.string, avatar: t.string }),
  messages: t.collection({ text: t.string }),
  room: { messages: t.collection({ text: t.string }) }
})

export async function makeTestnet(t, size = 3) {
  const net = await createTestnet(size)
  t.teardown(() => net.destroy(), { order: 100 })
  return net
}

export async function buildSpec(t, sub, sch = appSchema) {
  const dir = join(buildRoot, sub)
  await fs.rm(dir, { recursive: true, force: true })
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await build(dir, sch)
  const { spec } = await import(pathToFileURL(join(dir, 'index.js')).href)
  return { spec, dir }
}

export async function openCero(t, spec) {
  const testnet = await makeTestnet(t)
  const me = await cero(await t.tmp(), spec, { bootstrap: testnet.bootstrap })
  t.teardown(() => me.close().catch(() => {}), { order: 5 })
  return me
}
