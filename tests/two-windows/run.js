// node tests/two-windows/run.js [рабочая папка] [папка с исходниками] — harness4.js на Windows (без Xvfb).
// Код приглашения идёт через общий файл-«буфер обмена» двух копий (системный буфер пользователя не трогается).
// Результат — res{A,B}.json: сравнивать с прогоном прошлой версии, а не с нулём (часть пунктов зависит от среды).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const T = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'alc-tw-')));
const SRC = path.resolve(process.argv[3] || path.join(HERE, '..', '..'));
const ELECTRON_FROM = path.resolve(HERE, '..', '..');
if (!fs.existsSync(path.join(SRC, 'main.js'))) { console.error('нет исходников в ' + SRC); process.exit(2); }
const APP = path.join(T, 'app'); const SH = path.join(T, 'sh'); const UD = path.join(T, 'ud');
fs.rmSync(T, { recursive: true, force: true });
for (const d of [APP, SH, UD + '/A', UD + '/B']) fs.mkdirSync(d, { recursive: true });
const skip = new Set(['node_modules', 'tests', 'dist', '.git']);
for (const n of fs.readdirSync(SRC)) if (!skip.has(n)) fs.cpSync(path.join(SRC, n), path.join(APP, n), { recursive: true });
fs.copyFileSync(path.join(HERE, 'harness4.js'), path.join(APP, 'harness4.js'));
// общий «буфер обмена» двух копий — файл в SHARED, системный буфер пользователя не трогаем
fs.writeFileSync(path.join(APP, 'harness-win.js'), `const { ipcMain } = require('electron');
const fs = require('fs'), path = require('path');
require('./harness4.js');
const F = path.join(process.env.SHARED, 'clipboard.txt');
for (const ch of ['clip-write', 'clip-read']) ipcMain.removeHandler(ch);
ipcMain.handle('clip-write', (_e, t) => { fs.writeFileSync(F, String(t)); return true; });
ipcMain.handle('clip-read', () => { try { return fs.readFileSync(F, 'utf-8'); } catch { return ''; } });
`);
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: 'alloconnect-it', version: '1.10.0', main: 'harness-win.js' }));
const E = require(path.join(ELECTRON_FROM, 'node_modules', 'electron'));

const stun = spawn(process.execPath, [path.join(HERE, '..', 'stun', 'fake-stun.js'), '3478,3480,3482', path.join(SH, 'stuncounts.json')], { stdio: 'ignore' });
setTimeout(() => {
  const procs = ['A', 'B'].map((r, i) => new Promise((done) => setTimeout(() => {
    const p = spawn(E, ['--no-sandbox', APP], {
      env: { ...process.env, ROLE: r, SHARED: SH, ALOCALLS_USERDATA: path.join(UD, r), ALOCALLS_FAKE_HELPER: path.join(HERE, 'fake-helper.js'), FAKE_LOG: path.join(SH, 'fake' + r) },
      stdio: ['ignore', fs.openSync(path.join(SH, `out${r}.log`), 'w'), fs.openSync(path.join(SH, `err${r}.log`), 'w')],
    });
    const kill = setTimeout(() => p.kill(), 600000);
    p.on('exit', () => { clearTimeout(kill); done(); });
  }, i * 1000)));
  Promise.all(procs).then(() => {
    stun.kill();
    for (const r of ['A', 'B']) {
      let res = {};
      try { res = JSON.parse(fs.readFileSync(path.join(SH, `res${r}.json`), 'utf-8')); } catch { /* */ }
      const flat = Object.entries(res).filter(([k]) => k !== 'errors');
      console.log(`== ${r}: ${flat.filter(([, v]) => v === true).length} true, ${flat.filter(([, v]) => v === false).length} false`);
      for (const [k, v] of flat) if (v !== true) console.log(`   ${k}: ${JSON.stringify(v).slice(0, 160)}`);
    }
    console.log('папка:', T);
  });
}, 1000);
