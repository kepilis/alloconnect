// node tests/two-windows/run18.js [рабочая папка] [исходники] — h18.js (камера и окна, 1.18) на Windows.
// Код приглашения идёт через общий файл-«буфер обмена» двух копий (системный буфер пользователя не трогается).
// Результат — res{A,B}.json: сравнивать с прогоном прошлой версии, а не с нулём (часть пунктов зависит от среды).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareApp, runRoles, readRes } = require('../lib/roles');

const HERE = __dirname;
const T = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'alc-tw-')));
const SRC = path.resolve(process.argv[3] || path.join(HERE, '..', '..'));
// общий «буфер обмена» двух копий — файл в SHARED, системный буфер пользователя не трогаем
const CLIP = `const { ipcMain } = require('electron');
const fs = require('fs'), path = require('path');
require('./h18.js');
const F = path.join(process.env.SHARED, 'clipboard.txt');
for (const ch of ['clip-write', 'clip-read']) ipcMain.removeHandler(ch);
ipcMain.handle('clip-write', (_e, t) => { fs.writeFileSync(F, String(t)); return true; });
ipcMain.handle('clip-read', () => { try { return fs.readFileSync(F, 'utf-8'); } catch { return ''; } });
`;
let dirs;
try {
  dirs = prepareApp(T, { src: SRC, files: { 'h18.js': path.join(HERE, 'h18.js'), 'h18-win.js': { text: CLIP } }, main: 'h18-win.js', version: '1.18.0', roles: ['A', 'B'] });
} catch (e) { console.error(e.message); process.exit(2); }

const stun = spawn(process.execPath, [path.join(HERE, '..', 'stun', 'fake-stun.js'), '3478,3480,3482', path.join(dirs.SH, 'stuncounts.json')], { stdio: 'ignore' });
setTimeout(async () => {
  await runRoles(dirs, ['A', 'B'], { env: (r) => ({ ALOCALLS_FAKE_HELPER: path.join(HERE, 'fake-helper.js'), FAKE_LOG: path.join(dirs.SH, 'fake' + r) }) });
  stun.kill();
  for (const r of ['A', 'B']) {
    const flat = Object.entries(readRes(dirs.SH, r)).filter(([k]) => k !== 'errors');
    console.log(`== ${r}: ${flat.filter(([, v]) => v === true).length} true, ${flat.filter(([, v]) => v === false).length} false`);
    for (const [k, v] of flat) if (v !== true) console.log(`   ${k}: ${JSON.stringify(v).slice(0, 160)}`);
  }
  console.log('папка:', T);
}, 1000);
