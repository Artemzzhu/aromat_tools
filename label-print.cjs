const { BrowserWindow, dialog, ipcMain } = require('electron')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { buildLabelBatch } = require('./label-batch.cjs')

function isValidJob(job) {
  if (!job || typeof job.deviceName !== 'string' ||
      !Array.isArray(job.sources) || !Array.isArray(job.items) ||
      !job.items.length || job.sources.length > job.items.length) return false
  return job.sources.every((source) => source instanceof Uint8Array && source.length <= 25 * 1024 * 1024) &&
    job.items.every((item) => item && Number.isInteger(item.source) && item.source >= 0 &&
      item.source < job.sources.length && Number.isInteger(item.page) && item.page >= 0 && item.page < 100 &&
      Number.isInteger(item.copies) && item.copies >= 1 && item.copies <= 999)
}

function registerLabelPrinting() {
  let printing = false

  ipcMain.handle('labels:printers', async ({ sender }) => {
    const printers = await sender.getPrintersAsync()
    return printers.map(({ name, displayName, isDefault }) => ({ name, displayName, isDefault }))
  })

  ipcMain.handle('labels:submit', async ({ sender }, job) => {
    const save = job?.action === 'save' || /^Microsoft Print to PDF$/i.test(job?.deviceName)

    if (printing) return { ok: false, reason: 'Дождитесь отправки предыдущего задания.' }
    if (!isValidJob(job)) return { ok: false, reason: 'Неверные параметры задания.' }
    if (!save && process.platform !== 'win32') return { ok: false, reason: 'Отправка PDF на принтер доступна в Windows.' }

    printing = true
    let directory
    let sent = false
    const failure = save ? 'Не удалось сохранить PDF.'
      : 'Не удалось подготовить PDF или отправить его на принтер.'
    let warning
    try {
      if (save) {
        const owner = BrowserWindow.fromWebContents(sender)
        const options = {
          title: 'Сохранить PDF с этикетками',
          defaultPath: 'labels.pdf',
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        }
        const { canceled, filePath } = owner
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options)
        if (canceled || !filePath) return { canceled: true }
        await writeFile(filePath, await buildLabelBatch(job.sources, job.items))
        return { ok: true, saved: true }
      }

      const printers = await sender.getPrintersAsync()
      if (!printers.some((printer) => printer.name === job.deviceName)) {
        return { ok: false, reason: 'Выбранный принтер недоступен.' }
      }
      const pdf = await buildLabelBatch(job.sources, job.items)
      directory = await mkdtemp(path.join(tmpdir(), 'aromat-print-'))
      const file = path.join(directory, 'labels.pdf')
      await writeFile(file, pdf)
      const { print } = require('pdf-to-printer')
      await print(file, { printer: job.deviceName, scale: 'noscale', silent: true })
      sent = true
    } catch (error) {
      console.error('Label printing failed:', error)
    } finally {
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
        } catch {
          warning = 'Не удалось удалить временный PDF: ' + directory
        }
      }
      printing = false
    }
    return sent ? { ok: true, warning } : { ok: false, reason: [failure, warning].filter(Boolean).join(' ') }
  })
}

module.exports = { registerLabelPrinting }
