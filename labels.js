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

function hasCopies({ quantity }) {
  return quantity.validity.valid && quantity.valueAsNumber > 0
}

function updateSelection() {
  const count = labels.filter(hasCopies).length
  for (const { edit } of labels) edit.disabled = busy || importing
  reset.disabled = busy || !labels.some(({ quantity }) => quantity.value || quantity.validity.badInput)
  byId('labels-empty').hidden = labels.length > 0
  byId('label-selection').textContent = 'Выбрано: ' + count
  review.disabled = busy || importing || (!count && labels.every(({ quantity }) => quantity.validity.valid))
}

function addLabel(name, source, page) {
  const row = rows.insertRow()
  const title = row.insertCell()
  title.textContent = name
  const quantity = document.createElement('input')
  quantity.type = 'number'
  quantity.className = 'quantity'
  quantity.inputMode = 'numeric'
  quantity.min = '0'
  quantity.max = '999'
  quantity.step = '1'
  quantity.setAttribute('aria-label', 'Количество: ' + name)
  row.insertCell().append(quantity)

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'secondary-action edit-label-action'
  edit.textContent = 'Изменить'
  edit.setAttribute('aria-label', 'Изменить: ' + name)
  row.insertCell().append(edit)

  const label = { name, source, page, quantity, edit }
  labels.push(label)
  quantity.addEventListener('input', updateSelection)
  edit.addEventListener('click', async () => {
    const result = await openLabelDialog(label, true)
    if (result.action === 'delete') {
      const index = labels.indexOf(label)
      labels.splice(index, 1)
      row.remove()
      updateSelection()
      const next = labels[index] ?? labels[index - 1]
      if (next) next.edit.focus()
      else byId('choose-labels').focus()
    } else if (result.action === 'apply') {
      label.name = result.name
      title.textContent = result.name
      quantity.setAttribute('aria-label', 'Количество: ' + result.name)
      edit.setAttribute('aria-label', 'Изменить: ' + result.name)
    }
  })
}

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

reset.addEventListener('click', () => {
  for (const { quantity } of labels) quantity.value = ''
  printStatus.textContent = ''
  updateSelection()
})
byId('refresh-printers').addEventListener('click', refreshPrinters)
refreshPrinters()

review.addEventListener('click', () => {
  printStatus.textContent = ''
  const invalid = labels.find(({ quantity }) => !quantity.validity.valid)
  if (invalid) {
    printStatus.textContent = 'Введите целое количество от 0 до 999 или оставьте поле пустым.'
    invalid.quantity.focus()
    invalid.quantity.reportValidity()
    return
  }
  const items = labels.filter(hasCopies).map((label) => ({ label, copies: label.quantity.valueAsNumber }))
  if (!items.length) return
  const total = items.reduce((sum, { copies }) => sum + copies, 0)
  pendingJob = { items, deviceName: printer.value, total }
  const virtual = /^Microsoft Print to PDF$/i.test(printer.value)
  const device = virtual ? 'Сохранение PDF' : printer.selectedOptions[0]?.textContent || 'Принтер не выбран'
  const canPrint = Boolean(printer.value) && !virtual
  byId('confirm-print-send').hidden = !canPrint
  byId('confirm-print-open').hidden = virtual
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
  if (!job || !['print', 'save', 'open'].includes(action)) return
  const { items, deviceName, total } = job
  if (!window.labelPrinting) {
    printStatus.textContent = 'Для печати и сохранения PDF откройте Aromat Tools.'
    return
  }
  busy = true
  const controls = [byId('choose-labels'), printer, byId('refresh-printers'),
    ...labels.map(({ quantity }) => quantity)]
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
    if (result.opened) {
      printStatus.textContent = 'Тираж открыт в PDF. Нажмите Ctrl+P в просмотрщике и выберите принтер.'
      return
    }
    for (const { label } of items) label.quantity.value = ''
    printStatus.textContent = result.saved ? 'PDF сохранён. Страниц: ' + total
      : 'Задание передано в Adobe Acrobat Reader. Экземпляров: ' + total
    if (result.warning) printStatus.textContent += '. ' + result.warning
  } catch (error) {
    printStatus.textContent = error.message
  } finally {
    busy = false
    for (const control of controls) control.disabled = false
    updateSelection()
  }
})
