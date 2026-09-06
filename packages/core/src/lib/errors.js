/**
 * Canonical error class. Every instance carries a stable `code` field which is also
 * prefixed to the message, so logs stay self-identifying.
 */
export class CeroError extends Error {
  /**
   * @param {string} code            Stable identifier (e.g. `REQUIRED`, `EXPIRED`).
   * @param {string} [message]       Human-readable detail; appended after the code.
   * @param {Record<string, unknown> | null} [extras]  Extra fields copied onto the instance.
   */
  constructor(code, message, extras = null) {
    super(message ? `${code}: ${message}` : code)
    this.isCeroError = true
    this.code = code
    if (extras) Object.assign(this, extras)
    if (Error.captureStackTrace) Error.captureStackTrace(this, CeroError)
  }

  get name() {
    return 'CeroError'
  }

  /**
   * Type-guard for `err instanceof CeroError` that survives realm boundaries.
   *
   * @param {any} err
   * @returns {err is CeroError}
   */
  static isCeroError(err) {
    return err?.isCeroError === true
  }

  /**
   * Missing required argument.
   *
   * @param {string} name
   */
  static REQUIRED(name) {
    return new CeroError('REQUIRED', `${name} is required`)
  }
  /**
   * Argument failed validation.
   *
   * @param {string} msg
   */
  static INVALID(msg) {
    return new CeroError('INVALID', msg)
  }
  /**
   * Operation on a closed resource.
   *
   * @param {string} resource
   */
  static CLOSED(resource) {
    return new CeroError('CLOSED', `${resource} is closed`)
  }
  /**
   * A channel-stamped storage was opened under a different channel.
   */
  static CHANNEL_MISMATCH() {
    return new CeroError('CHANNEL_MISMATCH', 'storage belongs to a different channel')
  }
  /**
   * Operation before `ready()` resolved.
   *
   * @param {string} resource
   * @param {string} name
   */
  static NOT_READY(resource, name) {
    return new CeroError('NOT_READY', `${resource} is not ready — await ${name}.ready() first`)
  }
  /**
   * Operation raced an existing state (e.g. double init).
   *
   * @param {string} msg
   */
  static CONFLICT(msg) {
    return new CeroError('CONFLICT', msg)
  }
  /**
   * Resource has been destroyed.
   *
   * @param {string} resource
   */
  static DESTROYED(resource) {
    return new CeroError('DESTROYED', `${resource} is destroyed`)
  }
  /**
   * Lookup failed for a typed id.
   *
   * @param {string} kind
   * @param {string} id
   */
  static UNKNOWN(kind, id) {
    return new CeroError('UNKNOWN', `unknown ${kind}: ${id}`)
  }
  /**
   * Write attempted on a read-only handle.
   *
   * @param {string} resource
   */
  static NOT_WRITABLE(resource) {
    return new CeroError('NOT_WRITABLE', `${resource} is not writable`)
  }
  /**
   * Async operation exceeded its deadline.
   *
   * @param {string} what
   */
  static TIMED_OUT(what) {
    return new CeroError('TIMED_OUT', `${what} timed out`)
  }
  /**
   * Feature is not yet implemented.
   *
   * @param {string} what
   */
  static UNSUPPORTED(what) {
    return new CeroError('UNSUPPORTED', `${what} not yet supported`)
  }

  /**
   * Invite payload failed to parse or verify.
   *
   * @param {string} [msg]
   */
  static INVALID_INVITE(msg = 'invalid invite') {
    return new CeroError('INVALID_INVITE', msg)
  }
  /**
   * Invite is past its TTL.
   *
   * @param {string} [msg]
   */
  static EXPIRED(msg = 'invite expired') {
    return new CeroError('EXPIRED', msg)
  }
  /**
   * Host refused the join — `reason` is exposed on the instance.
   *
   * @param {string | null} [reason]
   * @param {string} [msg]
   */
  static DENIED(reason = null, msg = 'pairing denied') {
    return new CeroError('DENIED', msg, { reason })
  }
  /**
   * An apply-time rule refused the op. Every peer reaches this verdict from the same node
   * and the same view, so it aborts the writer's whole batch — which is what makes a
   * transaction atomic.
   *
   * @param {string} rule  Which rule refused, e.g. 'write' or 'own'.
   * @param {string} [msg]
   */
  static REFUSED(rule, msg = `refused by ${rule}`) {
    return new CeroError('REFUSED', msg, { rule })
  }
  /**
   * Pairing handshake did not complete in time.
   *
   * @param {string} [msg]
   */
  static TIMEOUT(msg = 'pairing timed out') {
    return new CeroError('TIMEOUT', msg)
  }
  /**
   * Underlying swarm/transport failure.
   *
   * @param {string} [msg]
   */
  static NETWORK_ERROR(msg = 'network error') {
    return new CeroError('NETWORK_ERROR', msg)
  }
  /**
   * A block references a rotation epoch this peer hasn't learned yet —
   * resolves once the announcement carrying the epoch secret syncs in.
   *
   * @param {number} epoch
   */
  static UNKNOWN_EPOCH(epoch) {
    return new CeroError('UNKNOWN_EPOCH', `unknown encryption epoch: ${epoch}`)
  }
}
