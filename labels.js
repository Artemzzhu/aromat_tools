import { getDocument, GlobalWorkerOptions } from './node_modules/pdfjs-dist/build/pdf.mjs'

const pdfDirectory = new URL('./node_modules/pdfjs-dist/', import.meta.url)
GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.mjs', pdfDirectory).href

const byId = (id) => document.getElementById(id)
const files = byId('label-files')
const drop = byId('label-drop')
const importStatus = byId('label-import-status')
const printStatus = byId('label-print-status')
const rows = byId('label-rows')
const printer = byId('label-printer')
const review = byId('review-print')
const confirmation = byId('confirm-print')
const reset = byId('reset-print')
const preview = byId('preview-label')
const previewImage = byId('preview-image')
const previewName = byId('preview-name')
const deleteLabel = byId('delete-label')
const applyLabel = byId('apply-label')

const labels = []
let printers = []
let busy = false
let importing = false
let pendingJob

const selection = new Map()
const pageSize = 8
const search = byId('label-search')
const queue = byId('queue-labels')
let currentPage = 1
let selectedOnly = false

function plural(number, forms) {
  const last = number % 10
  const tens = number % 100
  return forms[tens >= 11 && tens <= 14 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2]
}

function updateSelection() {
  const count = selection.size
  const total = [...selection.values()].reduce((sum, { quantity }) =>
    sum + (quantity.validity.valid ? quantity.valueAsNumber : 0), 0)
  byId('all-count').textContent = labels.length
  byId('selected-count').textContent = count
  byId('label-selection').textContent = `${count} ${plural(count, ['позиция', 'позиции', 'позиций'])} · ${total} ${plural(total, ['копия', 'копии', 'копий'])}`
  byId('queue-empty').hidden = count > 0
  reset.disabled = busy || !count
  review.disabled = busy || importing || !count
  for (const { quantity, remove } of selection.values()) {
    quantity.disabled = busy
    remove.disabled = busy
  }
  for (const { checkbox, edit } of labels) {
    checkbox.disabled = busy
    edit.disabled = busy || importing
  }
}

function renderTable() {
  const query = search.value.trim().toLocaleLowerCase('ru')
  const filtered = labels.filter((label) =>
    (!selectedOnly || selection.has(label)) && label.name.toLocaleLowerCase('ru').includes(query))
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  currentPage = Math.min(currentPage, pages)
  const start = (currentPage - 1) * pageSize
  const visible = filtered.slice(start, start + pageSize).map(({ row }) => row)
  const focused = document.activeElement
  rows.replaceChildren(...visible)
  if (rows.contains(focused)) focused.focus({ preventScroll: true })
  const empty = byId('labels-empty')
  empty.hidden = filtered.length > 0
  empty.textContent = !labels.length ? 'Загрузите PDF или перетащите файлы сюда.'
    : query ? 'По этому запросу этикеток нет.' : 'Выбранных этикеток пока нет.'
  byId('label-page').textContent = `Страница ${currentPage} из ${pages}`
  byId('previous-page').disabled = currentPage === 1
  byId('next-page').disabled = currentPage === pages
}

function setSelected(label, checked) {
  label.checkbox.checked = checked
  label.row.classList.toggle('selected-label', checked)
  if (checked) {
    if (selection.has(label)) return
    const entry = document.createElement('li')
    const title = document.createElement('span')
    title.textContent = label.name
    const quantity = document.createElement('input')
    quantity.type = 'number'
    quantity.className = 'quantity'
    quantity.inputMode = 'numeric'
    quantity.min = '1'
    quantity.max = '999'
    quantity.step = '1'
    quantity.required = true
    quantity.value = '1'
    quantity.setAttribute('aria-label', 'Количество копий: ' + label.name)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'queue-remove'
    remove.textContent = '×'
    remove.setAttribute('aria-label', 'Убрать из печати: ' + label.name)
    entry.append(title, quantity, remove)
    selection.set(label, { entry, title, quantity, remove })
    const nextSelected = labels.slice(labels.indexOf(label) + 1).find((candidate) => selection.has(candidate))
    queue.insertBefore(entry, selection.get(nextSelected)?.entry ?? null)
    quantity.addEventListener('input', updateSelection)
    remove.addEventListener('click', () => {
      setSelected(label, false)
      if (rows.contains(label.checkbox)) label.checkbox.focus()
      else review.disabled ? search.focus() : review.focus()
    })
  } else {
    selection.get(label)?.entry.remove()
    selection.delete(label)
  }
  if (selectedOnly) renderTable()
  updateSelection()
}

