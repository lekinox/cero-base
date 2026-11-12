import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'

import { REMOVE, COUNTERS, OWED } from '../lib/constants.js'
import { can } from '../lib/utils.js'
import { wraps, epochEntries, seal, opened } from './encryption.js'
import { chainOf } from './dispatch.js'
import { Identity } from '../identity/index.js'
import { keyPair } from '../mailbox/inbox.js'
import { CeroError } from '../lib/errors.js'

// the secrets one sender handed over for a stamp before its row landed, and its stamps waiting
const CANDIDATES = 4
const STAMPS = 16
// the blocks met under a key no row holds yet: any writer can append under any stamp
const MET = 64

/**
 * Epoch key rotation for a database: mint a secret, seal it to every device, announce it
 * through the log, and on every peer learn the secrets addressed to it.
 */
export class Rotation {
  /** @param {import('./index.js').Database} db */
  constructor(db) {
    this.db = db
    this.current = null
    /** @type {Promise<void> | null} Pending while a removal and its rotation go in. */
    this.carrying = null
    /** @private */
    this._queue = Promise.resolve()
    /** @private */
    this._timer = null
    /** @private */
    this._healedFor = null
    /** @private */
    this._kept = new Map() // sender → stamp → the secrets it handed over before the row landed
    /** @private */
    this._aside = new Map() // writer:stamp → a row set aside, opened once a block of its signer under it is met
    /** @private */
    this._open = new Map() // writer:stamp → a key set aside, opened: never in the keyring
    /** @private */
    this._spots = new Set() // writer:stamp of every row set aside: its writer's blocks under it read with its key alone
    /** @private */
    this._met = new Set() // writer:stamp of blocks met before their row landed
  }

  close() {
    clearTimeout(this._timer)
    this._timer = null
  }

  /**
   * One at a time: a rotation asked for during another runs after it, sealed to the members as
   * they stand then.
   *
   * @returns {Promise<{ epoch: number }>}
   */
  rotate() {
    return this._queued(() => this._rotate(false))
  }

  /**
   * A removal by a device that may remove carries its rotation: the removal, then the key sealed
   * to the devices that stay and to those still promised a seat, with nothing else of this device
   * in between. The key is a block of its own, so it lands even when a reorder refuses the removal.
   *
   * @param {Array<[string, unknown]>} ops  A batch that takes a member or a device out.
   * @returns {Promise<number | undefined>}  What the removal's write resolves.
   */
  carry(ops) {
    return this._queued(() => this._carry(ops))
  }

  /** @private */
  _queued(fn) {
    const run = this._queue.catch(() => {}).then(fn)
    this._queue = run
    return run
  }

  /**
   * An applied rotation announcement: open our envelope, learn the secret, persist it.
   *
   * @param {{ epoch: number, stamp: number, wrapped: Uint8Array, commit: Uint8Array }} row
   */
  async learn(row) {
    if (row.aside) return this._setAside(row)
    const { keyring } = this.db
    const known = this.held(row)
    for (const at of this._met) if (at.endsWith(`:${row.stamp}`)) this._met.delete(at)
    const entropy = known || this._unseal(row) || this._handed(row)
    if (known) {
      keyring.add(row.stamp, known, row.epoch) // re-applied, the sequence may be news
    } else if (this.current && entropy && b4a.equals(entropy, this.current.entropy)) {
      this.current.epoch = row.epoch
    } else if (entropy) {
      keyring.add(row.stamp, entropy, row.epoch)
      try {
        await this._save()
        this.db.emit('epoch')
      } catch (err) {
        // an epoch we cannot reload after a restart must not be used for writes
        keyring.remove(row.stamp)
        this.db._onerror(err)
      }
    }
    this.heal()
  }

