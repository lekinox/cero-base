import { RPCPeer } from './peer.js'

/**
 * Client-side RPC adapter — issues requests over the framed IPC stream.
 * All wiring lives in {@link RPCPeer}; this is the client-named role.
 */
export class RPCClient extends RPCPeer {}
