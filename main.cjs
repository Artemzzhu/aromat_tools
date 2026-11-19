const { app, BrowserWindow } = require('electron')
const path = require('node:path')

function openWindow() {
  const window = new BrowserWindow({
    title: 'Aromat tools',
    width: 1240,
    height: 860,
    minWidth: 720,
    minHeight: 620,
    backgroundColor: '#f7f7fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(() => {
  openWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
