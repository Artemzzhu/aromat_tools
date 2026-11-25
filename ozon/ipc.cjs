const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron')
const { mkdir, readFile, writeFile, rename, rm } = require('node:fs/promises')
const { createHash, randomUUID } = require('node:crypto')
const path = require('node:path')
const { createOzonClient } = require('./api.cjs')
const { validPeriod, loadReport, summarize } = require('./report.cjs')
const { createWorkbook } = require('./export.cjs')

function validateCredentials(input) {
  const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : ''
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
  if (!/^\d{1,30}$/.test(clientId) || !/^[!-~]{1,512}$/.test(apiKey)) {
    throw new Error('Введите Client ID и API Key из кабинета Ozon.')
  }
  return { clientId, apiKey }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, value, { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function registerOzon() {
  const root = path.join(app.getPath('userData'), 'ozon')
  const secretFile = path.join(root, 'credentials.bin')
  let active = false
  let client
  let clientCredentials

  function secureStorageAvailable() {
    return safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  }

  async function readCredentials() {
    let encrypted
    try {
      encrypted = await readFile(secretFile)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw new Error('Не удалось прочитать настройки Ozon.')
    }
    if (!secureStorageAvailable()) throw new Error('Защищённое хранилище системы недоступно.')
    try {
      return validateCredentials(JSON.parse(safeStorage.decryptString(encrypted)))
    } catch {
      throw new Error('Не удалось расшифровать настройки Ozon. Введите ключ заново.')
    }
  }

  async function requireCredentials() {
    const credentials = await readCredentials()
    if (!credentials) throw new Error('Сначала сохраните Client ID и API Key в настройках Ozon.')
    return credentials
  }

  function getClient(credentials) {
    if (!client || clientCredentials.clientId !== credentials.clientId || clientCredentials.apiKey !== credentials.apiKey) {
      client = createOzonClient(credentials)
      clientCredentials = credentials
    }
    return client
  }

  function cacheFile(clientId, period) {
    if (!validPeriod(period)) throw new Error('Выберите корректный период.')
    const key = createHash('sha256').update(JSON.stringify([clientId, period.from, period.to])).digest('hex')
    return path.join(root, 'reports', key + '.json')
  }

  async function readReport(file) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw new Error('Не удалось прочитать локальный отчёт Ozon.')
    }
  }

  function publicReport(report) {
    if (!report) return null
    const { period, issues, complete, updatedAt, lastSuccessfulAt } = report
    return { period, issues, complete, updatedAt, lastSuccessfulAt, ...summarize(report) }
  }

  function handle(channel, work) {
    ipcMain.handle('ozon:' + channel, async (event, input) => {
      try {
        return { ok: true, data: await work(event, input) }
      } catch (error) {
        // Application and transport errors are explicit and never include response bodies or headers.
        return { ok: false, message: error.expose ? error.message : 'Не удалось выполнить операцию Ozon.' }
      }
    })
  }

  async function operation(work, fallback) {
    try {
      return await work()
    } catch {
      throw displayError(fallback)
    }
  }

  const displayError = (message) => Object.assign(new Error(message), { expose: true })

  handle('settings', async () => {
    try {
      const credentials = await readCredentials()
      return { clientId: credentials?.clientId ?? '', hasKey: Boolean(credentials), secure: secureStorageAvailable() }
    } catch (error) {
      return { clientId: '', hasKey: false, secure: secureStorageAvailable(), notice: error.message }
    }
  })

  handle('save', async (_event, input) => {
    if (active) throw displayError('Дождитесь завершения запроса Ozon.')
    if (!secureStorageAvailable()) throw displayError('Защищённое хранилище системы недоступно.')
    let credentials
    try {
      const existing = input?.apiKey ? null : await readCredentials()
      credentials = validateCredentials({
        clientId: input?.clientId, apiKey: input?.apiKey ||
          (existing?.clientId === input?.clientId?.trim?.() ? existing?.apiKey : '')
      })
    } catch (error) {
      throw displayError(error.message)
    }
    await operation(() => atomicWrite(secretFile, safeStorage.encryptString(JSON.stringify(credentials))),
      'Не удалось сохранить ключ в защищённом хранилище.')
    return { clientId: credentials.clientId, hasKey: true, secure: true }
  })

  handle('test', async (_event, input) => {
    if (active) throw displayError('Дождитесь завершения запроса Ozon.')
    active = true
    try {
      let credentials
      if (input?.apiKey) credentials = validateCredentials(input)
      else {
        credentials = await requireCredentials()
        if (input?.clientId?.trim?.() && input.clientId.trim() !== credentials.clientId) {
          throw new Error('Введите API Key для нового Client ID.')
        }
      }
      const result = await getClient(credentials).request('list', {
        filter: { states: ['COMPLETED'] }, last_id: '', limit: 1, sort_by: 'ORDER_CREATION', sort_dir: 'DESC'
      })
      if (!Array.isArray(result?.order_ids)) throw new Error('Ответ Ozon не содержит список заявок.')
      return true
    } catch (error) {
      throw displayError(error.message)
    } finally {
      active = false
    }
  })

  handle('cached', async (_event, period) => {
    const credentials = await readCredentials().catch((error) => { throw displayError(error.message) })
    if (!credentials || !validPeriod(period)) return null
    return operation(async () => publicReport(await readReport(cacheFile(credentials.clientId, period))),
      'Не удалось прочитать локальный отчёт Ozon.')
  })

  handle('load', async ({ sender }, input) => {
    if (active) throw displayError('Дождитесь завершения запроса Ozon.')
    const period = { from: input?.period?.from, to: input?.period?.to }
    if (!validPeriod(period)) throw displayError('Выберите корректный период.')
    active = true
    try {
      const credentials = await requireCredentials().catch((error) => { throw displayError(error.message) })
      const file = cacheFile(credentials.clientId, period)
      const existing = await readReport(file).catch((error) => { throw displayError(error.message) })
      const report = await loadReport(getClient(credentials), period, {
        previous: input?.retry === true ? existing : undefined,
        progress(message) {
          if (!sender.isDestroyed()) sender.send('ozon:progress', message)
        }
      })
      report.lastSuccessfulAt = report.complete ? report.updatedAt : existing?.lastSuccessfulAt ?? null
      await operation(() => atomicWrite(file, JSON.stringify(report)), 'Не удалось сохранить отчёт Ozon на компьютере.')
      return publicReport(report)
    } finally {
      active = false
    }
  })

  async function saveWorkbook({ sender }, period, selection) {
    const credentials = await requireCredentials().catch((error) => { throw displayError(error.message) })
    if (!validPeriod(period)) throw displayError('Выберите корректный период.')
    const report = await operation(() => readReport(cacheFile(credentials.clientId, period)), 'Не удалось прочитать отчёт Ozon.')
    if (!report) throw displayError('Сначала загрузите поставки за этот период.')
    const workbook = createWorkbook(report, selection)
    if (!workbook) throw displayError('Товар не найден в отчёте за этот период.')
    const suffix = selection ? '-SKU-' + selection.sku : ''
    const options = { title: 'Экспорт поставок Ozon FBO', defaultPath: `Ozon-FBO${suffix}-${period.from}-${period.to}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }] }
    const owner = BrowserWindow.fromWebContents(sender)
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await operation(() => workbook.xlsx.writeFile(result.filePath), 'Не удалось записать файл Excel.')
    return true
  }

  handle('export', (event, period) => saveWorkbook(event, period))
  handle('export-product', (event, input) => {
    const { offerId, sku } = input?.product ?? {}
    if (typeof offerId !== 'string' || typeof sku !== 'string' || !/^[1-9]\d{0,18}$/.test(sku)) {
      throw displayError('Выберите товар для выгрузки.')
    }
    return saveWorkbook(event, input.period, { offerId, sku })
  })
}

module.exports = { registerOzon }
