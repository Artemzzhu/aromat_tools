const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('labelPrinting', {
  printers: () => ipcRenderer.invoke('labels:printers'),
  submit: (job) => ipcRenderer.invoke('labels:submit', job)
})
