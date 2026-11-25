const fs = require('node:fs/promises')
const path = require('node:path')
const CFB = require('cfb')
const { PNG } = require('pngjs')
const fontkit = require('@pdf-lib/fontkit')
const { PDFDocument, degrees, rgb } = require('pdf-lib')
const bwip = require('bwip-js')

const maxBytes = 4 * 1024 * 1024
const geometryUnitsPerPoint = 200000
const pointsPerMillimeter = 72 / 25.4
const targetWidth = 121.88
const targetHeight = 70.86
const cyrillic = new TextDecoder('windows-1251')
const monthPattern = /^(0[1-9]|1[0-2])\.([1-9]\d{3})$/

class ZdlError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZdlError'
  }
}

function unsupported() {
  return new ZdlError('Этот макет ZDL не поддерживается. Нужен шаблон DesignPro того же типа, что и «ДОЛЬЧЕ ВИТА — БАККАРА».')
}

function extractContents(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > maxBytes) {
    throw new ZdlError('Файл ZDL должен быть непустым и размером до 4 МБ.')
  }
  const signature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  const file = Buffer.from(bytes)
  if (!file.subarray(0, 8).equals(signature)) throw unsupported()
  let contents
  try {
    const compound = CFB.read(file, { type: 'buffer' })
    const entry = CFB.find(compound, '/Contents')
    if (entry?.content && entry.size <= maxBytes) contents = Buffer.from(entry.content)
  } catch {
    throw new ZdlError('Не удалось прочитать файл ZDL.')
  }
  if (!contents || contents.length < 8 || contents.toString('ascii', 0, 4) !== '#ADZ' ||
      contents.readUInt32LE(4) !== 5) throw unsupported()
  return contents
}

function textValue(contents, start, end) {
  const data = contents.toString('latin1', start, end)
  const chars = []
  for (const match of data.matchAll(/\x01([\x20-\xff])\x00\x00\x00/g)) {
    chars.push(match[1].charCodeAt(0))
  }
  return cyrillic.decode(Uint8Array.from(chars)).trim()
}

function geometry(contents, offset, width, height) {
  if (offset < 0 || offset + 20 > contents.length || contents.readUInt32LE(offset) !== 40) {
    throw unsupported()
  }
  const [left, top, right, bottom] = [4, 8, 12, 16].map((delta) =>
    contents.readInt32LE(offset + delta) / geometryUnitsPerPoint)
  if (left < 0 || top > 0 || right <= left || bottom >= top || right > width + 0.1 || -bottom > height + 0.1) {
    throw unsupported()
  }
  return { x: left, y: height + bottom, width: right - left, height: top - bottom }
}

function classOffset(contents, name, start = 8) {
  const marker = Buffer.from(name, 'ascii')
  // DesignPro serializes the first use of each MFC class as its name length and name.
  const length = Buffer.from([marker.length, 0])
  const offset = contents.indexOf(Buffer.concat([length, marker]), start)
  if (offset < 0) throw unsupported()
  return offset + length.length + marker.length
}

function textRectangles(contents, from, to) {
  const signature = Buffer.from([0x0b, 0x80, 40, 0, 0, 0])
  const result = []
  for (let offset = contents.indexOf(signature, from); offset >= 0 && offset < to;
    offset = contents.indexOf(signature, offset + signature.length)) {
    result.push(offset + 2)
  }
  return result
}

function readLogo(contents, bitmap, end) {
  const start = contents.indexOf('BM', bitmap, 'ascii')
  if (start < bitmap || start + 54 > end) throw unsupported()
  const size = contents.readUInt32LE(start + 2)
  const pixels = contents.readUInt32LE(start + 10)
  const header = contents.readUInt32LE(start + 14)
  const width = contents.readInt32LE(start + 18)
  const height = contents.readInt32LE(start + 22)
  const bitDepth = contents.readUInt16LE(start + 28)
  const stride = Math.ceil(width * bitDepth / 32) * 4
  const rows = Math.abs(height)
  if (size < 54 || start + size > end || pixels < 54 || header !== 40 ||
      width < 1 || rows < 1 || width * rows > 2000000 || ![24, 32].includes(bitDepth) ||
      contents.readUInt16LE(start + 26) !== 1 || contents.readUInt32LE(start + 30) !== 0 ||
      pixels + stride * rows > size) throw unsupported()
  const image = new PNG({ width, height: rows })
  const bytesPerPixel = bitDepth / 8
  for (let y = 0; y < rows; y++) {
    const row = start + pixels + (height > 0 ? rows - y - 1 : y) * stride
    for (let x = 0; x < width; x++) {
      const pixel = row + x * bytesPerPixel
      const channel = (y * width + x) * 4
      image.data[channel] = contents[pixel + 2]
      image.data[channel + 1] = contents[pixel + 1]
      image.data[channel + 2] = contents[pixel]
      image.data[channel + 3] = 255
    }
  }
  return { png: PNG.sync.write(image), pos: start + size }
}

