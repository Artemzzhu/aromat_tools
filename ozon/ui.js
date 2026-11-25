(() => {
  const byId = (name) => document.getElementById('ozon-' + name)
  const api = window.ozonFbo
  const from = byId('from')
  const to = byId('to')
  const status = byId('status')
  const reportPanel = byId('result')
  const settings = byId('settings')
  const client = byId('client')
  const key = byId('key')
  const settingsStatus = byId('settings-status')
  const search = byId('search')
  const filter = byId('filter')
  const sort = byId('sort')
  const table = byId('products')
  const format = new Intl.NumberFormat('ru-RU')
  const pageSize = 50
  let active = false
  let settingsBusy = false
  let cachedRequest = 0
  let report
  let page = 1
  let selectedProduct
  let allowSave = false

  const period = () => ({ from: from.value, to: to.value })
  const credentials = () => ({ clientId: client.value, apiKey: key.value })
  const dateText = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const presets = [...document.querySelectorAll('[data-ozon-period]')]

  async function request(method, input) {
    if (!api) throw new Error('Откройте инструмент в настольном приложении Aromat Tools.')
    const result = await api[method](input)
    if (!result.ok) throw new Error(result.message)
    return result.data
  }

  function setPreset(preset) {
    const today = new Date()
    const year = today.getFullYear()
    if (preset === 'rolling') {
      const lastYear = year - 1
      const month = today.getMonth()
      const maxDay = new Date(lastYear, month + 1, 0).getDate()
      from.value = dateText(new Date(lastYear, month, Math.min(today.getDate(), maxDay)))
      to.value = dateText(today)
    } else {
      const selected = preset === 'previous' ? year - 1 : year
      from.value = selected + '-01-01'
      to.value = preset === 'previous' ? selected + '-12-31' : dateText(today)
    }
    void restoreCache()
  }

  function cell(row, value, className) {
    const td = row.insertCell()
    td.textContent = value
    if (className) td.className = className
    return td
  }

  function renderTable() {
    if (!report) return
    const query = search.value.trim().toLocaleLowerCase('ru')
    const field = sort.value.startsWith('qty') ? 'quantity' : 'supplyCount'
    const direction = sort.value.endsWith('asc') ? 1 : -1
    const filtered = report.products
      .filter(({ offerId, name, sku }) => {
        const match = !query || [offerId, name, sku].some((value) => value.toLocaleLowerCase('ru').includes(query))
        return match && (filter.value === 'all' || (filter.value === 'matched' ? Boolean(offerId) : !offerId))
      })
      .sort((a, b) => direction * (a[field] - b[field]) || a.offerId.localeCompare(b.offerId, 'ru') || a.sku.localeCompare(b.sku))
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
    page = Math.max(1, Math.min(page, pages))
    const fragment = document.createDocumentFragment()
    for (const product of filtered.slice((page - 1) * pageSize, page * pageSize)) {
      const row = document.createElement('tr')
      row.classList.toggle('ozon-selected', selectedProduct === product)
      const action = document.createElement('button')
      action.type = 'button'
      action.className = 'ozon-product'
      action.textContent = product.offerId || 'Без артикула'
      action.setAttribute('aria-label', `Поставки товара ${product.offerId || product.sku}`)
      action.addEventListener('click', () => openProduct(product, row))
      row.insertCell().append(action)
      cell(row, product.name || '—')
      cell(row, product.sku)
      cell(row, format.format(product.quantity), 'ozon-number')
      cell(row, format.format(product.supplyCount), 'ozon-number')
      fragment.append(row)
    }
    if (!filtered.length) {
      const row = document.createElement('tr')
      cell(row, 'Нет товаров по выбранным условиям.').colSpan = 5
      fragment.append(row)
    }
    table.replaceChildren(fragment)
    byId('filtered').textContent = `Строк: ${format.format(filtered.length)} · Заявлено: ${format.format(filtered.reduce((sum, item) => sum + item.quantity, 0))}`
    byId('page').textContent = `${page} / ${pages}`
    byId('prev').disabled = page === 1
    byId('next').disabled = page === pages
  }

  function openProduct(product, row) {
    selectedProduct = product
    byId('detail-export-status').textContent = ''
    table.querySelector('.ozon-selected')?.classList.remove('ozon-selected')
    row.classList.add('ozon-selected')
    byId('detail-product').textContent = [product.offerId || 'Без артикула', product.name, 'SKU ' + product.sku].filter(Boolean).join(' · ')
    const fragment = document.createDocumentFragment()
    const ordered = [...product.details].sort((a, b) => b.date.localeCompare(a.date) || a.supplyId.localeCompare(b.supplyId))
    for (const detail of ordered) {
      const item = document.createElement('tr')
      cell(item, detail.date)
      const order = cell(item, detail.orderNumber || detail.orderId)
      order.title = 'ID заявки: ' + detail.orderId
      cell(item, detail.supplyId)
      cell(item, product.offerId || '—')
      cell(item, format.format(detail.quantity), 'ozon-number')
      cell(item, detail.status === 'COMPLETED' ? 'Завершена' : detail.status)
      fragment.append(item)
    }
    byId('detail-rows').replaceChildren(fragment)
    byId('detail').showModal()
  }

  function showReport(next) {
    report = next
    page = 1
    selectedProduct = undefined
    reportPanel.hidden = !report
    if (!report) return
    const { stats, issues, complete, lastSuccessfulAt } = report
    const names = { supplies: stats.supplies, offers: stats.offers, quantity: stats.quantity, failed: stats.failedSupplies }
    for (const [name, value] of Object.entries(names)) byId('stat-' + name).textContent = format.format(value)
    byId('updated').textContent = lastSuccessfulAt
      ? 'Последнее полное обновление: ' + new Date(lastSuccessfulAt).toLocaleString('ru-RU')
      : 'Полного обновления ещё не было.'
    const warnings = []
    if (!complete) warnings.push('Отчёт неполный. Итоги включают только полностью загруженные составы.')
    if (!complete && issues.some(({ supplyId }) => !supplyId)) {
      warnings.push('По части ошибок число пропущенных поставок неизвестно.')
    }
    if (stats.missingOffers) warnings.push(`SKU без артикула: ${stats.missingOffers}. Они учтены отдельными строками.`)
    byId('warning').hidden = !warnings.length
    byId('warning').textContent = warnings.join(' ')
    byId('retry').hidden = complete
    byId('issues').hidden = !issues.length
    byId('issues-title').textContent = 'Ошибки и пропуски · ' + issues.length
    const shown = issues.slice(0, 100).map(({ stage, reason, orderId, supplyId }) => {
      const item = document.createElement('li')
      item.textContent = [stage, orderId && 'заявка ' + orderId, supplyId && 'поставка ' + supplyId, reason].filter(Boolean).join(' · ')
      return item
    })
    if (issues.length > shown.length) {
      const item = document.createElement('li')
      item.textContent = 'Полный список доступен в Excel.'
      shown.push(item)
    }
    byId('issues-list').replaceChildren(...shown)
    renderTable()
  }

  function setActive(value) {
    active = value
    byId('activity').hidden = !value
    for (const control of [from, to, byId('load'), byId('refresh'), byId('retry'), byId('export'), byId('settings-open'), ...presets]) {
      control.disabled = value
    }
  }

  async function restoreCache() {
    if (active || document.getElementById('ozon-fbo').hidden) return
    const revision = ++cachedRequest
    const selected = period()
    to.min = selected.from
    status.textContent = ''
    showReport(null)
    if (!api || !selected.from || !selected.to || selected.from > selected.to) return
    try {
      const cached = await request('cached', selected)
      if (revision === cachedRequest) showReport(cached)
    } catch (error) {
      if (revision === cachedRequest) status.textContent = error.message
    }
  }

  async function load(retry = false) {
    if (active || !byId('period').reportValidity()) return
    const selected = period()
    if (selected.from > selected.to) {
      status.textContent = 'Дата начала должна быть не позже даты окончания.'
      return
    }
    ++cachedRequest
    setActive(true)
    byId('progress-text').textContent = 'Соединяемся с Ozon…'
    status.textContent = ''
    try {
      const data = await request('load', { period: selected, retry })
      showReport(data)
      if (data.complete && !data.stats.supplies) status.textContent = 'За этот период завершённых поставок нет.'
    } catch (error) {
      status.textContent = error.message
    } finally {
      setActive(false)
    }
  }

  function lockSettings(value) {
    settingsBusy = value
    client.disabled = value
    key.disabled = value
    byId('test').disabled = value
    byId('save').disabled = value || !allowSave
  }

  byId('settings-open').addEventListener('click', async () => {
    if (settings.open) return
    key.value = ''
    client.value = ''
    settingsStatus.textContent = ''
    byId('key-info').textContent = ''
    settings.showModal()
    lockSettings(true)
    try {
      const data = await request('settings')
      client.value = data.clientId
      allowSave = data.secure
      byId('key-info').textContent = data.hasKey ? 'Ключ сохранён. Оставьте поле пустым, чтобы сохранить текущий ключ.' : ''
      settingsStatus.textContent = data.notice || (data.secure ? '' : 'Защищённое хранилище системы недоступно.')
    } catch (error) {
      allowSave = false
      settingsStatus.textContent = error.message
    } finally {
      lockSettings(false)
    }
  })
  byId('settings-close').addEventListener('click', () => { if (!settingsBusy) settings.close() })
  settings.addEventListener('cancel', (event) => { if (settingsBusy) event.preventDefault() })
  settings.addEventListener('close', () => { key.value = '' })

  byId('test').addEventListener('click', async () => {
    if (!byId('credentials').reportValidity()) return
    const input = credentials()
    lockSettings(true)
    settingsStatus.textContent = 'Проверяем доступ…'
    try {
      await request('test', input)
      settingsStatus.textContent = 'Ozon открыл доступ к списку заявок FBO.'
    } catch (error) {
      settingsStatus.textContent = error.message
    } finally {
      lockSettings(false)
    }
  })

  byId('credentials').addEventListener('submit', async (event) => {
    event.preventDefault()
    const input = credentials()
    lockSettings(true)
    settingsStatus.textContent = ''
    try {
      await request('save', input)
      key.value = ''
      byId('key-info').textContent = 'Ключ сохранён. Оставьте поле пустым, чтобы сохранить текущий ключ.'
      settingsStatus.textContent = 'Настройки сохранены.'
      void restoreCache()
    } catch (error) {
      settingsStatus.textContent = error.message
    } finally {
      lockSettings(false)
    }
  })

  for (const button of presets) button.addEventListener('click', () => setPreset(button.dataset.ozonPeriod))
  for (const input of [from, to]) input.addEventListener('change', restoreCache)
  byId('period').addEventListener('submit', (event) => { event.preventDefault(); void load() })
  byId('refresh').addEventListener('click', () => void load())
  byId('retry').addEventListener('click', () => void load(true))
  byId('export').addEventListener('click', async () => {
    if (!report || active) return
    byId('export').disabled = true
    try {
      if (await request('export', report.period)) status.textContent = 'Файл Excel сохранён.'
    } catch (error) {
      status.textContent = error.message
    } finally {
      byId('export').disabled = active
    }
  })
  byId('detail-export').addEventListener('click', async () => {
    if (!report || !selectedProduct) return
    const product = selectedProduct
    const { offerId, sku } = product
    const button = byId('detail-export')
    const detailStatus = byId('detail-export-status')
    button.disabled = true
    detailStatus.textContent = ''
    try {
      const saved = await request('exportProduct', { period: report.period, product: { offerId, sku } })
      if (saved && selectedProduct === product) detailStatus.textContent = 'Файл Excel сохранён.'
    } catch (error) {
      if (selectedProduct === product) detailStatus.textContent = error.message
    } finally {
      button.disabled = false
    }
  })
  for (const input of [search, filter, sort]) {
    input.addEventListener(input === search ? 'input' : 'change', () => { page = 1; renderTable() })
  }
  byId('prev').addEventListener('click', () => { page--; renderTable() })
  byId('next').addEventListener('click', () => { page++; renderTable() })
  api?.onProgress((message) => { if (active) byId('progress-text').textContent = message })

  function startOzonScreen({ detail }) {
    if (detail !== 'ozon-fbo') return
    document.removeEventListener('screen-changed', startOzonScreen)
    void restoreCache()
  }
  document.addEventListener('screen-changed', startOzonScreen)
  setPreset('current')
})()
