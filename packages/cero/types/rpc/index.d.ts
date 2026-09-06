/**
 * RPC barrel — re-exports the `Server`/`Client` classes and their `serve()`/`connect()`
 * helpers so consumers can spin up either side of the cero IPC bridge from a single
 * import.
 */
export { Server, serve } from './server.js';
export { Client, connect } from './client.js';
