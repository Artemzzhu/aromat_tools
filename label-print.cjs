const { BrowserWindow, ipcMain } = require('electron')

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function registerLabelPrinting() {
  let printing = false

  ipcMain.handle('labels:printers', async ({ sender }) => {
    const printers = await sender.getPrintersAsync()
    return printers.map(({ name, displayName, isDefault }) => ({ name, displayName, isDefault }))
  })

  ipcMain.handle('labels:print', async ({ sender }, job) => {
    if (printing) return { ok: false, reason: 'Дождитесь отправки предыдущего задания.' }
    const { deviceName, width, height, copies, image } = job
    if (!Number.isFinite(width) || width < 10 || width > 110 ||
        !Number.isFinite(height) || height < 10 || height > 300 ||
        !Number.isInteger(copies) || copies < 1 || copies > 999 ||
        !(image instanceof Uint8Array) || image.length > 8 * 1024 * 1024 ||
        !Buffer.from(image.subarray(0, 8)).equals(pngSignature)) {
      return { ok: false, reason: 'Неверные параметры этикетки.' }
    }

    printing = true
    let window
    try {
      const printers = await sender.getPrintersAsync()
      if (!printers.some((printer) => printer.name === deviceName)) {
        return { ok: false, reason: 'Выбранный принтер недоступен.' }
      }
      window = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      const png = Buffer.from(image).toString('base64')
      const html = `<!doctype html><meta charset="utf-8"><style>
        @page { size: ${width}mm ${height}mm; margin: 0; }
        html, body { margin: 0; width: ${width}mm; height: ${height}mm; overflow: hidden; }
        img { display: block; width: 100%; height: 100%; object-fit: contain; }
      </style><img src="data:image/png;base64,${png}" alt="">`
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      await window.webContents.executeJavaScript('document.images[0].decode().then(() => true)')
      return await new Promise((resolve) => {
        window.webContents.print({
          silent: true,
          deviceName,
          copies,
          color: false,
          margins: { marginType: 'none' },
          pageSize: { width: Math.round(width * 1000), height: Math.round(height * 1000) }
        }, (ok, reason) => resolve({ ok, reason }))
      })
    } catch {
      return { ok: false, reason: 'Не удалось подготовить или отправить этикетку.' }
    } finally {
      if (window && !window.isDestroyed()) window.destroy()
      printing = false
    }
  })
}

module.exports = { registerLabelPrinting }
