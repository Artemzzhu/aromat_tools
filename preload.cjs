const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('labelPrinting', {
  printers: () => ipcRenderer.invoke('labels:printers'),
  print: (job) => ipcRenderer.invoke('labels:print', job)
})
