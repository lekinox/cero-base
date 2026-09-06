/**
 * Length-prefixed JSON framing over a Duplex `stream`. Buffers incoming chunks
 * and delivers each decoded frame to `onMessage`; `send` writes a framed frame.
 */
export declare class Framed {
    stream: any;
    onMessage: any;
    buf: any;
    constructor(stream: any, onMessage: any);
    /**
     * Encode `obj` to wire form and write it as one length-prefixed frame.
     * @param {object} obj - message to send
     * @returns {void}
     */
    send(obj: object): void;
    _ondata(chunk: any): void;
}