  // a row set aside reads its writer's blocks under its stamp, and nobody else's: opened now when
  // one was met, else when one is
  /** @private */
  _setAside(row) {
    if (!row.writer) return
    const at = spot(row.writer, row.stamp)
    this._spots.add(at)
    if (this._open.has(at)) return
    const known = this.held(row)
    if (known) {
      // applied as one that counts before a reorder set it aside: out of the keyring, where it
      // would read every writer's blocks under its stamp
      this.db.keyring.remove(row.stamp)
      this._aside.delete(at)
      this._open.set(at, known)
    } else if (this._met.delete(at)) {
      this._aside.delete(at)
      if (this._opens(at, row)) this.db.keyring.onchange?.()
    } else {
      this._aside.set(at, row)
    }
  }

  /**
   * The key a block of `writer` under `stamp` is read with: the one that writer set aside under
   * it, and no other, when she set one aside, else the counted one. A block met under a key this
   * device does not hold is remembered until its row lands.
   *
   * @param {number} stamp
   * @param {Uint8Array} [writer]  The writer of the block.
   * @returns {Uint8Array | null}
   */
  meet(stamp, writer) {
    const { keyring } = this.db
    if (!writer) return keyring.entropy(stamp)
    const at = spot(writer, stamp)
    if (!this._spots.has(at)) {
      const entropy = keyring.entropy(stamp)
      if (!entropy) this._remember(at)
      return entropy
    }
    const row = this._aside.get(at)
    if (row) this._aside.delete(at)
    return this._open.get(at) ?? (row && this._opens(at, row)) ?? null
  }

  /**
   * A key set aside handed over: it opens each row set aside under its stamp whose commitment it
   * meets, never a counted one.
   *
   * @param {{ stamp: number, entropy: Uint8Array }} e
   * @param {Array<{ stamp: number, commit: Uint8Array, aside?: boolean, writer?: Uint8Array }>} rows
   * @returns {boolean}  Whether it opened one.
   */
  hand(e, rows) {
    const hash = crypto.hash(e.entropy)
    let opened = false
    for (const row of rows) {
      if (!row.aside || !row.writer || row.stamp !== e.stamp || !row.commit) continue
      const at = spot(row.writer, row.stamp)
      if (this._open.has(at) || !b4a.equals(hash, row.commit)) continue
      this._spots.add(at)
      this._aside.delete(at)
      this._open.set(at, e.entropy)
      opened = true
    }
    return opened
  }

  /** @private */
  _opens(at, row) {
    const entropy = this._unseal(row)
    if (entropy) this._open.set(at, entropy)
    return entropy
  }

  /** @private */
  _remember(at) {
    this._met.delete(at)
    this._met.add(at)
    if (this._met.size > MET) this._met.delete(this._met.values().next().value)
  }

  /**
   * A secret handed over before its announcement landed here: kept, and checked against the
   * commitment when it does.
   *
   * @param {{ epoch: number, stamp: number, entropy: Uint8Array }} e
   * @param {string} [from]  The device that sent it: each sender has slots of its own.
   */
  keep(e, from = '') {
    // a seated device can hand this one anything: bounded per sender, and a forged one never
    // pushes out the real one
    for (const [sender, kept] of this._kept) {
      for (const stamp of kept.keys()) if (this.db.keyring.entropy(stamp)) kept.delete(stamp)
      if (kept.size === 0) this._kept.delete(sender)
    }
    if (this.db.keyring.entropy(e.stamp)) return
    const kept = this._kept.get(from) ?? new Map()
    const list = kept.get(e.stamp) ?? []
    if (list.length >= CANDIDATES) return
    kept.set(e.stamp, [...list, e.entropy])
    if (kept.size > STAMPS) kept.delete(kept.keys().next().value)
    this._kept.set(from, kept)
  }

  /** @private */
  _handed(row) {
    const candidates = []
    for (const [sender, kept] of this._kept) {
      candidates.push(...(kept.get(row.stamp) ?? []))
      kept.delete(row.stamp)
      if (kept.size === 0) this._kept.delete(sender)
    }
    if (!row.commit) return null
    return candidates.find((entropy) => b4a.equals(crypto.hash(entropy), row.commit)) ?? null
  }

  /**
   * @returns {Promise<boolean>} Whether the log's newest key is one this device cannot open.
   */
  async lacks() {
    const top = newest(await this._epochs())
    return top !== null && !this.held(top)
  }

