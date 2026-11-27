import fs from 'fs'
import FDLock from 'fd-lock'

import { CeroError } from '@cero-base/core/errors'

// Another identity comes in beside `main`, in `main.next`, and takes its place only once it has opened: the new store
// is flushed to disk, then main moves to `main.old` and `main.next/main` to `main`, each rename atomic. A launch reads
// from what is on disk how far a killed swap got. The swap and every open of `dir` take turns on `main.lock`
const NEXT = 'main.next'
const OLD = 'main.old'
const LOCK = 'main.lock'
const RETRY = 20

// the dirs a swap is running in, in this process: their `main.next` is in use
const running = new Set()

/**
 * Where the incoming identity opens.
 *
 * @param {string} dir
 * @returns {string}
 */
export const nextOf = (dir) => `${dir}/${NEXT}`

/**
 * The store a launch of `dir` opens, without moving anything: `main`, or with a swap killed between its renames,
 * the identity `settle` will keep.
 *
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function current(dir) {
  const main = `${dir}/main`
  if ((await exists(main)) || !(await exists(`${dir}/${OLD}`))) return main
  return (await exists(`${nextOf(dir)}/main`)) ? `${nextOf(dir)}/main` : `${dir}/${OLD}`
}

/**
 * A swap killed part way, finished or undone before anything opens `dir`: past its first rename the incoming
 * identity had opened, so it takes main's place; without it the old one comes back.
 *
 * @param {string} dir
 */
export async function settle(dir) {
  const main = `${dir}/main`
  const old = `${dir}/${OLD}`
  if (await exists(old)) {
    if (!(await exists(main))) await fs.promises.rename(await current(dir), main)
    await rm(old)
  }
}

/**
 * The lock on `dir`, a file beside the stores, held from before a store closes or opens until the one in `main` is
 * open: a store's own lock goes with its close and moves with its directory. Another holder is waited for, a try
 * every few ms; a kill frees it.
 *
 * @param {string} dir
 * @param {number} [timeout]  The longest wait in ms, 0 for no limit.
 * @returns {Promise<{ close: () => Promise<void> }>}  Held until closed.
 */
export async function lock(dir, timeout = 0) {
  await fs.promises.mkdir(dir, { recursive: true })
  const deadline = timeout ? Date.now() + timeout : Infinity
  while (true) {
    const held = new FDLock(await open(`${dir}/${LOCK}`))
    try {
      await held.ready()
      return held
    } catch (err) {
      // a file that cannot be locked at all carries the system's code, one that is held does not
      if (err.code) throw err
      if (Date.now() >= deadline) throw CeroError.TIMEOUT(`The lock on ${dir}`)
      await new Promise((resolve) => setTimeout(resolve, RETRY))
    }
  }
}

/**
 * What a killed swap left in `main.next` goes, unless a swap is running there. Only once `main` is open: a swap in
 * another process keeps main open while the incoming identity opens.
 *
 * @param {string} dir
 */
export async function sweep(dir) {
  if (!running.has(dir)) await rm(nextOf(dir))
}

/**
 * Run `fn` with `dir/main.next` set aside for it, emptied before and after.
 *
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function staging(dir, fn) {
  running.add(dir)
  try {
    await rm(nextOf(dir))
    return await fn()
  } catch (err) {
    await rm(nextOf(dir))
    throw err
  } finally {
    running.delete(dir)
  }
}

/**
 * The identity opened and closed in `main.next`, all of it on disk: a rename that follows never points at data
 * still in a cache.
 *
 * @param {string} dir
 */
export async function flush(dir) {
  await durable(`${nextOf(dir)}/main`)
}

/**
 * The identity opened, closed and flushed in `main.next` takes main's place. Both must be closed.
 *
 * @param {string} dir
 */
export async function commit(dir) {
  const incoming = `${nextOf(dir)}/main`
  await fs.promises.rename(`${dir}/main`, `${dir}/${OLD}`)
  await fs.promises.rename(incoming, `${dir}/main`)
  await sync(dir, true)
  await rm(`${dir}/${OLD}`)
  await rm(nextOf(dir))
}

async function durable(path) {
  for (const entry of await fs.promises.readdir(path, { withFileTypes: true })) {
    const at = `${path}/${entry.name}`
    if (entry.isDirectory()) await durable(at)
    else if (entry.isFile()) await sync(at, false)
  }
  await sync(path, true)
}

// a platform that cannot open a directory to flush it (Windows) skips the directory; a file must flush
async function sync(path, dir) {
  let handle
  try {
    handle = await fs.promises.open(path, 'r')
  } catch (err) {
    if (dir) return
    throw err
  }
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function open(path) {
  return new Promise((resolve, reject) => {
    fs.open(path, 'a', (err, fd) => (err ? reject(err) : resolve(fd)))
  })
}

function exists(path) {
  return fs.promises.stat(path).then(
    () => true,
    () => false
  )
}

function rm(path) {
  return fs.promises.rm(path, { recursive: true, force: true })
}