function parseLayout(bytes) {
  const contents = extractContents(bytes)
  const template = classOffset(contents, 'CTemplateInfo')
  const layer = classOffset(contents, 'CGELayerArray', template)
  if (contents.readUInt16LE(layer) !== 8) throw unsupported()
  const size = /\b(\d+(?:[.,]\d+)?)\s*[xх]\s*(\d+(?:[.,]\d+)?)/i.exec(cyrillic.decode(contents.subarray(template, layer)))
  if (!size) throw unsupported()
  const [width, height] = size.slice(1).map((value) => Number(value.replace(',', '.')) * pointsPerMillimeter)
  if (width < 30 || height < 30 || width > 850 || height > 850) throw unsupported()

  const first = classOffset(contents, 'CGETextRect', layer)
  const barcode = classOffset(contents, 'CGEBarcode', first)
  const frame = classOffset(contents, 'CGERectangle', barcode)
  const bitmap = classOffset(contents, 'CGEBitmap', frame)
  const end = classOffset(contents, 'CGELabel', bitmap)
  const titles = textRectangles(contents, first, barcode)
  const descriptions = textRectangles(contents, barcode, frame)
  const weights = textRectangles(contents, frame, bitmap)
  if (titles.length !== 1 || descriptions.length !== 2 || weights.length !== 1 ||
      textValue(contents, first, titles[0]) !== '') throw unsupported()
  const [title] = titles
  const [dates, sku] = descriptions
  const [weight] = weights

  const titleText = textValue(contents, title, barcode)
  const skuText = textValue(contents, sku, frame)
  const weightText = textValue(contents, weight, bitmap)
  const ean = textValue(contents, barcode, dates)
  const dateText = textValue(contents, dates, sku)
  const dateFields = /^Изготовлено:\s*(\d{2}\.\d{4})\s*Годен до:\s*(\d{2}\.\d{4})$/u.exec(dateText)
  if (!titleText || !skuText || !weightText || !/^\d{13}$/.test(ean) ||
      !dateFields || !monthPattern.test(dateFields[1]) || !monthPattern.test(dateFields[2])) throw unsupported()
  const digits = [...ean].map(Number)
  const checksum = digits.slice(0, 12).reduce((sum, digit, index) => sum + digit * (index % 2 ? 3 : 1), 0)
  if ((10 - checksum % 10) % 10 !== digits[12]) throw new ZdlError('В шаблоне ZDL некорректный штрихкод EAN-13.')

  const { png, pos } = readLogo(contents, bitmap, end)
  const box = (offset) => geometry(contents, offset, width, height)
  return { width, height, ean, png, titleText, skuText, weightText,
    manufactured: dateFields[1], expires: dateFields[2],
    title: box(title), sku: box(sku), dates: box(dates), weight: box(weight), frame: box(frame),
    barcode: box(barcode), logo: box(pos) }
}

async function systemFonts() {
  const windows = process.platform === 'win32'
  const folder = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')
  const files = windows ? ['arial.ttf', 'arialbd.ttf', 'times.ttf']
    : ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSerif-Regular.ttf']
  const candidates = windows ? [folder] : [
    '/usr/share/fonts/truetype/liberation2', '/usr/share/fonts/truetype/liberation'
  ]
  for (const directory of candidates) {
    try {
      return await Promise.all(files.map((name) => fs.readFile(path.join(directory, name))))
    } catch {
      // Try the next system font directory.
    }
  }
  throw new ZdlError('Не найдены системные шрифты для печати этикетки ZDL.')
}