  /**
   * Safety net after boot: an epoch applied but never saved, e.g. a crash between a
   * rotation's append and its save, is learned from the epochs collection.
   */
  async hydrate() {
    try {
      for (const row of await this._epochs()) {
        if (row.aside || !this.held(row)) await this.learn(row)
      }
    } catch {
      // rows past our newest epoch hydrate via apply
    }
  }

  /**
   * The secret held for a row, if it meets the row's commitment.
   *
   * @param {{ stamp: number, commit: Uint8Array }} row
   * @returns {Uint8Array | null}
   */
  held(row) {
    const entropy = this.db.keyring.entropy(row.stamp)
    return entropy && row.commit && b4a.equals(crypto.hash(entropy), row.commit) ? entropy : null
  }

  /**
   * Write under the newest landed epoch whose secret this device holds, so a rotation a reorder
   * dropped is never written under.
   *
   * @param {object} [view]
   */
  async pick(view = this.db.view) {
    const rows = await view.find(`@${this.db.ns}/epochs`, {}).toArray()
    // a stamp this device set aside under reads its blocks with that key, so it never writes under
    // a counted one sharing it
    const me = this.db.writerKey
    const mine = (r) => r.aside && r.writer && b4a.equals(r.writer, me)
    const taken = new Set(rows.filter(mine).map((r) => r.stamp))
    let top = null
    for (const row of rows) {
      if (row.aside || taken.has(row.stamp) || !this.held(row)) continue
      if (!top || row.epoch > top.epoch) top = row
    }
    this.db.keyring.current = top ? top.stamp : 0
    this.db.keyring.seq = top ? top.epoch : 0
  }

  /** Debounced key check, with the owner's raise beside it, run at open and after every update. */
  heal() {
    const db = this.db
    if (this._timer || db.closing || db.closed) return
    this._timer = setTimeout(() => {
      this._timer = null
      // one its database closed under says nothing: it runs again at the next open
      const fail = (err) => db.closing || db.closed || db._onerror(err)
      this._audit().catch(fail)
      db._raise().catch(fail)
    }, 500)
  }

  /** @private */
  async _carry(ops) {
    const db = this.db
    let done = null
    this.carrying = new Promise((resolve) => (done = resolve))
    try {
      // a write on its way goes in first
      await Promise.allSettled(db._writes)
      const devices = await this._staying(ops)
      const stamp = await db._write(ops, true)
      if (!devices || stamp === undefined) return stamp
      try {
        // the promised are read now: the removal took those that stood on what it removed
        await this._rotate(false, [...devices, ...(await this._promised())])
      } catch (err) {
        // the removal is in: the key check rotates. Behind, it says nothing, as that check does
        if (!db.closing && !db.closed && db.behind === null) db._onerror(err)
        this.heal()
      }
      return stamp
    } finally {
      this.carrying = null
      done()
    }
  }

  // the devices a removal leaves, read before it is appended, or null when this device carries no
  // rotation: its own seat goes, or its member may not remove
  /** @private */
  async _staying(ops) {
    const db = this.db
    const { data: devices } = await db.get('devices')
    const gone = new Set(ops.flatMap(([op, data]) => SEATS.get(op)?.(data, devices) ?? []))
    const me = devices.find((d) => d.id === hid.encode(db.writerKey))
    if (!me || gone.has(me.id)) return null
    const { data: member } = await db.get('members', me.memberId)
    if (!can(member?.role, REMOVE)) return null
    return devices.filter((d) => d.key && !gone.has(d.id))
  }

