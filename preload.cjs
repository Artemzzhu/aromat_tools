const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('labelPrinting', {
  printers: () => ipcRenderer.invoke('labels:printers'),
  printMarking: (job) => ipcRenderer.invoke('marking:print', job),
  submit: (job) => ipcRenderer.invoke('labels:submit', job)
})

contextBridge.exposeInMainWorld('ozonFbo', {
  settings: () => ipcRenderer.invoke('ozon:settings'),
  save: (input) => ipcRenderer.invoke('ozon:save', input),
  test: (input) => ipcRenderer.invoke('ozon:test', input),
  cached: (period) => ipcRenderer.invoke('ozon:cached', period),
  load: (input) => ipcRenderer.invoke('ozon:load', input),
  export: (period) => ipcRenderer.invoke('ozon:export', period),
  onProgress: (callback) => {
    ipcRenderer.on('ozon:progress', (_event, message) => callback(message))
  }
})
