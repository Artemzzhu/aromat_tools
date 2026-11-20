const scanInput = document.getElementById('scan-input')
const scanPrinter = document.getElementById('scan-printer')
const scanRefresh = document.getElementById('scan-refresh')
const scanReset = document.getElementById('scan-reset')
const scanStatus = document.getElementById('scan-status')
const scanCount = document.getElementById('scan-count')
const scanScreen = document.getElementById('scan')

const markingPrinter = /\b3B-300B\b/i
const seen = new Set()
const queue = []
let draining = false
let sent = 0

const usKeys = {
  Backquote: ['`', '~'], Minus: ['-', '_'], Equal: ['=', '+'],
  BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'],
  Period: ['.', '>'], Slash: ['/', '?']
}

function focusScanner() {
  if (!scanScreen.hidden) scanInput.focus({ preventScroll: true })
}

function updateScanCount() {
  scanCount.textContent = `Отправлено: ${sent} · В очереди: ${queue.length + Number(draining)}`
  scanReset.disabled = draining
}

async function refreshScanPrinter() {
  scanRefresh.disabled = true
  try {
    const printers = await window.labelPrinting?.printers() ?? []
    const available = printers.filter(({ name, displayName }) => markingPrinter.test(name + ' ' + displayName))
    const previous = scanPrinter.value
    scanPrinter.replaceChildren(...available.map(({ name, displayName }) => new Option(displayName || name, name)))
    if (available.some(({ name }) => name === previous)) scanPrinter.value = previous
    if (!available.length) scanPrinter.add(new Option('4BARCODE 3B-300B не найден', ''))
    scanStatus.textContent = scanPrinter.value ? 'Готово к сканированию.' : 'Подключите 4BARCODE 3B-300B и обновите список.'
  } catch {
    scanStatus.textContent = 'Не удалось получить список принтеров.'
  } finally {
    scanRefresh.disabled = false
    focusScanner()
  }
}

async function drainScanQueue() {
  if (draining) return
  while (queue.length) {
    const job = queue.shift()
    draining = true
    updateScanCount()
    try {
      const result = await window.labelPrinting.printMarking(job)
      if (!result.ok) throw new Error(result.reason)
      sent++
      scanStatus.textContent = result.warning || 'Этикетка отправлена на принтер.'
    } catch (error) {
      seen.delete(job.scan)
      scanStatus.textContent = error.message || 'Не удалось отправить этикетку. Отсканируйте её снова.'
    } finally {
      draining = false
      updateScanCount()
    }
  }
}

function scannerCharacter(event) {
  if (event.key === '\x1d' || (event.ctrlKey && event.code === 'BracketRight')) return '\x1d'
  if (event.ctrlKey || event.altKey || event.metaKey || event.key.length !== 1) return null
  if (/^Key[A-Z]$/.test(event.code)) {
    const letter = event.code.slice(3)
    return event.key === event.key.toUpperCase() ? letter : letter.toLowerCase()
  }
  if (/^Digit\d$/.test(event.code)) {
    const digit = event.code.slice(5)
    return event.shiftKey ? ')!@#$%^&*('[digit] : digit
  }
  return usKeys[event.code]?.[Number(event.shiftKey)] ?? event.key
}

scanInput.addEventListener('keydown', (event) => {
  const character = scannerCharacter(event)
  if (character === null) return
  event.preventDefault()
  const start = scanInput.selectionStart
  const end = scanInput.selectionEnd
  if (scanInput.value.length - (end - start) < scanInput.maxLength) {
    scanInput.setRangeText(character, start, end, 'end')
  }
})

document.getElementById('scan-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const scan = scanInput.value.replace(/^(?:\]d2|\[FNC1\]|\[GS\]|\x1d)/i, '')
    .replace(/\[(?:FNC1|GS)\]/gi, '\x1d')
  scanInput.value = ''
  if (!scan) return
  if (!scanPrinter.value || !window.labelPrinting?.printMarking) {
    scanStatus.textContent = 'Принтер недоступен. Подключите 4BARCODE 3B-300B и обновите список.'
    return
  }
  if (seen.has(scan)) {
    scanStatus.textContent = 'Этот код уже отправлен или находится в очереди текущей сессии.'
    return
  }
  seen.add(scan)
  queue.push({ scan, deviceName: scanPrinter.value })
  updateScanCount()
  void drainScanQueue()
})

scanRefresh.addEventListener('click', refreshScanPrinter)
scanPrinter.addEventListener('change', focusScanner)
scanReset.addEventListener('click', () => {
  seen.clear()
  sent = 0
  scanInput.value = ''
  scanStatus.textContent = 'Началась новая сессия.'
  updateScanCount()
  focusScanner()
})

document.addEventListener('screen-changed', ({ detail }) => {
  if (detail !== 'scan') {
    scanInput.value = ''
    return
  }
  focusScanner()
  void refreshScanPrinter()
})
