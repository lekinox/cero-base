import net from 'net'

/**
 * Loopback TCP transport implementing the tap `{ accept(handler) }` contract plus
 * lifecycle.
 *
 * @param {{ port?: number, host?: string, token?: string | null }} [opts]
 * @returns {{ accept(handler: (socket: any) => void): void, ready(): Promise<{ port: number }>, port: number | null, close(): void }}
 */
export function loopback(opts = {}) {
  const host = opts.host ?? '127.0.0.1'
  const base = opts.port ?? 0
  let server = null
  let ready = null
  return {
    accept(handler) {
      server = net.createServer((socket) => {
        socket.on('error', () => {}) // an inbound reset must not crash the host
        handler(socket)
      })
      let port = base
      let tries = 0
      ready = new Promise((resolve, reject) => {
        server.on('listening', () => resolve({ port: server.address().port }))
        // a taken port bumps to the next one
        server.on('error', (err) => {
          if (err.code === 'EADDRINUSE' && base && tries++ < 10) return server.listen(++port, host)
          console.error(`[devtools] tap could not start: ${err.message}`)
          reject(err)
        })
      })
      ready.catch(() => {}) // ready() may never be called — don't go unhandled
      server.on('listening', () => console.log(banner(host, server.address().port, opts.token)))
      server.listen(port, host)
    },
    ready() {
      if (!server) return Promise.reject(new Error('accept() not called'))
      return ready
    },
    get port() {
      return server?.listening ? server.address().port : null
    },
    close() {
      server?.close()
    }
  }
}

/**
 * Dial a loopback tap server and return the connected socket, ready for
 * `connect()`.
 *
 * @param {{ port: number, host?: string }} [opts]
 * @returns {any} A streamx-compatible Duplex socket.
 */
export function dial(opts = {}) {
  return net.connect(opts.port, opts.host ?? '127.0.0.1')
}

function banner(host, port, token) {
  const e = '\x1b['
  const r = `${e}0m`
  const dim = `${e}2m`
  const bold = `${e}1m`
  const cyan = `${e}36m`
  const green = `${e}32m`
  const cmd = token ? `cero-tools ${port} --token ${token}` : `cero-tools ${port}`
  return (
    `\n  ${bold}${cyan}cero devtools${r}  ${dim}tap ready${r}\n\n` +
    `  ${green}➜${r}  ${bold}Listening${r}:  ${cyan}${host}:${port}${r}\n` +
    `  ${green}➜${r}  ${bold}Connect${r}:    ${dim}${cmd}${r}\n`
  )
}
