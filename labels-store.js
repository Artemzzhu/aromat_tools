export function openLabelStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('aromat-label-library', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      const labels = db.createObjectStore('labels', { keyPath: 'id', autoIncrement: true })
      labels.createIndex('sourceId', 'sourceId')
      db.createObjectStore('sources')
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(createLabelStore(request.result))
  })
}

function createLabelStore(db) {
  const templateKey = (sourceId) => `zdl:${sourceId}`

  function transaction(mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['labels', 'sources'], mode)
      tx.onabort = () => reject(tx.error ?? new Error('Label storage transaction aborted'))
      const result = work(tx.objectStore('labels'), tx.objectStore('sources'))
      tx.oncomplete = () => resolve(result?.())
    })
  }

  return {
    list() {
      return transaction('readonly', (labels) => {
        const records = labels.getAll()
        return () => records.result
      })
    },

    readSources(ids) {
      return transaction('readonly', (_labels, sources) => {
        const requests = ids.map((id) => sources.get(id))
        return () => requests.map((request) => request.result)
      })
    },

    readTemplate(sourceId) {
      return transaction('readonly', (_labels, sources) => {
        const request = sources.get(templateKey(sourceId))
        return () => request.result
      })
    },

    add(name, { sourceId, source, page, zdl, dates }) {
      return transaction('readwrite', (labels, sources) => {
        const existing = sources.getKey(sourceId)
        existing.onsuccess = () => {
          if (existing.result === undefined) sources.add(source, sourceId)
        }
        const data = { name, sourceId, page }
        if (zdl) {
          sources.add(zdl, templateKey(sourceId))
          data.dates = dates
        }
        const record = labels.add(data)
        return () => record.result
      })
    },

    rename(id, name) {
      return transaction('readwrite', (labels) => {
        const record = labels.get(id)
        record.onsuccess = () => {
          if (record.result) labels.put({ ...record.result, name })
        }
      })
    },

    updateZdl(id, name, dates, pdf) {
      return transaction('readwrite', (labels, sources) => {
        const record = labels.get(id)
        record.onsuccess = () => {
          const label = record.result
          if (!label?.dates) {
            labels.transaction.abort()
            return
          }
          sources.put(pdf, label.sourceId)
          labels.put({ ...label, name, dates })
        }
      })
    },

    remove(id, sourceId) {
      return transaction('readwrite', (labels, sources) => {
        labels.delete(id)
        const remaining = labels.index('sourceId').count(sourceId)
        remaining.onsuccess = () => {
          if (remaining.result) return
          sources.delete(sourceId)
          sources.delete(templateKey(sourceId))
        }
      })
    }
  }
}
