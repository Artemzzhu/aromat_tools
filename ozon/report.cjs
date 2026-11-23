const pageSize = 100
const orderStates = new Set(['DATA_FILLING', 'READY_TO_SUPPLY', 'ACCEPTED_AT_SUPPLY_WAREHOUSE',
  'IN_TRANSIT', 'ACCEPTANCE_AT_STORAGE_WAREHOUSE', 'REPORTS_CONFIRMATION_AWAITING', 'REPORT_REJECTED',
  'COMPLETED', 'REJECTED_AT_SUPPLY_WAREHOUSE', 'CANCELLED', 'OVERDUE'])

function validPeriod({ from, to } = {}) {
  const date = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  return Boolean(date(from) && date(to) && from <= to)
}

function idOf(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) return ''
  return id
}

function listFilter(period) {
  return {
    states: ['COMPLETED'],
    timeslot_from_range: {
      from: period.from + 'T00:00:00Z',
      to: period.to + 'T23:59:59.999Z',
      timeslot_filter_type: 'BY_LOCAL_TIME'
    }
  }
}

async function* listOrders(client, period) {
  const visited = new Set()
  let cursor = ''
  while (true) {
    const response = await client.request('list', {
      filter: listFilter(period), last_id: cursor, limit: pageSize,
      sort_by: 'TIMESLOT_FROM_LOCAL', sort_dir: 'ASC'
    })
    if (!Array.isArray(response?.order_ids) || response.order_ids.length > pageSize ||
        (response.last_id !== undefined && typeof response.last_id !== 'string')) {
      throw new Error('Некорректная страница списка заявок Ozon.')
    }
    if (!response.order_ids.length) return
    yield response.order_ids
    const next = response.last_id
    if (!next) {
      if (response.order_ids.length === pageSize) throw new Error('У полной страницы заявок отсутствует курсор.')
      return
    }
    if (visited.has(next)) throw new Error('Курсор списка заявок повторился.')
    visited.add(next)
    cursor = next
  }
}

async function loadBundle(client, bundleId) {
  const rows = []
  const visited = new Set()
  let cursor = ''
  let expected
  while (true) {
    const result = await client.request('bundle', {
      bundle_ids: [bundleId], limit: pageSize, last_id: cursor, sort_field: 'SKU', is_asc: true
    })
    if (!Array.isArray(result?.items) || result.items.length > pageSize || typeof result.has_next !== 'boolean') {
      throw new Error('В ответе Ozon отсутствует полная страница состава.')
    }
    if (result.total_count !== undefined) {
      if (!Number.isSafeInteger(result.total_count) || result.total_count < 0 ||
          (expected !== undefined && expected !== result.total_count)) throw new Error('Ozon вернул противоречивый итог состава.')
      expected = result.total_count
    }
    for (const item of result.items) {
      const sku = idOf(item?.sku)
      const quantity = item?.quantity
      if (!sku || !Number.isSafeInteger(quantity) || quantity < 0) {
        throw new Error('В составе поставки есть строка без SKU или заявленного количества.')
      }
      rows.push({ sku, quantity, name: typeof item.name === 'string' ? item.name : '',
        offerId: typeof item.offer_id === 'string' ? item.offer_id : '' })
    }
    if (!result.has_next) break
    const next = result.last_id
    if (!result.items.length || typeof next !== 'string' || !next || visited.has(next)) {
      throw new Error('Пагинация товарного состава прервалась.')
    }
    visited.add(next)
    cursor = next
  }
  if (expected !== undefined && expected !== rows.length) throw new Error('Число строк состава не совпало с итогом Ozon.')
  if (!rows.length) throw new Error('Ozon вернул пустой состав завершённой поставки.')
  return rows
}

