const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ovl', {
  videoState: (state) => ipcRenderer.send('ovl-video-state', state),
  on: (fn) => ipcRenderer.on('ovl', (_e, m) => fn(m)),
});
