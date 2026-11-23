const { test } = require('node:test')
const assert = require('node:assert/strict')
const { loadReport, summarize } = require('../ozon/report.cjs')
const { createOzonClient, parseResponse } = require('../ozon/api.cjs')
const { createWorkbook } = require('../ozon/export.cjs')

const period = { from: '2026-01-01', to: '2026-12-31' }
const supply = (id, bundle, state = 'COMPLETED') => ({ supply_id: id, bundle_id: bundle, state })
const order = (id, supplies, state = 'COMPLETED') => ({
  order_id: id, order_number: 'Z-' + id, state, supplies,
  timeslot: { timeslot: { from: '2026-01-01T01:00:00+05:00' } }
})
const product = (sku, offer, quantity, extra = {}) => ({
  sku, offer_id: offer, name: 'Товар', quantity, ...extra
})
const page = (items, total_count, last_id = '', has_next = false) => ({ items, total_count, last_id, has_next })

function fixture({ failBundle = false, missingOrder = false } = {}) {
  const calls = []
  const a = supply(101, 'one')
  const b = supply(102, 'two')
  return {
    calls,
    async request(method, body) {
      calls.push([method, body])
      if (method === 'list') {
        assert.deepEqual(body.filter.states, ['COMPLETED'])
        assert.equal(body.filter.timeslot_from_range.timeslot_filter_type, 'BY_LOCAL_TIME')
        if (!body.last_id) return { order_ids: [1, 2], last_id: 'page1' }
        if (body.last_id === 'page1') return { order_ids: [2, 3, ...(missingOrder ? [4] : [])], last_id: 'page2' }
        return { order_ids: [], last_id: '' }
      }
      if (method === 'get') {
        assert.deepEqual(JSON.parse(JSON.stringify(body)).order_ids, missingOrder ? [1, 2, 3, 4] : [1, 2, 3])
        return { orders: [order(1, [a, b, supply(103, 'cancelled', 'CANCELLED')]),
          order(1, [a, b]), order(2, [supply(104, 'three')]), order(3, [supply(105, 'cancelled')], 'CANCELLED')] }
      }
      assert.equal(method, 'bundle')
      assert.equal(body.bundle_ids.length, 1)
      switch (body.bundle_ids[0]) {
        case 'one':
          return body.last_id ? page([product(11, 'A', 2)], 2)
            : page([product(11, 'A', 4, { quant: 12, shipment_type: 'BUNDLE_ITEM_SHIPMENT_TYPE_BOX', fact_quantity: 1 })], 2, 'sku1', true)
        case 'two': return page([product(11, 'A', 3), product(11, 'B', 1)], 2)
        case 'three':
          if (failBundle) throw new Error('Нет ответа от Ozon.')
          return page([product(11, '', 9), product(12, 'A', 2)], 2)
        default: assert.fail('Cancelled order or supply was requested')
      }
    }
  }
}

test('paginates orders and bundles, separates shipments and sums declared units once per supply', async () => {
  const api = fixture()
  const report = await loadReport(api, period)
  assert.equal(report.complete, true)
  assert.deepEqual(report.entries.map(({ supplyId }) => supplyId), ['101', '102', '104'])
  assert.equal(api.calls.filter(([method]) => method === 'get').length, 1)
  assert.equal(api.calls.filter(([method, body]) => method === 'bundle' && body.bundle_ids[0] === 'one').length, 2)
  const { products, stats } = summarize(report)
  assert.deepEqual(stats, { supplies: 3, offers: 2, quantity: 21, failedSupplies: 0, missingOffers: 1 })
  assert.deepEqual(products.map(({ offerId, sku, quantity, supplyCount }) => [offerId, sku, quantity, supplyCount]),
    [['A', '11', 9, 2], ['B', '11', 1, 1], ['', '11', 9, 1], ['A', '12', 2, 1]])
  assert.deepEqual(products[0].details.map(({ orderId, supplyId, quantity }) => [orderId, supplyId, quantity]),
    [['1', '101', 6], ['1', '102', 3]])
})

test('partial run records missing responses and failed supply; retry loads missing bundles without duplication', async () => {
  const incomplete = await loadReport(fixture({ failBundle: true, missingOrder: true }), period)
  assert.equal(incomplete.complete, false)
  assert.ok(incomplete.issues.some((issue) => issue.orderId === '4'))
  assert.ok(incomplete.issues.some((issue) => issue.supplyId === '104'))
  assert.equal(summarize(incomplete).stats.quantity, 10)
  const retry = fixture()
  const complete = await loadReport(retry, period, { previous: incomplete })
  assert.equal(complete.complete, true)
  assert.deepEqual(retry.calls.filter(([method]) => method === 'bundle').map(([, body]) => body.bundle_ids[0]), ['three'])
  const refreshed = await loadReport(fixture(), period)
  assert.deepEqual(summarize(complete), summarize(refreshed))
})

