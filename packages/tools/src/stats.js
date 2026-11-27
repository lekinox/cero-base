/**
 * Read-only snapshot of a handle's existing p2p/storage counters.
 * `cores` lists every open core in the handle's corestore, which a child shares with its root.
 *
 * @param {import('@cero-base/cero').Handle} handle  A cero root or child handle.
 * @param {number} [at]  Sample timestamp, stamped by the caller.
 * @returns {{ handleId: string, network: { connections: number, peers: number, dht: object | null }, bee: { local: number, stats: Record<string, number> | null }, cores: Array<{ length: number, byteLength: number, peers: number }>, at: number }}
 */
export function stats(handle, at = 0) {
  const net = handle.network
  const bee = handle.store?.bee

  const cores = []
  try {
    const map = handle.store?.store?.cores
    if (map) {
      // corestore tracks its open cores, not sessions: the counters sit on their state
      for (const core of map) {
        cores.push({
          length: core.state?.length ?? 0,
          byteLength: core.state?.byteLength ?? 0,
          peers: core.replicator?.peers?.length ?? 0
        })
      }
    }
  } catch {}

  let dht = null
  try {
    dht = net?.swarm?.dht?.stats ?? null
  } catch {}

  return {
    handleId: handle.id,
    network: {
      connections: net?.connections?.size ?? 0,
      peers: net?.peers?.size ?? 0,
      dht
    },
    bee: { local: bee?.local?.length ?? 0, stats: bee?.stats ?? null },
    cores,
    at
  }
}
