import { RPCPeer } from './peer.js'

/**
 * Server-side RPC adapter — serves the spec's handlers over the framed IPC
 * stream. All wiring lives in {@link RPCPeer}; this is the server-named role.
 */
export class RPCServer extends RPCPeer {}
