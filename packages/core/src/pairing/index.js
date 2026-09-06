import BlindPairing from 'blind-pairing'
import ReadyResource from 'ready-resource'
import safetyCatch from 'safety-catch'
import b4a from 'b4a'
import c from 'compact-encoding'
import { discoveryKey } from 'hypercore-crypto'

import { Invite } from './invite.js'
import { Candidate } from './candidate.js'
import { Request } from './request.js'
import { channelTopic } from '../network/index.js'
import { CeroError } from '../lib/errors.js'

/**
 * @typedef {object} PairingOpts
 * @property {import('../network/index.js').Network} network         Network to host the BlindPairing member.
 * @property {import('../identity/index.js').Identity} identity      Identity used to sign invites and derive the topic.
 * @property {Uint8Array} [topic]                                    Optional override topic; defaults to `identity.publicKey`.
 * @property {boolean} [host]                                        Register the member listener that serves invites (default `true`). Join-only pairings pass `false` — a listener is one-per-topic, so a joiner registering one collides with any concurrent join.
 * @property {any} [inviteEncoding]                                  compact-encoding type for the invite payload `data`.
 * @property {any} [joinerEncoding]                                  compact-encoding type for the joiner-supplied `userData`.
 * @property {(err: Error) => void} [onerror]                        Called when a background candidate fails to process.
 *
 * @typedef {object} CreateInviteOpts
 * @property {string} [role]                                         Role tag bound into the invite.
 * @property {number} [expiresIn]                                    TTL in ms; `0`/omitted = no expiry.
 * @property {any} [data]                                            Arbitrary payload (encoded via `inviteEncoding` when set).
 * @property {boolean} [reuse]                                       Reusable until expiry/revoke; default `false` (consumed on first settle).
 *
 * @typedef {object} JoinOpts
 * @property {any} userData                                          Payload sent with the candidate request. Required: blind-pairing derives the handshake token from it, so a candidate without one is never served.
 * @property {number} [timeout]                                      Deadline for the handshake, in ms. Defaults to 30000.
 *
 * @typedef {{ key: Uint8Array, encryptionKey: Uint8Array | null, additional: Uint8Array | null }} JoinResult
 */

/**
 * Blind-pairing membership wrapper. Hosts invites, dispatches incoming candidates to the
 * application for accept/deny, and provides the joiner side of the handshake.
 */
export class Pairing extends ReadyResource {
  /** @param {PairingOpts} [opts] */
  constructor({
    network,
    identity,
    topic,
    host = true,
    inviteEncoding = null,
    joinerEncoding = null,
    onerror = safetyCatch,
    onconsume = null
  } = {}) {
    super()
    if (!network) throw CeroError.REQUIRED('network')
    if (!identity) throw CeroError.REQUIRED('identity')

    this.network = network
    this.identity = identity
    this.topic = topic || identity.publicKey
    this.host = host
    this.inviteEncoding = inviteEncoding
    this.joinerEncoding = joinerEncoding
    this._onerror = onerror
    // fired when this instance stops serving an invite, so the owner drops its row
    this.onconsume = onconsume

    this._blind = null
    this._member = null
    this._invites = new Map() // inviteId.hex → record
    this._candidates = new Set() // active joiner candidates
  }

  /**
   * Whether the underlying blind-pairing layer is suspended.
   *
   * @returns {boolean}
   */
  get suspended() {
    return this._blind?.suspended === true
  }

  async _open() {
    await this.network.ready()
    // shared instance — one set of swarm/DHT listeners for every handle
    this._blind = await this.network.blind()

    // blind-pairing allows one member listener per discovery key
    if (this.host) {
      this._member = this._blind.addMember({
        // channel-scoped; the candidate hashes identically (no channel → identity)
        discoveryKey: channelTopic(discoveryKey(this.topic), this.network.channel),
        onadd: (req) => this._oncandidate(req).catch(this._onerror)
      })
    }
    await this.network.refreshInjected()
  }

  async _close() {
    for (const candidate of [...this._candidates]) candidate._fail(CeroError.CLOSED('Pairing'))
    this._candidates.clear()

    if (this._member) {
      await this._member.close()
      this._member = null
    }
    // the BlindPairing is network-owned and shared — never close it here
    this._blind = null
    this._invites.clear()
  }

  /**
   * Mint a new pairing invite. Returns its canonical wire form (z32 string).
   *
   * @param {CreateInviteOpts} [opts]
   * @returns {Promise<string>}
   */
  async createInvite({ role = '', expiresIn = 0, data = null, reuse = false } = {}) {
    if (this.closing || this.closed) throw CeroError.CLOSED('Pairing')
    // a join-only pairing serves no invites
    if (!this.host) throw CeroError.INVALID('cannot create invites on a join-only Pairing')
    if (!this.opened) await this.ready()

    // the rendezvous key matches the member topic
    const blind = BlindPairing.createInvite(this.topic)

    const invite = Invite.create({
      secretKey: this.identity.secretKey,
      publicKey: this.identity.publicKey,
      role,
      expiresIn,
      data,
      blind: blind.invite,
      encoding: this.inviteEncoding
    })

    const id = b4a.toString(blind.id, 'hex')
    this._invites.set(id, {
      id: blind.id,
      seed: blind.seed,
      publicKey: blind.publicKey,
      invite,
      reuse,
      // minted here, maybe not persisted yet: syncRows must keep it
      local: true
    })

    return invite.toString()
  }

