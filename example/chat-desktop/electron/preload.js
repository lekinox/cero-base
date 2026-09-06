const { contextBridge, ipcRenderer } = require('electron')

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data))
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return Buffer.from(data)
  return Buffer.alloc(0)
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
    const wrap = (evt, data) => listener(toBuffer(data))
    ipcRenderer.on('pear:worker:ipc:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:ipc:' + specifier, wrap)
  },
  onWorkerExit: (specifier, listener) => {
    const wrap = (evt, data) => listener(data)
    ipcRenderer.on('pear:worker:exit:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:exit:' + specifier, wrap)
  },
  onWorkerStdout: (specifier, listener) => {
    const wrap = (evt, data) => listener(toBuffer(data).toString('utf8'))
    ipcRenderer.on('pear:worker:stdout:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:stdout:' + specifier, wrap)
  },
  onWorkerStderr: (specifier, listener) => {
    const wrap = (evt, data) => listener(toBuffer(data).toString('utf8'))
    ipcRenderer.on('pear:worker:stderr:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:stderr:' + specifier, wrap)
  }
})
