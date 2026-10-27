const { contextBridge, ipcRenderer } = require('electron')

// a sandboxed preload has no Buffer: bytes cross as Uint8Array
const decoder = new TextDecoder()

function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return new TextEncoder().encode(data)
  return new Uint8Array(0)
}

contextBridge.exposeInMainWorld('bridge', {
  pkg() {
    return ipcRenderer.sendSync('pkg')
  },
  isInitialized: () => ipcRenderer.invoke('pear:isInitialized'),
  startWorker: (specifier, extraArgs = []) =>
    ipcRenderer.invoke('pear:startWorker', specifier, extraArgs),
  writeWorkerIPC: (specifier, data) =>
    ipcRenderer.invoke('pear:worker:writeIPC:' + specifier, data),
  onWorkerIPC: (specifier, listener) => {
    const wrap = (evt, data) => listener(toBytes(data))
    ipcRenderer.on('pear:worker:ipc:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:ipc:' + specifier, wrap)
  },
  onWorkerExit: (specifier, listener) => {
    const wrap = (evt, data) => listener(data)
    ipcRenderer.on('pear:worker:exit:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:exit:' + specifier, wrap)
  },
  onWorkerStdout: (specifier, listener) => {
    const wrap = (evt, data) => listener(decoder.decode(toBytes(data)))
    ipcRenderer.on('pear:worker:stdout:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:stdout:' + specifier, wrap)
  },
  onWorkerStderr: (specifier, listener) => {
    const wrap = (evt, data) => listener(decoder.decode(toBytes(data)))
    ipcRenderer.on('pear:worker:stderr:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:stderr:' + specifier, wrap)
  }
})