  /** @private */
  async _rotate(retried, devices) {
    const db = this.db
    db.guard()
    if (!db.writable) throw CeroError.NOT_WRITABLE('Database')
    // manifest v1 blocks carry no key id, rotating there is a silent downgrade
    if (db.bee.local.manifest?.version < 2) {
      throw CeroError.INVALID('rotation requires manifest v2 cores')
    }
    // apply sets one aside, never the key: only a reorder may make one
    const { data: me } = await db.get('devices', hid.encode(db.writerKey))
    const member = me?.memberId ? (await db.get('members', me.memberId)).data : null
    if (!can(member?.role, REMOVE)) {
      throw CeroError.REFUSED('rotate', 'rotate requires the remove permission')
    }
    // claimed synchronously; the keyring learns the secret only after the announcement flushed
    const entropy = Identity.randomBytes(32)
    const stamp = this._mint()
    this.current = { entropy, stamp, epoch: 0 }
    try {
      const wrapped = seal(devices || (await this._devices()), entropy)
      const epoch = await this._announce(stamp, entropy, wrapped)
      if (!epoch) {
        // a stamp collision (~2^-32, or an adversarial pre-claim) is not a refusal
        if (!retried && (await this._taken(stamp))) {
          this.current = null
          return this._rotate(true, devices)
        }
        // permission is refused before the append, so the dry-run missed something
        throw CeroError.INVALID('rotation was not applied')
      }
      db.keyring.add(stamp, entropy, epoch)
      await this.pick()
      await this._save()
      db.emit('epoch')
      return { epoch }
    } finally {
      this.current = null
    }
  }

  // every seated device, readers' too: a member keeps reading on each of its devices. And every
  // device promised a seat: let in before a rotation, it reads on once it has taken it
  /** @private */
  async _devices() {
    const { data: devices } = await this.db.get('devices')
    const keyed = devices.filter((d) => d.key)
    if (keyed.length === 0) throw CeroError.INVALID('cannot rotate a database with no devices')
    return [...keyed, ...(await this._promised())]
  }

  /** @private */
  async _promised() {
    const { data: requests } = await this.db.get('requests')
    const promised = []
    for (const row of requests) if (await this._stands(row)) promised.push(row)
    return promised
  }

  // a promise stands while its invite lasts and no device key it stands on is one removed
  /** @private */
  async _stands(row) {
    if (!row.promised || (row.expires > 0 && Date.now() > row.expires)) return false
    for (const key of chainOf(row)) {
      if (await this.db.view.get(`@${this.db.ns}/removals`, { id: hid.encode(key) })) return false
    }
    return true
  }

  // resolves the sequence apply assigned, 0 if it never applied
  /** @private */
  async _announce(stamp, entropy, wrapped) {
    const { bee } = this.db
    const from = bee.local.length
    const op = {
      epoch: 0, // sequence assigned deterministically at apply time
      stamp,
      wrapped: c.encode(wraps, wrapped),
      createdAt: Date.now(),
      commit: crypto.hash(entropy)
    }
    await this.db._write([['rotate-key', op]], true)
    await bee.update()
    // a block appended during a rotation must not carry the stamp it announces
    for (let i = from; i < bee.local.length; i++) {
      if (stampOf(await bee.local.get(i, { raw: true })) === stamp) {
        throw CeroError.INVALID('announcement encrypted under its own epoch — aborting rotation')
      }
    }
    return this.current.epoch
  }

  // a fresh nonzero stamp no known epoch uses
  /** @private */
  _mint() {
    for (;;) {
      const stamp = b4a.readUInt32LE(Identity.randomBytes(4), 0)
      if (stamp !== 0 && !this.db.keyring.entropy(stamp)) return stamp
    }
  }

  /** @private */
  async _taken(stamp) {
    return (await this._epochs()).some((r) => r.stamp === stamp)
  }

  /** @private */
  _epochs() {
    return this.db.view.find(`@${this.db.ns}/epochs`, {}).toArray()
  }

  // every envelope addressed to us is tried, a bad one must not lock us out
  /** @private */
  _unseal(row) {
    const { identity, writerKey } = this.db
    for (const entropy of opened(identity, hid.encode(writerKey), row.wrapped)) {
      if (entropy.byteLength !== 32) continue
      // a secret failing the row's commitment means the rotator sealed different ones
      if (row.commit && b4a.equals(crypto.hash(entropy), row.commit)) return entropy
      this.db._onerror(CeroError.INVALID(`epoch ${row.epoch} envelope fails its commitment`))
    }
    return null
  }

