import safetyCatch from 'safety-catch'
import c from 'compact-encoding'

import { channelTopic } from '../network/index.js'
import { CeroError } from '../lib/errors.js'
import { Response, STATUS_DENIED } from './request.js'

/**
 * Internal — the joiner side: a candidate's handshake state machine (this *is* the
 * blind-pairing `addCandidate`).
 *
 * @property {any} _candidate                         blind-pairing addCandidate handle (null until started).
 * @property {ReturnType<typeof setTimeout> | null} _timer   Pending timeout, if any.
 * @property {((result: any) => void) | null} _resolve   Promise resolver, set in `start`.
 * @property {((err: Error) => void) | null} _reject           Promise rejecter, set in `start`.
 * @property {boolean} _settled                       Whether the handshake has already settled.
 */
export class Candidate {
  /**
   * @param {import('./index.js').Pairing} pairing
   * @param {import('./invite.js').Invite} invite
   * @param {Uint8Array | null} userData
   * @param {number} timeout
   */
  constructor(pairing, invite, userData, timeout) {
    this.pairing = pairing
    this.invite = invite
    this.userData = userData
    this.timeout = timeout
    this._candidate = null
    this._timer = null
    this._resolve = null
    this._reject = null
    this._settled = false
  }

  /**
   * Kick off the handshake; returns a promise that settles with the host response.
   *
   * @returns {Promise<import('./index.js').JoinResult>}
   */
  start() {
    this.pairing._candidates.add(this)

    return new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject

      if (this.timeout > 0) {
        this._timer = setTimeout(() => this._fail(CeroError.TIMEOUT()), this.timeout)
      }

      try {
        this._candidate = this.pairing._blind.addCandidate({
          invite: this.invite.blind,
          userData: this.userData,
          // must hash exactly like the member side — see Pairing._open
          discoveryKey: channelTopic(this.invite.discoveryKey, this.pairing.network.channel),
          onadd: (result) => this._done(result)
        })
        this._candidate.request.on('rejected', (err) => this._fail(fromBlindError(err)))
        this.pairing.network.refreshInjected().catch(this._onerror ?? (() => {}))
      } catch (err) {
        this._fail(err instanceof CeroError ? err : CeroError.NETWORK_ERROR(err.message))
      }
    })
  }

  _done(result) {
    if (this._settled) return

    let envelope = null
    try {
      if (result?.data) envelope = c.decode(Response, result.data)
    } catch {}

    if (envelope && envelope.status === STATUS_DENIED) {
      this._fail(CeroError.DENIED(envelope.reason || null))
      return
    }

    if (!envelope) {
      this._fail(CeroError.NETWORK_ERROR('malformed pairing response'))
      return
    }

    this._settled = true
    this.pairing._candidates.delete(this)
    clearTimeout(this._timer)

    this._resolve({
      key: envelope.key,
      encryptionKey: envelope.encryptionKey,
      additional: envelope.extra
    })

    this._candidate.close().catch(safetyCatch)
  }

  _fail(err) {
    if (this._settled) return
    this._settled = true
    this.pairing._candidates.delete(this)
    clearTimeout(this._timer)
    if (this._candidate) this._candidate.close().catch(safetyCatch)
    this._reject(err)
  }
}

function fromBlindError(err) {
  // a code-less rejection is a protocol failure, never a host decision
  if (!err || !err.code) return CeroError.NETWORK_ERROR(err?.message || 'pairing failed')
  switch (err.code) {
    case 'INVITE_EXPIRED':
      return CeroError.EXPIRED(err.message)
    case 'INVITE_USED':
      return CeroError.DENIED('used', err.message)
    case 'PAIRING_REJECTED':
      return CeroError.DENIED(null, err.message)
    default:
      return CeroError.DENIED(err.message)
  }
}
