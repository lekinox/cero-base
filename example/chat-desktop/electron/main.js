import electron from 'electron'
const { app, BrowserWindow, ipcMain, nativeTheme } = electron
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import PearRuntime from 'pear-runtime'
import { isLinux, isMac } from 'which-runtime'
import { command, flag } from 'paparam'
import { isInitialized } from 'chat-backend'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const { name, productName, version, upgrade } = pkg

const appName = productName ?? name
const protocol = name

const WORKER = '/workers/main.js'
const workers = new Map()
let pear = null

const cmd = command(
  appName,
  flag('--storage [storage]', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates'),
  flag('--remote-debug [port]', 'expose a CDP endpoint (e2e/debugging)'),
  flag(
    '--bootstrap [nodes]',
    'DHT bootstrap nodes, host:port comma separated (a local test network)'
  ),
  flag('--no-devtools', 'start without the detached DevTools')
)

// the app's own folder, and the switches Chromium and Node read themselves (a test driver passes them first), are not its flags
const own = (arg) =>
  !/^--(remote-debugging-port|inspect|no-sandbox)/.test(arg) &&
  path.resolve(arg) !== app.getAppPath()
cmd.parse(process.argv.slice(1).filter(own))

if (cmd.flags.remoteDebug !== undefined) {
  app.commandLine.appendSwitch('remote-debugging-port', String(cmd.flags.remoteDebug || 0))
}

const pearStore = cmd.flags.storage
const updates = cmd.flags.updates
const bootstrap = cmd.flags.bootstrap
const devtools = cmd.flags.devtools

ipcMain.on('pkg', (event) => {
  event.returnValue = pkg
})

function getPear() {
  if (pear) return pear

  const appPath = getAppPath()
  let dir = null
  if (pearStore) {
    dir = pearStore
  } else if (appPath === null) {
    dir = path.join(os.tmpdir(), 'pear', appName)
  } else {
    dir = isMac
      ? path.join(os.homedir(), 'Library', 'Application Support', appName)
      : isLinux
        ? path.join(os.homedir(), '.config', appName)
        : path.join(os.homedir(), 'AppData', 'Roaming', appName)
  }

  const hasUpgrade = typeof upgrade === 'string' && upgrade.length > 0

  pear = new PearRuntime({
    name: appName,
    app: appPath,
    dir,
    version,
    upgrade,
    updates: hasUpgrade ? updates : false
  })

  return pear
}

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  return path.join(process.resourcesPath, '..', '..')
}

function sendToAll(name, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(name, data)
  }
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)

  const runtime = getPear()
  const args = bootstrap ? [runtime.storage, bootstrap] : [runtime.storage]
  const worker = runtime.run(path.resolve(__dirname, '..' + specifier), args)

  function sendWorkerStdout(data) {
    process.stdout.write(data)
    sendToAll('pear:worker:stdout:' + specifier, data)
  }

  function sendWorkerStderr(data) {
    process.stderr.write(data)
    sendToAll('pear:worker:stderr:' + specifier, data)
  }

  function sendWorkerIPC(data) {
    sendToAll('pear:worker:ipc:' + specifier, data)
  }

  ipcMain.handle('pear:worker:writeIPC:' + specifier, (event, data) => {
    return worker.write(data)
  })

  const onBeforeQuit = () => {
    if (!worker.destroyed) worker.destroy()
  }

  workers.set(specifier, worker)

  worker.on('data', sendWorkerIPC)
  worker.stdout.on('data', sendWorkerStdout)
  worker.stderr.on('data', sendWorkerStderr)

  worker.once('exit', (code) => {
    console.log('worker exited:', specifier, 'code:', code)
    app.removeListener('before-quit', onBeforeQuit)
    ipcMain.removeHandler('pear:worker:writeIPC:' + specifier)
    worker.removeListener('data', sendWorkerIPC)
    worker.stdout.removeListener('data', sendWorkerStdout)
    worker.stderr.removeListener('data', sendWorkerStderr)
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
  })

  app.on('before-quit', onBeforeQuit)

  return worker
}

nativeTheme.themeSource = 'dark'

async function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    backgroundColor: '#1a1a2e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  win.once('ready-to-show', () => win.show())

  const runtime = getPear()

  const onUpdating = () => {
    if (!win.isDestroyed()) win.webContents.send('pear:event:updating')
  }
  const onUpdated = () => {
    if (!win.isDestroyed()) win.webContents.send('pear:event:updated')
  }

  runtime.on('updating', onUpdating)
  runtime.on('updated', onUpdated)

  win.on('closed', () => {
    runtime.removeListener('updating', onUpdating)
    runtime.removeListener('updated', onUpdated)
  })

  const devServerUrl = process.env.PEAR_DEV_SERVER_URL
  if (devServerUrl) {
    await win.webContents.session.clearCache()
    await win.loadURL(devServerUrl)
    if (devtools) win.webContents.openDevTools({ mode: 'detach' })
    return
  }

  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  if (!app.isPackaged && devtools) win.webContents.openDevTools({ mode: 'detach' })
}

ipcMain.handle('pear:applyUpdate', () => getPear().applyUpdate())
ipcMain.handle('pear:startWorker', (event, filename) => {
  // a compromised renderer must not choose the code main runs
  if (filename !== WORKER) throw new Error(`unknown worker: ${filename}`)
  getWorker(WORKER)
  // set up now: a reloaded page must not offer setup again
  initialized = true
  return true
})
let initialized = null
async function checkInitialized() {
  if (initialized !== null) return initialized
  initialized = await isInitialized(getPear().storage)
  return initialized
}

ipcMain.handle('pear:isInitialized', checkInitialized)

app.setAsDefaultProtocolClient(protocol)

app.on('open-url', (event, url) => {
  event.preventDefault()
  console.log('deep link:', url)
})

app.whenReady().then(async () => {
  if (await checkInitialized()) getWorker(WORKER)

  createWindow().catch((error) => {
    console.error('Failed to create window:', error)
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => {
        console.error('Failed to create window:', error)
      })
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
