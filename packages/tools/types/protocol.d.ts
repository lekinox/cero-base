/**
 * Length-prefixed JSON framing over a Duplex `stream`. Buffers incoming chunks
 * and delivers each decoded frame to `onMessage`; `send` writes a framed frame.
 */
export declare class Framed {
    stream: import("streamx").Duplex<import("streamx").DuplexEvents>;
    onMessage: (msg: unknown) => void;
    buf: Uint8Array<ArrayBufferLike>;
    /**
     * @param {import('streamx').Duplex} stream
     * @param {(msg: unknown) => void} onMessage
     */
    constructor(stream: import('streamx').Duplex, onMessage: (msg: unknown) => void);
    /**
     * Encode `obj` to wire form and write it as one length-prefixed frame.
     * @param {object} obj - message to send
     * @returns {void}
     */
    send(obj: object): void;
    /** @private */
    private _ondata;
}
