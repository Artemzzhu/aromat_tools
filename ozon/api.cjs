const base = 'https://api-seller.ozon.ru'
const paths = Object.freeze({
  list: '/v3/supply-order/list',
  get: '/v3/supply-order/get',
  bundle: '/v1/supply-order/bundle'
})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseResponse(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) &&
        /^-?\d+$/.test(context?.source ?? '')) return context.source
    return value
  })
}

function retryAfter(value, now) {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}

function createOzonClient(credentials, { fetch = globalThis.fetch, sleep = delay, now = Date.now } = {}) {
  const nextCall = new Map()
  return {
    async request(method, body) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(Math.max(0, (nextCall.get(method) ?? 0) - now()))
        // Ozon documents 1,800 calls/hour for list and get, independently.
        nextCall.set(method, now() + (method === 'bundle' ? 500 : 2100))
        let response
        let networkFailure = false
        try {
          response = await fetch(base + paths[method], {
            method: 'POST',
            headers: { 'Client-Id': credentials.clientId, 'Api-Key': credentials.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
            redirect: 'error'
          })
        } catch {
          networkFailure = true
        }
        if (response?.ok) {
          try {
            return parseResponse(await response.text())
          } catch {
            throw new Error('Ozon вернул нечитаемый ответ.')
          }
        }
        const status = response?.status
        if (status === 401 || status === 403) throw new Error('Ozon отказал в доступе. Проверьте Client ID и права API Key.')
        const transient = networkFailure || status === 408 || status === 429 || status >= 500
        if (response?.body) await response.body.cancel().catch(() => {})
        if (!transient || attempt === 4) {
          throw new Error(status ? `Ozon вернул ошибку HTTP ${status}.` : 'Нет ответа от Ozon после повторных запросов.')
        }
        await sleep(Math.max(500 * 2 ** attempt, retryAfter(response?.headers.get('retry-after'), now())))
      }
    }
  }
}

module.exports = { createOzonClient, parseResponse }
