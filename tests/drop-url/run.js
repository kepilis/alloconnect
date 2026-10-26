// node tests/drop-url/run.js — один экземпляр, копия программы во временной папке (как в tests/ident)
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const SRC = path.resolve(__dirname, '../..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'alc-drop-'));
const APP = path.join(T, 'app'), UD = path.join(T, 'ud');
fs.mkdirSync(APP, { recursive: true }); fs.mkdirSync(UD);
const skip = new Set(['node_modules', 'tests', 'dist', '.git']);
// APP_FROM — проверить собранную программу: папка с распакованным app.asar вместо исходников
const FROM = process.env.APP_FROM ? path.resolve(process.env.APP_FROM) : SRC;
for (const n of fs.readdirSync(FROM)) if (!skip.has(n)) fs.cpSync(path.join(FROM, n), path.join(APP, n), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'h-drop.js'), path.join(APP, 'h-drop.js'));
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: 'alloconnect-it', version: '1.16.0', main: 'h-drop.js' }));
const r = spawnSync(require(path.join(SRC, 'node_modules', 'electron')), ['--no-sandbox', APP], {
  env: { ...process.env, ALOCALLS_USERDATA: UD }, encoding: 'utf-8', timeout: 120000,
});
const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
if (!line) { console.log(r.error, r.status, r.stdout, r.stderr); process.exit(1); }
const res = JSON.parse(line.slice(7));
console.log(JSON.stringify(res, null, 1));
const ok = res.htmlImg?.[0]?.t === 'image/png' && res.htmlImg[0].n === 'pic.png' && res.htmlImg[0].s > 0 &&
  res.uriOnly?.[0]?.t === 'image/png' && res.noExt?.[0]?.n === 'noext.webp' &&
  res.dataUrl?.[0]?.t === 'image/png' && res.realFile?.[0]?.n === 'a.png' && !res.notMedia && !res.fileUrl;
console.log(ok ? 'OK' : 'FAIL');
process.exit(ok ? 0 : 1);
