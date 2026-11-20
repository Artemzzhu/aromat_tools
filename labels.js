import { getDocument, GlobalWorkerOptions } from './node_modules/pdfjs-dist/build/pdf.mjs'

const pdfDirectory = new URL('./node_modules/pdfjs-dist/', import.meta.url)
GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.mjs', pdfDirectory).href

const byId = (id) => document.getElementById(id)
const files = byId('label-files')
const drop = byId('label-drop')
const importStatus = byId('label-import-status')
const printStatus = byId('label-print-status')
const rows = byId('label-rows')
const selectAll = byId('select-labels')
const printer = byId('label-printer')
const width = byId('label-width')
const height = byId('label-height')
const review = byId('review-print')
const confirmation = byId('confirm-print')

const labels = []
let printers = []
let busy = false
let importing = false
let pendingJob

function updateSelection() {
  const count = labels.filter((label) => label.selected.checked).length
  selectAll.disabled = busy || !labels.length
  selectAll.checked = count > 0 && count === labels.length
  selectAll.indeterminate = count > 0 && count < labels.length
  byId('labels-empty').hidden = labels.length > 0
  byId('label-selection').textContent = 'Выбрано: ' + count
  review.disabled = busy || importing || !count
}

function addLabel(name, image) {
  const row = rows.insertRow()
  const selected = document.createElement('input')
  selected.type = 'checkbox'
  selected.checked = true
  selected.setAttribute('aria-label', 'Выбрать: ' + name)
  row.insertCell().append(selected)

  row.insertCell().textContent = name
  const quantity = document.createElement('input')
  quantity.type = 'number'
  quantity.className = 'quantity'
  quantity.required = true
  quantity.min = '1'
  quantity.max = '999'
  quantity.step = '1'
  quantity.placeholder = '—'
  quantity.setAttribute('aria-label', 'Количество: ' + name)
  row.insertCell().append(quantity)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'secondary-action'
  remove.textContent = 'Удалить'
  remove.setAttribute('aria-label', 'Удалить: ' + name)
  row.insertCell().append(remove)

  const label = { name, image, selected, quantity, remove }
  labels.push(label)
  selected.addEventListener('change', updateSelection)
  remove.addEventListener('click', () => {
    labels.splice(labels.indexOf(label), 1)
    row.remove()
    updateSelection()
  })
}

async function readPdf(file) {
  if (!/\.pdf$/i.test(file.name)) throw new Error('нужен файл PDF')
  if (file.size > 25 * 1024 * 1024) throw new Error('файл больше 25 МБ')

  const documentTask = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: new URL('cmaps/', pdfDirectory).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', pdfDirectory).href,
    wasmUrl: new URL('wasm/', pdfDirectory).href,
    useWasm: false,
    isEvalSupported: false
  })

  try {
    const pdf = await documentTask.promise
    if (pdf.numPages > 100) throw new Error('в файле больше 100 страниц')
    const entries = []
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      const { items } = await page.getTextContent()
      const text = items.map((item) => item.str ?? '').join(' ')
        .replace(/^\s*\d{8,14}\s+/, '').trim()
      const fallback = file.name.replace(/\.pdf$/i, '')
      const name = (text || fallback) + (pdf.numPages > 1 ? ' · стр. ' + number : '')
      const size = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: 1024 / Math.max(size.width, size.height) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      await page.render({ canvas, viewport }).promise
      const image = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!image) throw new Error('не удалось подготовить изображение этикетки')
      entries.push({ name, image })
      page.cleanup()
    }
    return entries
  } finally {
    await documentTask.destroy()
  }
}

async function importFiles(list) {
  if (busy || importing || !list.length) return
  importing = true
  importStatus.textContent = 'Загружаем PDF…'
  byId('choose-labels').disabled = true
  updateSelection()
  const messages = []
  let added = 0
  try {
    for (const file of list) {
      try {
        const entries = await readPdf(file)
        for (const entry of entries) addLabel(entry.name, entry.image)
        added += entries.length
      } catch (error) {
        const detail = ['InvalidPDFException', 'PasswordException'].includes(error.name)
          ? 'не удалось прочитать PDF' : error.message
        messages.push(file.name + ': ' + detail)
      }
    }
  } finally {
    importStatus.textContent = ['Добавлено: ' + added, ...messages].join(' · ')
    importing = false
    byId('choose-labels').disabled = false
    updateSelection()
  }
}