async function loadReport(client, period, { previous, progress = () => {}, now = () => new Date().toISOString() } = {}) {
  if (!validPeriod(period)) throw new Error('Выберите корректный период.')
  const issues = []
  const orderIds = new Set()
  const candidates = new Map()
  const entries = []
  const issue = (stage, reason, orderId = '', supplyId = '') => issues.push({ stage, reason, orderId, supplyId })
  try {
    for await (const page of listOrders(client, period)) {
      for (const value of page) {
        const id = idOf(value)
        if (id) orderIds.add(id)
        else issue('Список заявок', 'Ozon вернул некорректный идентификатор заявки.')
      }
      progress(`Найдено заявок: ${orderIds.size}`)
    }
  } catch (error) {
    issue('Список заявок', error.message)
  }

  const ids = [...orderIds]
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50)
    const requested = new Set(batch)
    const returned = new Set()
    progress(`Проверяем заявки: ${start + 1}–${start + batch.length} из ${ids.length}`)
    try {
      const result = await client.request('get', { order_ids: batch.map((id) => JSON.rawJSON(id)) })
      if (!Array.isArray(result?.orders)) throw new Error('В ответе Ozon не найден список заявок.')
      for (const order of result.orders) {
        const orderId = idOf(order?.order_id)
        if (!requested.has(orderId)) {
          issue('Данные заявки', 'Ozon вернул заявку вне запрошенного списка.', orderId)
          continue
        }
        returned.add(orderId)
        if (order.state !== 'COMPLETED') {
          if (!orderStates.has(order.state)) issue('Данные заявки', 'Не удалось определить статус заявки.', orderId)
          continue
        }
        const date = order.timeslot?.timeslot?.from?.slice?.(0, 10)
        if (!validPeriod({ from: date, to: date })) {
          issue('Данные заявки', 'Нет корректной локальной даты таймслота.', orderId)
          continue
        }
        if (date < period.from || date > period.to) continue
        if (!Array.isArray(order.supplies) || !order.supplies.length) {
          issue('Данные заявки', 'В завершённой заявке нет списка поставок.', orderId)
          continue
        }
        for (const supply of order.supplies) {
          const supplyId = idOf(supply?.supply_id)
          if (supply?.state !== 'COMPLETED') {
            if (!orderStates.has(supply?.state)) issue('Данные поставки', 'Не удалось определить статус поставки.', orderId, supplyId)
            continue
          }
          if (!supplyId || typeof supply.bundle_id !== 'string' || !supply.bundle_id) {
            issue('Данные поставки', 'Отсутствует идентификатор поставки или состава.', orderId, supplyId)
            continue
          }
          const entry = { date, orderId, orderNumber: typeof order.order_number === 'string' ? order.order_number : '',
            supplyId, bundleId: supply.bundle_id, status: supply.state,
            originalSupplyId: order.order_tags?.is_virtual ? idOf(order.order_tags.original_supply_id) : '' }
          const duplicate = candidates.get(supplyId)
          if (!duplicate) candidates.set(supplyId, entry)
          else if (duplicate.bundleId !== entry.bundleId || duplicate.orderId !== entry.orderId || duplicate.date !== entry.date) {
            issue('Данные поставки', 'Повтор идентификатора с разными данными.', orderId, supplyId)
          }
        }
      }
      for (const id of batch) if (!returned.has(id)) issue('Данные заявки', 'Ozon не вернул запрошенную заявку.', id)
    } catch (error) {
      for (const id of batch) issue('Данные заявки', error.message, id)
    }
  }

  const cached = new Map((previous?.entries ?? []).map((entry) => [entry.supplyId, entry]))
  const bundleOwners = new Map()
  let processed = 0
  for (const entry of candidates.values()) {
    progress(`Проверяем составы: ${++processed} из ${candidates.size}`)
    if (entry.originalSupplyId && entry.originalSupplyId !== entry.supplyId) {
      if (!candidates.has(entry.originalSupplyId)) {
        issue('Связанная поставка', 'В периоде не найдена исходная поставка, на которую ссылается виртуальная заявка.', entry.orderId, entry.supplyId)
      }
      continue
    }
    if (bundleOwners.has(entry.bundleId)) {
      issue('Данные поставки', 'Один состав указан у разных поставок. Повторно он не учтён.', entry.orderId, entry.supplyId)
      continue
    }
    bundleOwners.set(entry.bundleId, entry.supplyId)
    try {
      const saved = cached.get(entry.supplyId)
      const items = saved?.bundleId === entry.bundleId ? saved.items : await loadBundle(client, entry.bundleId)
      entries.push({ ...entry, items })
    } catch (error) {
      issue('Состав поставки', error.message, entry.orderId, entry.supplyId)
    }
  }

  const updatedAt = now()
  return { period, entries, issues, updatedAt, complete: issues.length === 0 }
}

function summarize(report) {
  const groups = new Map()
  const missingOffers = new Set()
  for (const entry of report.entries) {
    for (const { offerId, sku, name, quantity } of entry.items) {
      const key = JSON.stringify([offerId, sku])
      if (!offerId) missingOffers.add(sku)
      if (!groups.has(key)) groups.set(key, { offerId, sku, name, quantity: 0, details: new Map() })
      const group = groups.get(key)
      group.quantity += quantity
      if (!group.name && name) group.name = name
      if (!group.details.has(entry.supplyId)) group.details.set(entry.supplyId, {
        date: entry.date, orderId: entry.orderId, orderNumber: entry.orderNumber,
        supplyId: entry.supplyId, status: entry.status, quantity: 0
      })
      group.details.get(entry.supplyId).quantity += quantity
    }
  }
  const products = [...groups.values()].map((group) => ({
    ...group, supplyCount: group.details.size, details: [...group.details.values()]
  }))
  return {
    products,
    stats: {
      supplies: report.entries.length,
      offers: new Set(products.map(({ offerId }) => offerId).filter(Boolean)).size,
      quantity: products.reduce((sum, product) => sum + product.quantity, 0),
      failedSupplies: new Set(report.issues.map(({ supplyId }) => supplyId).filter(Boolean)).size,
      missingOffers: missingOffers.size
    }
  }
}

module.exports = { validPeriod, listFilter, loadReport, summarize }
