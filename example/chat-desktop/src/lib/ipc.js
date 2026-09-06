import { Duplex } from 'streamx'

export function getIPC(path, extraArgs = []) {
  window.bridge.startWorker(path, extraArgs)

  let bootError = null
  const stream = new Duplex({
    write(data, cb) {
      window.bridge.writeWorkerIPC(path, data)
      cb()
    }
  })

  window.bridge.onWorkerIPC(path, (data) => stream.push(data))
  window.bridge.onWorkerExit(path, () => stream.destroy(bootError))
  window.bridge.onWorkerStdout(path, (text) =>
    console.log(`[worker${path}]`, text.replace(/\n$/, ''))
  )
  window.bridge.onWorkerStderr(path, (text) => {
    const trimmed = text.replace(/\n$/, '')
    const m = trimmed.match(/__BOOT_ERROR__(.*)/)
    if (m) bootError = new Error(m[1])
    else console.error(`[worker${path}]`, trimmed)
  })

  return stream
}