function drawEan(page, font, box, ean) {
  const [{ sbs }] = bwip.raw({ bcid: 'ean13', text: ean })
  const module = box.width / 113
  const barsX = box.x + 11 * module
  const aboveDigits = Math.min(10, box.height / 3)
  const barHeight = box.height - aboveDigits
  let position = 0
  for (let i = 0; i < sbs.length; i++) {
    const count = sbs[i]
    if (i % 2 === 0) {
      const guard = position < 3 || (position >= 45 && position < 50) || position >= 92
      const extension = guard ? Math.min(module * 4, aboveDigits / 2) : 0
      page.drawRectangle({ x: barsX + position * module, y: box.y + aboveDigits - extension,
        width: count * module, height: barHeight + extension })
    }
    position += count
  }
  const size = Math.min(8, 5.4 * module)
  const digitAt = (digit, units) => page.drawText(digit, {
    x: barsX + units * module - font.widthOfTextAtSize(digit, size) / 2, y: box.y + 1, font, size
  })
  digitAt(ean[0], -6)
  for (let i = 0; i < 6; i++) {
    digitAt(ean[i + 1], 6.5 + i * 7)
    digitAt(ean[i + 7], 53.5 + i * 7)
  }
}

async function convertZdl(bytes, updates = {}) {
  const layout = parseLayout(bytes)
  const manufactured = updates.manufactured ?? layout.manufactured
  const expires = updates.expires ?? layout.expires
  if (typeof manufactured !== 'string' || typeof expires !== 'string' ||
      !monthPattern.test(manufactured) || !monthPattern.test(expires)) {
    throw new ZdlError('Введите даты в формате ММ.ГГГГ.')
  }
  const chronological = (month) => month.slice(3) + month.slice(0, 2)
  if (chronological(expires) < chronological(manufactured)) {
    throw new ZdlError('Срок годности должен быть не раньше даты изготовления.')
  }

  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const [sans, bold, serif] = await Promise.all((await systemFonts()).map((data) => pdf.embedFont(data, { subset: true })))
  const logo = await pdf.embedPng(layout.png)
  const page = pdf.addPage([targetWidth, targetHeight])
  const scale = Math.min(targetWidth / layout.width, targetHeight / layout.height)
  const offsetX = (targetWidth - layout.width * scale) / 2
  const offsetY = (targetHeight - layout.height * scale) / 2
  const boxOnPage = ({ x, y, width, height }) => ({
    x: offsetX + x * scale, y: offsetY + y * scale, width: width * scale, height: height * scale
  })

  function drawText(text, font, size, area) {
    const box = boxOnPage(area)
    const fontSize = Math.min(size * scale, box.width / font.widthOfTextAtSize(text, 1))
    const textHeight = font.heightAtSize(fontSize, { descender: false })
    page.drawText(text, {
      x: box.x + (box.width - font.widthOfTextAtSize(text, fontSize)) / 2,
      y: box.y + (box.height - textHeight) / 2, font, size: fontSize
    })
  }

  function drawRotated(lines, font, size, area) {
    const box = boxOnPage(area)
    const rowWidth = box.width / lines.length
    for (const [index, line] of lines.entries()) {
      const fontSize = Math.min(size * scale, box.height / font.widthOfTextAtSize(line, 1))
      const textHeight = font.heightAtSize(fontSize, { descender: false })
      page.drawText(line, {
        x: box.x + box.width - (index + 0.5) * rowWidth - textHeight / 2,
        y: box.y + (box.height + font.widthOfTextAtSize(line, fontSize)) / 2,
        font, size: fontSize, rotate: degrees(270)
      })
    }
  }

  const imageBox = boxOnPage(layout.logo)
  const fitted = logo.scaleToFit(imageBox.width, imageBox.height)
  page.drawImage(logo, {
    ...fitted, x: imageBox.x + (imageBox.width - fitted.width) / 2,
    y: imageBox.y + (imageBox.height - fitted.height) / 2
  })
  drawText(layout.skuText, sans, 10, layout.sku)
  drawText(layout.titleText, serif, 16, layout.title)
  page.drawRectangle({ ...boxOnPage(layout.frame), borderWidth: 0.6 * scale, borderColor: rgb(0, 0, 0) })
  drawRotated([layout.weightText], sans, 11, layout.weight)
  drawRotated(['Изготовлено: ' + manufactured, 'Годен до: ' + expires], bold, 9, layout.dates)
  drawEan(page, sans, boxOnPage(layout.barcode), layout.ean)
  return { pdf: await pdf.save(), manufactured, expires }
}

module.exports = { convertZdl, ZdlError }