  // known epoch secrets to local userData (device-only, never replicates)
  /** @private */
  _save() {
    const entries = c.encode(epochEntries, this.db.keyring.all())
    return this.db.bee.local.setUserData('cero/epochs', entries)
  }

  // a rotation seals for the rotator's view of the members; REMOVE-capable devices rotate
  // when the log owes one, someone taken out since the newest key may hold it, when the newest
  // key does not name a seated device, or when its envelope for them does not open: a rotator
  // must not seal anyone who could heal it out
  /** @private */
  async _audit() {
    if (!(await this._due())) return
    // decided again once it holds the queue: a removal carried meanwhile brought its key
    await this._queued(async () => {
      const state = await this._due()
      if (!state) return
      this._healedFor = state
      await this._rotate(false)
    })
  }

  // the (epoch, devices) state a rotation is due for, one attempt each: a failing rotate must
  // not loop
  /** @private */
  async _due() {
    const state = await this._drift()
    return state === this._healedFor ? null : state
  }

  /** @private */
  async _drift() {
    const db = this.db
    // behind, the membership this device sees is stale: the devices that read everything rotate
    if (db.closing || db.closed || this.current || db.behind !== null) return null
    const { data: device } = await db.get('devices', hid.encode(db.writerKey))
    const me = device?.memberId ? (await db.get('members', device.memberId)).data : null
    const top = newest(await this._epochs())
    if (me) await this._ask(top)
    if (!db.writable || !can(me?.role, REMOVE)) return null

    const sealedOut = top !== null && !db.keyring.entropy(top.stamp)
    const owed = await db.view.get(`@${db.ns}/${COUNTERS}`, { name: OWED })
    if (!sealedOut && !owed?.value && !(top && (await this._unnamed(top)))) {
      this._healedFor = null
      return null
    }
    const ids = (await this._devices()).map((d) => d.id)
    return `${top?.stamp ?? 0}:${ids.sort().join(',')}`
  }

  // a device that cannot open the newest key, or holds none, asks for them from its own core. Its
  // row stands until it closes it: asking again changes nothing, and appends nothing
  /** @private */
  async _ask(top) {
    const db = this.db
    if (top === null || this.held(top)) return
    const since = db.meta.since?.routes?.[`@${db.ns}/ask-key`]
    if (!(since <= (await db.dispatcher.version(db.view)))) return
    const reply = keyPair(db.keyPair.secretKey).publicKey
    await db._write([['ask-key', { id: hid.encode(db.writerKey), reply }]])
  }

  // a seated device of a member who stands that the newest key does not name: its join crossed
  // a rotation, or a removal that sealed it out was refused
  /** @private */
  async _unnamed(top) {
    const named = new Set(c.decode(wraps, top.wrapped).map((w) => w.id))
    const { data: members } = await this.db.get('members')
    const standing = new Set(members.map((m) => m.id))
    const { data: devices } = await this.db.get('devices')
    return devices.some((d) => d.key && standing.has(d.memberId) && !named.has(d.id))
  }
}

// the seats an op takes out: a device by its row or by its writer, a member's every device
const SEATS = new Map([
  ['del-device', (op) => [op.id]],
  ['del-writer', (op) => [hid.encode(op.writer)]],
  ['del-member', (op, devices) => devices.filter((d) => d.memberId === op.id).map((d) => d.id)]
])

/**
 * @param {Array<[string, unknown]>} ops
 * @returns {boolean} Whether a batch takes a member or a device out.
 */
export function removes(ops) {
  return ops.some(([op]) => SEATS.has(op))
}

function newest(rows) {
  const counted = rows.filter((r) => !r.aside)
  return counted.length ? counted.reduce((a, b) => (b.epoch > a.epoch ? b : a)) : null
}

function spot(writer, stamp) {
  return `${b4a.toString(writer, 'hex')}:${stamp}`
}

// the epoch stamp autobee's encryption writes into every block header
function stampOf(raw) {
  return b4a.readUInt32LE(raw, 4)
}