  /**
   * Look up the in-memory record for a minted invite by its string form.
   *
   * @param {string} inviteStr
   * @returns {{ id: Uint8Array, seed: Uint8Array, publicKey: Uint8Array, invite: import('./invite.js').Invite, reuse: boolean } | null}
   */
  recordOf(inviteStr) {
    for (const record of this._invites.values()) {
      if (record.invite.toString() === inviteStr) return record
    }
    return null
  }

  /**
   * Reconcile the served-invite set with persisted rows (the room's `invites` collection).
   *
   * @param {Array<{ id: string, invite: Uint8Array, publicKey: Uint8Array, seed: Uint8Array, reuse?: boolean }>} rows
   */
  syncRows(rows) {
    const seen = new Set()
    for (const row of rows) {
      if (!row?.id || !row.invite || !row.publicKey || !row.seed) continue
      seen.add(row.id)
      const existing = this._invites.get(row.id)
      if (existing) {
        existing.local = false
        continue
      }
      let invite
      try {
        invite = Invite.parse(b4a.toString(row.invite))
      } catch {
        continue
      }
      if (invite.expired) continue
      this._invites.set(row.id, {
        id: b4a.from(row.id, 'hex'),
        seed: row.seed,
        publicKey: row.publicKey,
        invite,
        reuse: !!row.reuse,
        local: false
      })
    }
    for (const [id, record] of this._invites) {
      if (!seen.has(id) && !record.local) this._invites.delete(id)
    }
  }

  /**
   * Forget a previously-minted invite. New candidates carrying it will be
   * dropped silently.
   *
   * @param {string} inviteStr
   * @returns {boolean}
   */
  revoke(inviteStr) {
    for (const [id, record] of this._invites) {
      if (record.invite.toString() === inviteStr) {
        this._invites.delete(id)
        return true
      }
    }
    return false
  }

  /**
   * Joiner side — start a pairing handshake against `inviteStr` and resolve
   * with the host's response when the host confirms.
   *
   * @param {string} inviteStr
   * @param {JoinOpts} [opts]
   * @returns {Promise<JoinResult>}
   */
  async join(inviteStr, { userData, timeout = 30000 } = {}) {
    if (this.closing || this.closed) throw CeroError.CLOSED('Pairing')
    if (!this.opened) await this.ready()

    let invite
    try {
      invite = Invite.parse(inviteStr, { encoding: this.inviteEncoding })
    } catch (err) {
      if (err instanceof CeroError) throw err
      throw CeroError.INVALID_INVITE(err.message)
    }

    if (invite.expired) throw CeroError.EXPIRED()

    const data = encodeUserData(userData, this.joinerEncoding)
    const candidate = new Candidate(this, invite, data, timeout)
    return candidate.start()
  }

  /**
   * Pause blind-pairing — keeps state, drops sockets. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async suspend() {
    if (!this._blind || this.closing || this.closed) return
    if (this._blind.suspended) return
    try {
      await this._blind.suspend()
    } catch (err) {
      safetyCatch(err)
    }
  }

  /**
   * Resume a suspended blind-pairing layer. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async resume() {
    if (!this._blind || this.closing || this.closed) return
    if (!this._blind.suspended) return
    try {
      await this._blind.resume()
    } catch (err) {
      safetyCatch(err)
    }
  }

  async _oncandidate(req) {
    const id = b4a.toString(req.inviteId, 'hex')
    const record = this._invites.get(id)
    if (!record) return
    if (record.invite.expired) {
      this._invites.delete(id)
      this.onconsume?.(id)
      return
    }

    try {
      req.open(record.publicKey)
    } catch (err) {
      safetyCatch(err)
      return
    }

    const userData = decodeUserData(req.userData, this.joinerEncoding)

    const request = new Request({
      pairing: this,
      req,
      invite: record.invite,
      seed: record.seed,
      userData,
      onsettle: () => {
        if (!record.reuse) {
          this._invites.delete(id)
          this.onconsume?.(id)
        }
      }
    })

    this.emit('candidate', request)
  }

  /**
   * Resolve the resource discovery key an invite targets — without pairing.
   *
   * @param {string} invite
   * @returns {Uint8Array | null}
   */
  static inviteTopic(invite) {
    try {
      return Invite.parse(invite).discoveryKey
    } catch {
      return null
    }
  }

  /**
   * Cheap structural test for a candidate invite string.
   *
   * @param {unknown} str
   * @returns {boolean}
   */
  static isInvite(str) {
    return Invite.isInvite(str)
  }
}

function encodeUserData(data, encoding) {
  if (data == null) throw CeroError.REQUIRED('userData')
  if (encoding) return c.encode(encoding, data)
  if (b4a.isBuffer(data)) return data
  throw CeroError.INVALID('userData must be a buffer when no joinerEncoding is provided')
}

function decodeUserData(buf, encoding) {
  if (!buf || buf.length === 0) return null
  if (!encoding) return buf
  try {
    return c.decode(encoding, buf)
  } catch {
    return buf
  }
}