test('reports cursor loops, count mismatches, unknown statuses and lost page requests', async () => {
  const api = { async request(method, body) {
    if (method === 'list') return { order_ids: [1], last_id: 'same' }
    if (method === 'get') return { orders: [order(1, [supply(101, 'wrong-total'), supply(102, 'empty', 'UNSPECIFIED')])] }
    assert.deepEqual(body.bundle_ids, ['wrong-total'])
    return page([product(11, 'A', 2)], 5)
  } }
  const report = await loadReport(api, period)
  assert.equal(report.complete, false)
  assert.equal(report.entries.length, 0)
  assert.equal(report.issues.length, 3)
  const failed = await loadReport({ request: async () => { throw new Error('Нет ответа') } }, period)
  assert.equal(failed.complete, false)
  assert.equal(failed.issues[0].stage, 'Список заявок')
})

test('a shared composition is not counted twice; linked virtual mirror is excluded', async () => {
  const api = { async request(method, body) {
    if (method === 'list') return { order_ids: [1, 2] }
    if (method === 'get') return { orders: [
      order(1, [supply(101, 'shared'), supply(102, 'shared')]),
      { ...order(2, [supply(103, 'mirror')]), order_tags: { is_virtual: true, original_supply_id: 101 } }
    ] }
    assert.deepEqual(body.bundle_ids, ['shared'])
    return page([product(11, 'A', 2)], 1)
  } }
  const report = await loadReport(api, period)
  assert.deepEqual(report.entries.map(({ supplyId }) => supplyId), ['101'])
  assert.deepEqual(report.issues.map(({ supplyId }) => supplyId), ['102'])
})

test('Ozon transport retries temporary failures, honors Retry-After and preserves int64', async () => {
  let now = 0
  let calls = 0
  const sleeps = []
  const client = createOzonClient({ clientId: '42', apiKey: 'fixture-key' }, {
    now: () => now,
    sleep: async (duration) => { sleeps.push(duration); now += duration },
    fetch: async (url, options) => {
      assert.equal(url, 'https://api-seller.ozon.ru/v3/supply-order/list')
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers['Client-Id'], '42')
      assert.equal(options.headers['Api-Key'], 'fixture-key')
      if (++calls === 1) return new Response('ignored', { status: 429, headers: { 'Retry-After': '5' } })
      return new Response('{"order_ids":[9223372036854775807]}')
    }
  })
  assert.deepEqual(await client.request('list', {}), { order_ids: ['9223372036854775807'] })
  assert.equal(calls, 2)
  assert.ok(sleeps.includes(5000))
  assert.deepEqual(parseResponse('{"quantity":13,"sku":7}'), { quantity: 13, sku: 7 })
})

test('Excel has three sheets, numeric counts, text identifiers and a warning for partial data', async () => {
  const report = await loadReport(fixture({ failBundle: true }), period)
  const workbook = createWorkbook(report)
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name),
    ['Сводка по товарам', 'Детализация поставок', 'Ошибки и пропуски'])
  assert.equal(workbook.worksheets[0].getCell('C2').value, '11')
  assert.equal(workbook.worksheets[0].getCell('D2').value, 9)
  assert.equal(workbook.worksheets[1].getCell('C2').value, '101')
  assert.equal(workbook.worksheets[2].getCell('A2').value, 'Отчёт неполный')
  const bytes = await workbook.xlsx.writeBuffer()
  assert.equal(Buffer.from(bytes).subarray(0, 2).toString(), 'PK')
})

test('IPC keeps credentials out of UI and replaces a cached report when the period is loaded again', async () => {
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const { createRequire } = require('node:module')
  const vm = require('node:vm')
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'aromat-ozon-test-'))
  try {
    const handlers = new Map()
    const modulePath = require.resolve('../ozon/ipc.cjs')
    const load = createRequire(modulePath)
    const module = { exports: {} }
    const credential = 'fixture-not-a-real-key'
    vm.runInNewContext(await fs.readFile(modulePath, 'utf8'), { module, process, Buffer, require(name) {
      if (name === 'electron') return {
        app: { getPath: () => root },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        safeStorage: {
          isEncryptionAvailable: () => true,
          getSelectedStorageBackend: () => 'gnome_libsecret',
          encryptString: (text) => Buffer.from(text, 'utf8').reverse(),
          decryptString: (bytes) => Buffer.from(bytes).reverse().toString('utf8')
        }
      }
      if (name === './api.cjs') return { createOzonClient: (credentials) => {
        assert.equal(credentials.apiKey, credential)
        return fixture()
      } }
      return load(name)
    } })
    module.exports.registerOzon()
    const call = (method, input) => handlers.get('ozon:' + method)({ sender: {
      isDestroyed: () => false, send: () => {}
    } }, input)
    assert.equal((await call('settings')).data.hasKey, false)
    const result = await call('save', { clientId: '42', apiKey: credential })
    assert.equal(result.ok, true)
    assert.doesNotMatch(JSON.stringify(result), /fixture-not-a-real-key/)
    assert.doesNotMatch(JSON.stringify(await call('settings')), /fixture-not-a-real-key/)
    assert.equal((await fs.readFile(path.join(root, 'ozon', 'credentials.bin'))).includes(credential), false)
    assert.equal((await call('cached', period)).data, null)
    const first = await call('load', { period })
    assert.equal(first.data.stats.quantity, 21)
    assert.equal(first.data.lastSuccessfulAt, first.data.updatedAt)
    const second = await call('load', { period })
    assert.deepEqual(second.data.stats, first.data.stats)
    assert.equal((await fs.readdir(path.join(root, 'ozon', 'reports'))).length, 1)
    assert.equal((await call('cached', period)).data.stats.quantity, 21)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
