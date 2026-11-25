const ExcelJS = require('exceljs')
const { summarize } = require('./report.cjs')

function createWorkbook(report, selection) {
  const { products } = summarize(report)
  const included = selection ? products.filter(({ offerId, sku }) => offerId === selection.offerId && sku === selection.sku) : products
  if (selection && !included.length) return null
  const workbook = new ExcelJS.Workbook()
  const summary = workbook.addWorksheet('Сводка по товарам')
  const detail = workbook.addWorksheet('Детализация поставок')
  const errors = workbook.addWorksheet('Ошибки и пропуски')

  function columns(sheet, definitions) {
    sheet.columns = definitions.map(([header, width]) => ({ header, width }))
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF13392E' } }
  }

  columns(summary, [['Артикул продавца', 24], ['Наименование товара', 45], ['SKU Ozon', 22],
    ['Заявлено к поставке', 24], ['Количество поставок', 24]])
  columns(detail, [['Дата поставки (таймслот)', 29], ['Номер заявки', 22], ['Номер поставки', 22],
    ['Артикул', 24], ['Наименование', 45], ['SKU', 22], ['Заявлено к поставке', 24], ['Статус', 20],
    ['ID заявки', 22]])
  columns(errors, [['Этап или тип', 25], ['ID заявки', 22], ['ID поставки', 22], ['Причина', 80]])

  for (const product of included) {
    const { offerId, name, sku, quantity, supplyCount } = product
    summary.addRow([offerId, name, sku, quantity, supplyCount])
    const rows = selection
      ? [...product.details].sort((a, b) => b.date.localeCompare(a.date) || a.supplyId.localeCompare(b.supplyId))
      : product.details
    for (const row of rows) {
      detail.addRow([row.date, row.orderNumber, row.supplyId, offerId, name, sku, row.quantity, row.status, row.orderId])
    }
  }
  if (!report.complete) errors.addRow(['Отчёт неполный', '', '', 'Итоги включают только полностью загруженные составы.'])
  for (const issue of selection ? [] : report.issues) errors.addRow([issue.stage, issue.orderId, issue.supplyId, issue.reason])
  for (const product of included) {
    if (!product.offerId) errors.addRow(['Нет артикула', '', '', 'Товар учтён отдельно по SKU ' + product.sku])
  }
  for (const sheet of [summary, detail, errors]) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount } }
  }
  return workbook
}

module.exports = { createWorkbook }
