const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ovl', {
  on: (fn) => ipcRenderer.on('ovl', (_e, m) => fn(m)),
});
