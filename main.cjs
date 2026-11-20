const { app, BrowserWindow, net, protocol } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { registerLabelPrinting } = require('./label-print.cjs')

protocol.registerSchemesAsPrivileged([
  { scheme: 'aromat', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

function serveApp() {
  protocol.handle('aromat', (request) => {
    const { hostname, pathname } = new URL(request.url)
    const staticFile = /^\/(?:index\.html|renderer\.js|labels\.js|style\.css|assets\/aromat-mark\.svg)$/
    const pdfFile = /^\/node_modules\/pdfjs-dist\/(?:build\/pdf(?:\.worker)?\.mjs|(?:cmaps|standard_fonts|wasm)\/[\w.-]+)$/
    if (hostname !== 'app' || (!staticFile.test(pathname) && !pdfFile.test(pathname))) {
      return new Response(null, { status: 404 })
    }
    return net.fetch(pathToFileURL(path.join(__dirname, pathname.slice(1))).href)
  })
}

function openWindow() {
  const window = new BrowserWindow({
    title: 'Aromat Tools',
    icon: path.join(__dirname, 'assets', 'aromat-mark.ico'),
    width: 1240,
    height: 860,
    minWidth: 720,
    minHeight: 620,
    backgroundColor: '#eaece7',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.loadURL('aromat://app/index.html')
}

app.whenReady().then(() => {
  serveApp()
  registerLabelPrinting()
  openWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
