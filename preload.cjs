const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('labelPrinting', {
  printers: () => ipcRenderer.invoke('labels:printers'),
  printMarking: (job) => ipcRenderer.invoke('marking:print', job),
  submit: (job) => ipcRenderer.invoke('labels:submit', job)
})
