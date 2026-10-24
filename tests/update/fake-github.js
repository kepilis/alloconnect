const http = require('http'), fs = require('fs'), path = require('path');
const [rel, modeFile, port] = process.argv.slice(2);
http.createServer((req, res) => {
  const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf-8').trim() : 'ok';
  if (req.url === '/repos/test/alloconnect/releases/latest') {
    const names = ['alloconnect-1.13.1-win.zip', 'app.asar', 'alloconnect-helper.exe', 'update.json'];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tag_name: 'v1.13.1', html_url: 'https://github.com/test/alloconnect/releases/tag/v1.13.1', assets: names.map((n) => ({ name: n, browser_download_url: `http://127.0.0.1:${port}/dl/${n}` })) }));
    return;
  }
  const m = /^\/dl\/(.+)$/.exec(req.url);
  if (m) {
    let n = decodeURIComponent(m[1]);
    if (n === 'update.json' && mode === 'badsig') { const u = JSON.parse(fs.readFileSync(path.join(rel, n))); u.m = u.m.replace('"v":"1.13.1"', '"v":"1.13.9"'); res.end(JSON.stringify(u)); return; }
    if (n === 'app.asar' && mode === 'badfile') { const b = fs.readFileSync(path.join(rel, n)); b[100] ^= 1; res.end(b); return; }
    try { res.end(fs.readFileSync(path.join(rel, n))); } catch { res.statusCode = 404; res.end(); }
    return;
  }
  res.statusCode = 404; res.end();
}).listen(+port, '127.0.0.1');