function addLabel(name, source, page) {
  const row = document.createElement('tr')
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  row.insertCell().append(checkbox)
  const title = row.insertCell()
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'secondary-action edit-label-action'
  edit.textContent = 'Изменить'
  row.insertCell().append(edit)
  const label = { name, source, page, row, checkbox, edit }

  function updateName() {
    title.textContent = label.name
    checkbox.setAttribute('aria-label', 'Выбрать: ' + label.name)
    edit.setAttribute('aria-label', 'Изменить: ' + label.name)
    const item = selection.get(label)
    if (item) {
      item.title.textContent = label.name
      item.quantity.setAttribute('aria-label', 'Количество копий: ' + label.name)
      item.remove.setAttribute('aria-label', 'Убрать из печати: ' + label.name)
    }
  }

  updateName()
  labels.push(label)
  checkbox.addEventListener('change', () => setSelected(label, checkbox.checked))
  edit.addEventListener('click', async () => {
    const result = await openLabelDialog(label, true)
    if (result.action === 'delete') {
      labels.splice(labels.indexOf(label), 1)
      setSelected(label, false)
      renderTable()
      rows.querySelector('.edit-label-action')?.focus()
      if (!rows.children.length) search.focus()
    } else if (result.action === 'apply') {
      label.name = result.name
      updateName()
      renderTable()
    }
  })
  renderTable()
  updateSelection()
}

function setFilter(onlySelected) {
  selectedOnly = onlySelected
  currentPage = 1
  byId('filter-all').setAttribute('aria-pressed', String(!selectedOnly))
  byId('filter-selected').setAttribute('aria-pressed', String(selectedOnly))
  renderTable()
}

search.addEventListener('input', () => {
  currentPage = 1
  renderTable()
})
byId('filter-all').addEventListener('click', () => setFilter(false))
byId('filter-selected').addEventListener('click', () => setFilter(true))
byId('previous-page').addEventListener('click', () => { currentPage--; renderTable() })
byId('next-page').addEventListener('click', () => { currentPage++; renderTable() })
renderTable()

async function* readPdf(file) {
  if (!/\.pdf$/i.test(file.name)) throw new Error('нужен файл PDF')
  if (file.size > 25 * 1024 * 1024) throw new Error('файл больше 25 МБ')

  const source = new Uint8Array(await file.arrayBuffer())
  const documentTask = getDocument({
    data: source.slice(),
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
      canvas.setAttribute('role', 'img')
      canvas.setAttribute('aria-label', 'Предпросмотр этикетки из PDF')
      page.cleanup()
      yield { name, canvas, source, page: number - 1 }
    }
  } finally {
    await documentTask.destroy()
  }
}

function openLabelDialog({ name, canvas }, editing = false) {
  byId('preview-label-title').textContent = editing ? 'Изменить этикетку' : 'Новая этикетка'
  byId('close-label-dialog').setAttribute('aria-label', editing ? 'Закрыть' : 'Прекратить загрузку')
  applyLabel.textContent = editing ? 'Сохранить' : 'Добавить'
  deleteLabel.hidden = !editing
  previewImage.replaceChildren(...(canvas ? [canvas] : []))
  previewName.value = name.trim().slice(0, 250)
  previewName.setCustomValidity('')
  preview.returnValue = 'cancel'
  return new Promise((resolve) => {
    preview.addEventListener('close', () => {
      previewImage.replaceChildren()
      resolve({ action: preview.returnValue, name: previewName.value.trim() })
    }, { once: true })
    preview.showModal()
    previewName.select()
  })
}

byId('close-label-dialog').addEventListener('click', () => preview.close('cancel'))
deleteLabel.addEventListener('click', () => preview.close('delete'))

