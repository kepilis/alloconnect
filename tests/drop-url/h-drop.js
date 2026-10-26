// Перетаскивание картинки из браузера, который отдаёт только ссылку (не файл).
// Запуск: node tests/drop-url/run.js
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
require('./main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/img/pic.png')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
  if (req.url === '/noext') { res.writeHead(200, { 'Content-Type': 'image/webp' }); res.end(PNG); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>pin page</html>');
});

app.whenReady().then(async () => { try {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  await sleep(3000);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  const js = (c) => W.webContents.executeJavaScript(c);
  const res = {};
  await js(`S.inCall = true; queueFiles = (l) => { window.__got = l.map((f) => ({ n: f.name, t: f.type, s: f.size })); }; true`);
  const drop = async (setup) => {
    await js(`window.__got = null; (() => { const dt = new DataTransfer(); ${setup}; document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
    for (let i = 0; i < 40; i++) { const g = await js('window.__got'); if (g) return g; await sleep(100); }
    return null;
  };
  // Pinterest-подобно: uri-list — ссылка на страницу, text/html — <img src> картинки
  res.htmlImg = await drop(`dt.setData('text/uri-list', '${base}/pin/123'); dt.setData('text/html', '<a href="${base}/pin/123"><img src="${base}/img/pic.png?x=1"></a>')`);
  res.uriOnly = await drop(`dt.setData('text/uri-list', '${base}/img/pic.png')`);
  res.noExt = await drop(`dt.setData('text/uri-list', '${base}/noext')`);
  res.dataUrl = await drop(`dt.setData('text/uri-list', 'data:image/png;base64,${PNG.toString('base64')}')`);
  res.realFile = await drop(`dt.items.add(new File([new Uint8Array([1,2,3])], 'a.png', { type: 'image/png' }))`);
  res.notMedia = await drop(`dt.setData('text/uri-list', '${base}/pin/123')`);
  res.notMediaToast = await js(`document.getElementById('toast').textContent`);
  res.fileUrl = await drop(`dt.setData('text/uri-list', 'file:///C:/Windows/win.ini')`);
  console.log('RESULT ' + JSON.stringify(res));
  srv.close();
  app.exit(0);
  } catch (e) { console.log('RESULT ' + JSON.stringify({ error: String(e) })); app.exit(1); }
});
