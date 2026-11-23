const { BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { mkdtemp, writeFile, rm, readdir, stat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { buildLabelBatch } = require('./label-batch.cjs')
const { normalizeMarkingScan, buildMarkingLabel } = require('./marking-label.cjs')
const markingPrinter = /\b3B-300B\b/i

const previewPrefix = 'aromat-pdf-view-'
const previewLifetime = 24 * 60 * 60 * 1000

async function removeExpiredPreviews() {
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => [])
  const cutoff = Date.now() - previewLifetime
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(previewPrefix)) continue
    const directory = path.join(tmpdir(), entry.name)
    try {
      if ((await stat(directory)).mtimeMs < cutoff) await rm(directory, { recursive: true, force: true })
    } catch {
      // A PDF viewer may still have the file open.
    }
  }
}

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

  async function submit({ sender }, job, marking = false) {
    const save = !marking && (job?.action === 'save' || /^Microsoft Print to PDF$/i.test(job?.deviceName))
    const open = !marking && !save && job?.action === 'open'
    const direct = !marking && !save && job?.action === 'print'
    const payload = marking && normalizeMarkingScan(job?.scan)

    if (printing) return { ok: false, reason: 'Дождитесь отправки предыдущего задания.' }
    if (marking && !payload) return { ok: false, reason: 'Код не распознан. Проверьте передачу разделителя GS сканером.' }
    if (marking ? typeof job.deviceName !== 'string' : !isValidJob(job)) return { ok: false, reason: 'Неверные параметры задания.' }
    if (direct && (!['shrink', 'noscale', 'fit'].includes(job.scale) ||
        !['', 'portrait', 'landscape'].includes(job.orientation))) {
      return { ok: false, reason: 'Проверьте ориентацию и масштаб прямой печати.' }
    }
    if (!marking && !save && !open && !direct) return { ok: false, reason: 'Неизвестное действие.' }
    if (!save && process.platform !== 'win32') return { ok: false, reason: 'Отправка PDF на принтер доступна в Windows.' }

    printing = true
    let directory
    let sent = false
    const failure = save ? 'Не удалось сохранить PDF.'
      : open ? 'Не удалось открыть тираж. Проверьте, что в Windows выбрано приложение для PDF, или сохраните PDF отдельно.'
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

      if (open) {
        const pdf = await buildLabelBatch(job.sources, job.items)
        await removeExpiredPreviews()
        directory = await mkdtemp(path.join(tmpdir(), previewPrefix))
        const file = path.join(directory, 'labels.pdf')
        await writeFile(file, pdf)
        const openError = await shell.openPath(file)
        if (openError) throw new Error(openError)
        // Keep the file available after handoff to the external viewer.
        directory = undefined
        return { ok: true, opened: true }
      }

      const printers = await sender.getPrintersAsync()
      if (!printers.some(({ name, displayName }) => name === job.deviceName &&
          (!marking || markingPrinter.test(name + ' ' + displayName)))) {
        return { ok: false, reason: 'Выбранный принтер недоступен.' }
      }
      const pdf = marking ? await buildMarkingLabel(payload) : await buildLabelBatch(job.sources, job.items)
      directory = await mkdtemp(path.join(tmpdir(), 'aromat-print-'))
      const file = path.join(directory, 'labels.pdf')
      await writeFile(file, pdf)
      const { print } = require('pdf-to-printer')
      const options = { printer: job.deviceName, scale: marking ? 'noscale' : job.scale, silent: true }
      if (direct && job.orientation) options.orientation = job.orientation
      await print(file, options)
      sent = true
    } catch (error) {
      if (!marking) console.error('Label printing failed:', error)
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
  }

  ipcMain.handle('labels:submit', (event, job) => submit(event, job))
  ipcMain.handle('marking:print', (event, job) => submit(event, job, true))
}

module.exports = { registerLabelPrinting }
