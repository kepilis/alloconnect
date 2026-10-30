'use strict';
// окно своих уведомлений: только показать, сообщить размер и клик
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ntf', {
  onShow: (cb) => ipcRenderer.on('ntf-show', (_e, d) => cb(d)),
  onClose: (cb) => ipcRenderer.on('ntf-close', (_e, key) => cb(key)),
  size: (h, n) => ipcRenderer.send('ntf-size', h, n),
  click: (d) => ipcRenderer.send('ntf-click', { key: d.key, peer: d.peer, kind: d.kind }),
});
