/**
 * Canonical error class. Every instance carries a stable `code` field which is also
 * prefixed to the message, so logs stay self-identifying.
 */
export declare class CeroError extends Error {
    isCeroError: boolean;
    code: string;
    /**
     * @param {string} code            Stable identifier (e.g. `REQUIRED`, `EXPIRED`).
     * @param {string} [message]       Human-readable detail; appended after the code.
     * @param {Record<string, unknown> | null} [extras]  Extra fields copied onto the instance.
     */
    constructor(code: string, message?: string, extras?: Record<string, unknown> | null);
    get name(): string;
    /**
     * Type-guard for `err instanceof CeroError` that survives realm boundaries.
     *
     * @param {any} err
     * @returns {err is CeroError}
     */
    static isCeroError(err: any): err is CeroError;
    /**
     * Missing required argument.
     *
     * @param {string} name
     */
    static REQUIRED(name: string): CeroError;
    /**
     * Argument failed validation.
     *
     * @param {string} msg
     */
    static INVALID(msg: string): CeroError;
    /**
     * Operation on a closed resource.
     *
     * @param {string} resource
     */
    static CLOSED(resource: string): CeroError;
    /**
     * A channel-stamped storage was opened under a different channel.
     */
    static CHANNEL_MISMATCH(): CeroError;
    /**
     * Operation before `ready()` resolved.
     *
     * @param {string} resource
     * @param {string} name
     */
    static NOT_READY(resource: string, name: string): CeroError;
    /**
     * Operation raced an existing state (e.g. double init).
     *
     * @param {string} msg
     */
    static CONFLICT(msg: string): CeroError;
    /**
     * Resource has been destroyed.
     *
     * @param {string} resource
     */
    static DESTROYED(resource: string): CeroError;
    /**
     * Lookup failed for a typed id.
     *
     * @param {string} kind
     * @param {string} id
     */
    static UNKNOWN(kind: string, id: string): CeroError;
    /**
     * Write attempted on a read-only handle.
     *
     * @param {string} resource
     */
    static NOT_WRITABLE(resource: string): CeroError;
    /**
     * Async operation exceeded its deadline.
     *
     * @param {string} what
     */
    static TIMED_OUT(what: string): CeroError;
    /**
     * Feature is not yet implemented.
     *
     * @param {string} what
     */
    static UNSUPPORTED(what: string): CeroError;
    /**
     * Invite payload failed to parse or verify.
     *
     * @param {string} [msg]
     */
    static INVALID_INVITE(msg?: string): CeroError;
    /**
     * Invite is past its TTL.
     *
     * @param {string} [msg]
     */
    static EXPIRED(msg?: string): CeroError;
    /**
     * Host refused the join — `reason` is exposed on the instance.
     *
     * @param {string | null} [reason]
     * @param {string} [msg]
     */
    static DENIED(reason?: string | null, msg?: string): CeroError;
    /**
     * An apply-time rule refused the op. Every peer reaches this verdict from the same node
     * and the same view, so it aborts the writer's whole batch — which is what makes a
     * transaction atomic.
     *
     * @param {string} rule  Which rule refused, e.g. 'write' or 'own'.
     * @param {string} [msg]
     */
    static REFUSED(rule: string, msg?: string): CeroError;
    /**
     * Pairing handshake did not complete in time.
     *
     * @param {string} [msg]
     */
    static TIMEOUT(msg?: string): CeroError;
    /**
     * Underlying swarm/transport failure.
     *
     * @param {string} [msg]
     */
    static NETWORK_ERROR(msg?: string): CeroError;
    /**
     * A block references a rotation epoch this peer hasn't learned yet —
     * resolves once the announcement carrying the epoch secret syncs in.
     *
     * @param {number} epoch
     */
    static UNKNOWN_EPOCH(epoch: number): CeroError;
}
