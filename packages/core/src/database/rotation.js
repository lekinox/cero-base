import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import hid from 'hypercore-id-encoding'

import { REMOVE } from '../lib/constants.js'
import { can } from '../lib/utils.js'
import { wraps, epochEntries } from './encryption.js'
import { Identity } from '../identity/index.js'
import { CeroError } from '../lib/errors.js'

/**
 * Epoch key rotation for a database: mint a secret, seal it to every member, announce it
 * through the log, and on every peer learn the secrets addressed to it.
 */
export class Rotation {
  /** @param {import('./index.js').Database} db */
  constructor(db) {
    this.db = db
    this.current = null
    this._timer = null
    this._healedFor = null
  }

  close() {
    clearTimeout(this._timer)
    this._timer = null
  }

  /** @returns {Promise<{ epoch: number }>} */
  rotate() {
    return this._rotate(false)
  }

  /**
   * An applied rotation announcement: open our envelope, learn the secret, persist it.
   *
   * @param {{ epoch: number, stamp: number, wrapped: Uint8Array, commit: Uint8Array }} row
   */
  async learn(row) {
    const { keyring } = this.db
    const known = keyring.entropy(row.stamp)
    const entropy = known || this._unseal(row)
    if (known) {
      keyring.add(row.stamp, known, row.epoch) // re-applied, the sequence may be news
    } else if (this.current && entropy && b4a.equals(entropy, this.current.entropy)) {
      this.current.epoch = row.epoch
    } else if (entropy) {
      keyring.add(row.stamp, entropy, row.epoch)
      try {
        await this._save()
      } catch (err) {
        // an epoch we cannot reload after a restart must not be used for writes
        keyring.remove(row.stamp)
        this.db._onerror(err)
      }
    }
    this.heal()
  }

  /**
   * Safety net after boot: an epoch applied but never saved, e.g. a crash between a
   * rotation's append and its save, is learned from the epochs collection.
   */
  async hydrate() {
    try {
      for (const row of await this._epochs()) {
        if (!this.db.keyring.entropy(row.stamp)) await this.learn(row)
      }
    } catch {
      // rows past our newest epoch hydrate via apply
    }
  }

  /** Debounced audit, run after every update. */
  heal() {
    const db = this.db
    if (this._timer || db.closing || db.closed) return
    this._timer = setTimeout(() => {
      this._timer = null
      this._audit().catch(db._onerror)
    }, 500)
  }

  async _rotate(retried) {
    const db = this.db
    db.guard()
    if (!db.writable) throw CeroError.NOT_WRITABLE('Database')
    if (this.current) throw CeroError.INVALID('a rotation is already in progress')
    // manifest v1 blocks carry no key id, rotating there is a silent downgrade
    if (db.bee.local.manifest?.version < 2) {
      throw CeroError.INVALID('rotation requires manifest v2 cores')
    }
    // claimed synchronously; the keyring learns the secret only after the announcement flushed
    const entropy = Identity.randomBytes(32)
    const stamp = this._mint()
    this.current = { entropy, stamp, epoch: 0 }
    try {
      const wrapped = this._seal(await this._members(), entropy)
      const epoch = await this._announce(stamp, entropy, wrapped)
      if (!epoch) {
        // a stamp collision (~2^-32, or an adversarial pre-claim) is not a refusal
        if (!retried && (await this._taken(stamp))) {
          this.current = null
          return this._rotate(true)
        }
        // permission is refused before the append, so the dry-run missed something
        throw CeroError.INVALID('rotation was not applied')
      }
      db.keyring.add(stamp, entropy, epoch)
      await this._save()
      return { epoch }
    } finally {
      this.current = null
    }
  }

  async _members() {
    const { data: members } = await this.db.get('members')
    if (!Array.isArray(members) || members.length === 0) {
      throw CeroError.INVALID('cannot rotate a database with no members')
    }
    return members
  }

  // one sealed copy of the secret per member, addressed by member id
  _seal(members, entropy) {
    return members.map((m) => {
      let key
      try {
        key = hid.decode(m.id)
      } catch {
        throw CeroError.INVALID(`member id is not an identity key: ${m.id}`)
      }
      return { id: m.id, box: Identity.seal(key, entropy) }
    })
  }

  // resolves the sequence apply assigned, 0 if it never applied
  async _announce(stamp, entropy, wrapped) {
    const { bee } = this.db
    const from = bee.local.length
    await this.db.call('rotate-key', {
      epoch: 0, // sequence assigned deterministically at apply time
      stamp,
      wrapped: c.encode(wraps, wrapped),
      createdAt: Date.now(),
      commit: crypto.hash(entropy)
    })
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
  _mint() {
    for (;;) {
      const stamp = b4a.readUInt32LE(Identity.randomBytes(4), 0)
      if (stamp !== 0 && !this.db.keyring.entropy(stamp)) return stamp
    }
  }

  async _taken(stamp) {
    return (await this._epochs()).some((r) => r.stamp === stamp)
  }

  _epochs() {
    return this.db.view.find(`@${this.db.ns}/epochs`, {}).toArray()
  }

  // every envelope addressed to us is tried, a bad one must not lock us out
  _unseal(row) {
    const { identity } = this.db
    for (const w of c.decode(wraps, row.wrapped)) {
      if (w.id !== identity.id) continue
      const entropy = identity.unseal(w.box)
      if (entropy?.byteLength !== 32) continue
      // a secret failing the row's commitment means the rotator sealed different ones
      if (row.commit && b4a.equals(crypto.hash(entropy), row.commit)) return entropy
      this.db._onerror(CeroError.INVALID(`epoch ${row.epoch} envelope fails its commitment`))
    }
    return null
  }

  // known epoch secrets to local userData (device-only, never replicates)
  _save() {
    const entries = c.encode(epochEntries, this.db.keyring.all())
    return this.db.bee.local.setUserData('cero/epochs', entries)
  }

  // a rotation seals for the rotator's view of the members; REMOVE-capable devices re-key
  // when the current epoch's recipients drift from the member list
  async _audit() {
    const db = this.db
    if (db.closing || db.closed || !db.writable || this.current || !db.keyring.current) return
    const { data: device } = await db.get('devices', hid.encode(db.writerKey))
    const me = device?.memberId ? (await db.get('members', device.memberId)).data : null
    if (!can(me?.role, REMOVE)) return

    const rows = await this._epochs()
    if (!rows.length) return
    const top = rows.reduce((a, b) => (b.epoch > a.epoch ? b : a))
    const recipients = new Set(c.decode(wraps, top.wrapped).map((w) => w.id))
    const { data: members } = await db.get('members')
    const ids = new Set(members.map((m) => m.id))
    if (recipients.size === ids.size && [...recipients].every((id) => ids.has(id))) {
      this._healedFor = null
      return
    }
    // one attempt per (epoch, membership) state, a failing rotate must not loop
    const state = `${top.stamp}:${[...ids].sort().join(',')}`
    if (this._healedFor === state) return
    this._healedFor = state
    await this.rotate()
  }
}

// the epoch stamp autobee-encryption writes into every block header
function stampOf(raw) {
  return b4a.readUInt32LE(raw, 4)
}