previewName.addEventListener('input', () => {
  previewName.setCustomValidity(previewName.value.trim() ? '' : 'Введите название этикетки.')
})

async function importFiles(list) {
  if (busy || importing || !list.length) return
  importing = true
  importStatus.textContent = 'Загружаем PDF…'
  byId('choose-labels').disabled = true
  updateSelection()
  const messages = []
  try {
    for (const file of list) {
      try {
        for await (const entry of readPdf(file)) {
          const result = await openLabelDialog(entry)
          if (result.action !== 'apply') return
          addLabel(result.name, entry.source, entry.page)
        }
      } catch (error) {
        const detail = ['InvalidPDFException', 'PasswordException'].includes(error.name)
          ? 'не удалось прочитать PDF' : error.message
        messages.push(file.name + ': ' + detail)
      }
    }
  } finally {
    importStatus.textContent = messages.join(' · ')
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
const printScreen = byId('print')
printScreen.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = busy || importing ? 'none' : 'copy'
  drop.classList.toggle('dragging', !busy && !importing)
})
printScreen.addEventListener('dragleave', (event) => {
  if (!printScreen.contains(event.relatedTarget)) drop.classList.remove('dragging')
})
printScreen.addEventListener('drop', (event) => {
  event.preventDefault()
  drop.classList.remove('dragging')
  importFiles([...event.dataTransfer.files])
})

reset.addEventListener('click', () => {
  for (const label of selection.keys()) setSelected(label, false)
  printStatus.textContent = ''
  updateSelection()
})
byId('refresh-printers').addEventListener('click', refreshPrinters)
refreshPrinters()

review.addEventListener('click', () => {
  printStatus.textContent = ''
  const invalid = [...selection.values()].find(({ quantity }) => !quantity.validity.valid)
  if (invalid) {
    printStatus.textContent = 'Введите целое количество от 1 до 999 для каждой выбранной этикетки.'
    invalid.quantity.focus()
    invalid.quantity.reportValidity()
    return
  }
  const items = labels.filter((label) => selection.has(label))
    .map((label) => ({ label, copies: selection.get(label).quantity.valueAsNumber }))
  if (!items.length) return
  const total = items.reduce((sum, { copies }) => sum + copies, 0)
  pendingJob = { items, deviceName: printer.value, total }
  const virtual = /^Microsoft Print to PDF$/i.test(printer.value)
  const device = virtual ? 'Сохранение PDF' : printer.selectedOptions[0]?.textContent || 'Принтер не выбран'
  byId('confirm-print-send').hidden = virtual
  byId('print-summary').textContent = `${device} · всего экземпляров: ${total}`
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
  const action = confirmation.returnValue
  if (!job || !['print', 'save'].includes(action)) return
  const { items, deviceName, total } = job
  if (!window.labelPrinting) {
    printStatus.textContent = 'Для печати и сохранения PDF откройте Aromat Tools.'
    return
  }
  if (action === 'print' && !deviceName) {
    printStatus.textContent = 'Подключите принтер и обновите список.'
    return
  }

  busy = true
  const controls = [byId('choose-labels'), printer, byId('refresh-printers')]
  for (const control of controls) control.disabled = true
  updateSelection()
  printStatus.textContent = 'Готовим PDF…'
  try {
    const sources = [...new Set(items.map(({ label }) => label.source))]
    const pages = items.map(({ label, copies }) => ({
      source: sources.indexOf(label.source), page: label.page, copies
    }))
    const result = await window.labelPrinting.submit({ action, deviceName, sources, items: pages })
    if (result.canceled) {
      printStatus.textContent = ''
      return
    }
    if (!result.ok) throw new Error(result.reason || 'Не удалось отправить PDF на принтер.')
    for (const { label } of items) setSelected(label, false)
    printStatus.textContent = result.saved ? 'PDF сохранён. Страниц: ' + total
      : 'В очередь печати отправлено экземпляров: ' + total
    if (result.warning) printStatus.textContent += '. ' + result.warning
  } catch (error) {
    printStatus.textContent = error.message
  } finally {
    busy = false
    for (const control of controls) control.disabled = false
    updateSelection()
  }
})
