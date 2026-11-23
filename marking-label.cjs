const { PDFDocument, rgb } = require('pdf-lib')
const bwip = require('bwip-js')

async function buildMarkingLabel(payload) {
  // Data Matrix ASCII codewords. FNC1 is 232, digit pairs are 130–229.
  const codewords = [232]
  for (let index = 0; index < payload.length; index++) {
    const pair = payload.slice(index, index + 2)
    if (/^\d{2}$/.test(pair)) {
      codewords.push(130 + Number(pair))
      index++
    } else {
      codewords.push(payload[index] === '\x1d' ? 232 : payload.charCodeAt(index) + 1)
    }
  }
  const text = codewords.map((code) => '^' + String(code).padStart(3, '0')).join('')
  const [{ pixs, pixx, pixy }] = bwip.raw({ bcid: 'datamatrix', text, raw: true })
  const pointsPerMillimeter = 72 / 25.4
  const size = 20 * pointsPerMillimeter
  const dpi = 300
  const pixelsPerModule = Math.floor((18 * dpi / 25.4) / Math.max(pixx, pixy))
  const moduleSize = pixelsPerModule * 72 / dpi
  const left = (size - pixx * moduleSize) / 2
  const bottom = (size - pixy * moduleSize) / 2
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([size, size])
  const black = rgb(0, 0, 0)
  for (let y = 0; y < pixy; y++) {
    let x = 0
    while (x < pixx) {
      const start = x
      while (x < pixx && pixs[y * pixx + x]) x++
      if (x === start) {
        x++
        continue
      }
      page.drawRectangle({
        x: left + start * moduleSize,
        y: bottom + (pixy - y - 1) * moduleSize,
        width: (x - start) * moduleSize,
        height: moduleSize,
        color: black
      })
    }
  }
  return pdf.save()
}

module.exports = { buildMarkingLabel }
