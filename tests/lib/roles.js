// Общее для тестов на нескольких экземплярах: копия программы с тестовым main и запуск её копий-ролей.
// Каждая роль — отдельная папка данных (ALOCALLS_USERDATA), вывод — в SHARED/out<роль>.log.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP = new Set(['node_modules', 'tests', 'dist', '.git']);

// T/app ← исходники (src) + тестовые файлы; files: { 'имя в app': 'путь' или { text } }; main — точка входа
function prepareApp(T, { src = ROOT, files = {}, main, version, roles = [] }) {
  const APP = path.join(T, 'app'); const SH = path.join(T, 'sh'); const UD = path.join(T, 'ud');
  if (!fs.existsSync(path.join(src, 'main.js'))) throw new Error('нет исходников в ' + src);
  fs.rmSync(T, { recursive: true, force: true });
  for (const d of [APP, SH, ...roles.map((r) => path.join(UD, r))]) fs.mkdirSync(d, { recursive: true });
  for (const n of fs.readdirSync(src)) if (!SKIP.has(n)) fs.cpSync(path.join(src, n), path.join(APP, n), { recursive: true });
  for (const [n, f] of Object.entries(files)) {
    if (typeof f === 'string') fs.copyFileSync(f, path.join(APP, n)); else fs.writeFileSync(path.join(APP, n), f.text);
  }
  fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: 'alloconnect-it', version: version || require(path.join(src, 'package.json')).version, main }));
  return { APP, SH, UD };
}

// запустить роли с интервалом в секунду и дождаться всех; env(роль) — свои переменные
function runRoles({ APP, SH, UD }, roles, { env = () => ({}), killAfter = 600000 } = {}) {
  const E = require(path.join(ROOT, 'node_modules', 'electron'));
  return Promise.all(roles.map((r, i) => new Promise((done) => setTimeout(() => {
    const p = spawn(E, ['--no-sandbox', APP], {
      env: { ...process.env, ROLE: r, SHARED: SH, ALOCALLS_USERDATA: path.join(UD, r), ...env(r) },
      stdio: ['ignore', fs.openSync(path.join(SH, `out${r}.log`), 'w'), fs.openSync(path.join(SH, `err${r}.log`), 'w')],
    });
    const kill = setTimeout(() => p.kill(), killAfter);
    p.on('exit', () => { clearTimeout(kill); done(); });
  }, i * 1000))));
}

const readRes = (SH, role) => { try { return JSON.parse(fs.readFileSync(path.join(SH, `res${role}.json`), 'utf-8')); } catch { return {}; } };

module.exports = { prepareApp, runRoles, readRes };
