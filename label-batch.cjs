const { PDFDocument, PDFPage } = require('pdf-lib')

async function buildLabelBatch(sources, items) {
  const documents = new Map()
  const batch = await PDFDocument.create()
  for (const { source, page, copies } of items) {
    if (!documents.has(source)) documents.set(source, await PDFDocument.load(sources[source]))
    const [original] = await batch.copyPages(documents.get(source), [page])
    batch.addPage(original)
    for (let copy = 1; copy < copies; copy++) {
      const node = original.node.clone(batch.context)
      batch.addPage(PDFPage.of(node, batch.context.register(node), batch))
    }
  }
  return batch.save()
}

module.exports = { buildLabelBatch }
