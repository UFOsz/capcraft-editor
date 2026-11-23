// Capcraft Editor — proceso principal de Electron.
// Arranca el motor (Python en desarrollo, capcraft-engine.exe en la app instalada), abre la ventana
// y se encarga de las actualizaciones automáticas desde GitHub Releases.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn, execFile, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const net = require('net')
const os = require('os')

const PACKAGED = app.isPackaged
const DEV_ENGINE = path.join(__dirname, '..', 'engine')
const RES = process.resourcesPath
let engineProc = null
let win = null
let updater = null

// una sola instancia (si abren otra, se enfoca la existente)
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
    s.on('error', reject)
  })
}

function engineCommand (port) {
  if (PACKAGED) {
    const exe = path.join(RES, 'engine', 'capcraft-engine', process.platform === 'win32' ? 'capcraft-engine.exe' : 'capcraft-engine')
    return {
      cmd: exe, args: ['--port', String(port)], cwd: path.dirname(exe),
      env: {
        CAPCRAFT_RES: path.join(RES, 'engine-res'),
        CAPCRAFT_RENDERER: path.join(RES, 'renderer'),
        CAPCRAFT_DATA: app.getPath('userData'),
        PATH: path.join(RES, 'ffmpeg') + path.delimiter + (process.env.PATH || '')
      }
    }
  }
  const py = process.platform === 'win32' ? path.join(DEV_ENGINE, '.venv', 'Scripts', 'python.exe') : path.join(DEV_ENGINE, '.venv', 'bin', 'python')
  return {
    cmd: fs.existsSync(py) ? py : (process.platform === 'win32' ? 'python' : 'python3'),
    args: ['-u', '-m', 'capcraft_subs.server', '--port', String(port)], cwd: DEV_ENGINE, env: {}
  }
}

function startEngine (port) {
  return new Promise((resolve, reject) => {
    let log = ''
    const c = engineCommand(port)
    engineProc = spawn(c.cmd, c.args, {
      cwd: c.cwd, windowsHide: true,
      env: { ...process.env, ...c.env, PYTHONIOENCODING: 'utf-8', CAPCRAFT_VERSION: app.getVersion() }
    })
    const timer = setTimeout(() => reject(new Error('El motor no respondió en 60 s.\n\n' + log)), 60000)
    engineProc.stdout.on('data', d => {
      const s = d.toString(); log += s
      if (s.includes('CAPCRAFT_READY')) { clearTimeout(timer); resolve() }
    })
    engineProc.stderr.on('data', d => { log += d.toString() })
    engineProc.on('exit', code => { clearTimeout(timer); if (code) reject(new Error(`El motor se cerró (código ${code}).\n\n${log.slice(-3000)}`)) })
    engineProc.on('error', e => { clearTimeout(timer); reject(e) })
  })
}

function stopEngine () {
  if (!engineProc || engineProc.killed || engineProc.exitCode !== null) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(engineProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else engineProc.kill()
  } catch {}
}

// La primera vez que se abre la versión instalada, trae los proyectos y plantillas de la versión anterior
// (Documentos\capcraft-editor) para no perder nada.
function migrateLegacy () {
  if (!PACKAGED) return
  try {
    const data = app.getPath('userData')
    const flag = path.join(data, '.migrado')
    if (fs.existsSync(flag)) return
    const legacy = path.join(os.homedir(), 'Documents', 'capcraft-editor')
    const pairs = [
      [path.join(legacy, 'proyectos'), path.join(data, 'proyectos')],
      [path.join(legacy, 'engine', 'templates', 'mis_plantillas.json'), path.join(data, 'templates', 'mis_plantillas.json')]
    ]
    for (const [src, dst] of pairs) {
      if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.cpSync(src, dst, { recursive: true }) }
    }
    fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(flag, new Date().toISOString())
  } catch (e) { console.warn('migración:', e) }
}

// ---------------------------------------------------------------- actualizaciones automáticas
function sendUpdate (status, extra = {}) { if (win && !win.isDestroyed()) win.webContents.send('update-status', { status, ...extra }) }
function setupUpdater () {
  if (!PACKAGED) return
  try { updater = require('electron-updater').autoUpdater } catch (e) { console.warn('electron-updater no disponible', e); return }
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.on('checking-for-update', () => sendUpdate('checking'))
  updater.on('update-available', (i) => sendUpdate('available', { version: i.version }))
  updater.on('update-not-available', () => sendUpdate('none', { version: app.getVersion() }))
  updater.on('download-progress', (p) => sendUpdate('downloading', { percent: Math.round(p.percent || 0) }))
  updater.on('error', (e) => sendUpdate('error', { message: String(e && e.message || e) }))
  updater.on('update-downloaded', async (i) => {
    sendUpdate('ready', { version: i.version })
    const r = await dialog.showMessageBox(win, {
      type: 'info', buttons: ['Reiniciar ahora', 'Más tarde'], defaultId: 0, cancelId: 1,
      title: 'Actualización lista', message: `Capcraft Editor ${i.version} está listo para instalarse.`,
      detail: 'Tus proyectos se guardan solos. Si eliges "Más tarde", la actualización se instala al cerrar la app.'
    })
    if (r.response === 0) { stopEngine(); setImmediate(() => updater.quitAndInstall(true, true)) }
  })
  const check = () => updater.checkForUpdates().catch(e => sendUpdate('error', { message: String(e.message || e) }))
  setTimeout(check, 8000)
  setInterval(check, 2 * 60 * 60 * 1000)
}

// ---------------------------------------------------------------- ventana
async function createWindow () {
  migrateLegacy()
  const port = await freePort()
  try {
    await startEngine(port)
  } catch (e) {
    dialog.showErrorBox('Capcraft Editor — no pudo iniciar el motor', `${e.message}\n\nCopia este mensaje y pásaselo a Claude.`)
    app.quit(); return
  }
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0e0f13', title: `Capcraft Editor ${app.getVersion()}`, autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false }
  })
  win.loadURL(`http://127.0.0.1:${port}/`)
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  setupUpdater()
}

ipcMain.handle('open-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Abrir video', properties: ['openFile'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] }, { name: 'Todos', extensions: ['*'] }]
  })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('open-media', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Importar medios', properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Videos, fotos y audio', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'] },
      { name: 'Todos', extensions: ['*'] }
    ]
  })
  return r.canceled ? [] : r.filePaths
})
ipcMain.handle('save-video', async (_e, suggested) => {
  const r = await dialog.showSaveDialog(win, { title: 'Exportar video', defaultPath: suggested, filters: [{ name: 'Video MP4', extensions: ['mp4'] }] })
  return r.canceled ? null : r.filePath
})
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p))
ipcMain.handle('toggle-devtools', () => win && win.webContents.toggleDevTools())
ipcMain.handle('app-info', () => ({ version: app.getVersion(), packaged: PACKAGED, data: app.getPath('userData') }))
ipcMain.handle('check-updates', async () => {
  if (!PACKAGED || !updater) return { status: 'dev' }
  try { const r = await updater.checkForUpdates(); return { status: 'ok', latest: r && r.updateInfo && r.updateInfo.version } } catch (e) { return { status: 'error', message: String(e.message || e) } }
})
ipcMain.handle('install-update', () => { if (updater) { stopEngine(); updater.quitAndInstall(true, true) } })

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { stopEngine(); app.quit() })
app.on('before-quit', stopEngine)