async function refreshPrinters() {
  const previous = printer.value
  byId('refresh-printers').disabled = true
  try {
    if (!window.labelPrinting) {
      printer.replaceChildren(new Option('Печать доступна в приложении', ''))
      return
    }
    printers = await window.labelPrinting.printers()
    printer.replaceChildren(...printers.map(({ name, displayName }) => new Option(displayName || name, name)))
    if (!printers.length) printer.add(new Option('Принтеры не найдены', ''))
    const preferred = printers.find(({ name }) => name === previous)
      ?? printers.find(({ name, displayName }) => /4B-2054/i.test(name + ' ' + displayName))
      ?? printers.find(({ isDefault }) => isDefault)
    if (preferred) printer.value = preferred.name
  } catch {
    printers = []
    printer.replaceChildren(new Option('Не удалось получить список', ''))
  } finally {
    byId('refresh-printers').disabled = false
  }
}

byId('choose-labels').addEventListener('click', () => files.click())
files.addEventListener('change', () => {
  const chosen = [...files.files]
  files.value = ''
  importFiles(chosen)
})

for (const eventName of ['dragover', 'drop']) {
  document.addEventListener(eventName, (event) => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault()
  })
}
drop.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = busy || importing ? 'none' : 'copy'
  drop.classList.toggle('dragging', !busy && !importing)
})
drop.addEventListener('dragleave', (event) => {
  if (!drop.contains(event.relatedTarget)) drop.classList.remove('dragging')
})
drop.addEventListener('drop', (event) => {
  event.preventDefault()
  drop.classList.remove('dragging')
  importFiles([...event.dataTransfer.files])
})

selectAll.addEventListener('change', () => {
  for (const label of labels) label.selected.checked = selectAll.checked
  updateSelection()
})
byId('refresh-printers').addEventListener('click', refreshPrinters)
refreshPrinters()

review.addEventListener('click', () => {
  printStatus.textContent = ''
  const selected = labels.filter((label) => label.selected.checked)
  const invalid = selected.find(({ quantity }) => !quantity.validity.valid)
  if (invalid) {
    printStatus.textContent = 'Введите целое количество от 1 до 999 для каждой выбранной этикетки.'
    invalid.quantity.focus()
    invalid.quantity.reportValidity()
    return
  }
  if (!width.reportValidity() || !height.reportValidity()) return
  const items = selected.map((label) => ({ label, copies: label.quantity.valueAsNumber }))
  const total = items.reduce((sum, { copies }) => sum + copies, 0)
  pendingJob = { items, deviceName: printer.value, width: width.valueAsNumber, height: height.valueAsNumber }
  const device = printer.selectedOptions[0].textContent
  byId('print-summary').textContent = `${device} · ${width.value} × ${height.value} мм · всего экземпляров: ${total}`
  byId('print-summary-items').replaceChildren(...items.map(({ label, copies }) => {
    const item = document.createElement('li')
    item.textContent = `${label.name} × ${copies}`
    return item
  }))
  confirmation.returnValue = 'cancel'
  confirmation.showModal()
})

confirmation.addEventListener('close', async () => {
  const job = pendingJob
  pendingJob = undefined
  if (confirmation.returnValue !== 'print' || !job) return
  const { items, ...settings } = job
  if (!settings.deviceName) {
    printStatus.textContent = window.labelPrinting ? 'Подключите принтер и обновите список.' : 'Для отправки на принтер откройте Aromat Tools.'
    return
  }

  busy = true
  const controls = [byId('choose-labels'), printer, byId('refresh-printers'), width, height,
    ...labels.flatMap(({ selected, quantity, remove }) => [selected, quantity, remove])]
  for (const control of controls) control.disabled = true
  updateSelection()
  let sent = 0
  printStatus.textContent = 'Отправляем этикетки в очередь печати…'
  try {
    for (const { label, copies } of items) {
      const image = new Uint8Array(await label.image.arrayBuffer())
      const result = await window.labelPrinting.print({ ...settings, copies, image })
      if (!result.ok) throw new Error(label.name + ': ' + (result.reason || 'принтер отклонил задание'))
      label.selected.checked = false
      sent += copies
    }
    printStatus.textContent = 'В очередь печати отправлено экземпляров: ' + sent
  } catch (error) {
    printStatus.textContent = `Отправлено экземпляров: ${sent}. ${error.message}`
  } finally {
    busy = false
    for (const control of controls) control.disabled = false
    updateSelection()
  }
})
