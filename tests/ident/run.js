// node tests/ident/run.js [рабочая папка] — четыре фазы h-ident.js, итог по каждой проверке.
// Нужен npm install (electron из node_modules). На Linux запускать под Xvfb (DISPLAY).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..');
const T = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'alc-ident-')));
const APP = path.join(T, 'app'); const SH = path.join(T, 'sh'); const UD = path.join(T, 'ud');
fs.rmSync(T, { recursive: true, force: true });
for (const d of [APP, SH, UD + '/A', UD + '/B', UD + '/M']) fs.mkdirSync(d, { recursive: true });
// APP_FROM — проверить собранную программу: папка с распакованным app.asar вместо исходников
const FROM = process.env.APP_FROM ? path.resolve(process.env.APP_FROM) : SRC;
const skip = new Set(['node_modules', 'tests', 'dist', '.git']);
for (const n of fs.readdirSync(FROM)) if (!skip.has(n)) fs.cpSync(path.join(FROM, n), path.join(APP, n), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'h-ident.js'), path.join(APP, 'h-ident.js'));
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: 'alloconnect-it', version: '1.15.1', main: 'h-ident.js' }));
const E = require(path.join(SRC, 'node_modules', 'electron'));

function run(phase, roles) {
  return Promise.all(roles.map((r, i) => new Promise((done) => {
    setTimeout(() => {
      const p = spawn(E, ['--no-sandbox', APP], {
        env: { ...process.env, ROLE: r, PHASE: phase, SHARED: SH, ALOCALLS_USERDATA: path.join(UD, r) },
        stdio: ['ignore', fs.openSync(path.join(SH, `out${phase}${r}.log`), 'w'), fs.openSync(path.join(SH, `err${phase}${r}.log`), 'w')],
      });
      const kill = setTimeout(() => p.kill(), 150000);
      p.on('exit', () => { clearTimeout(kill); done(); });
    }, i * 1000);
  })));
}
const R = (phase, role) => { try { return JSON.parse(fs.readFileSync(path.join(SH, `res${phase}${role}.json`), 'utf-8')); } catch { return {}; } };

(async () => {
  let ok = 0, bad = 0;
  const t = (name, cond, extra) => { console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || extra === undefined ? '' : '  → ' + JSON.stringify(extra))); cond ? ok++ : bad++; };

  await run('1', ['A', 'B']);
  let a = R(1, 'A'), b = R(1, 'B');
  t('1: соединились по коду', a.connected && b.connected, { a: a.exception, b: b.exception });
  t('1: A подтвердил B', a.verifiedAsOther && a.callConvId === a.peerIdent, a);
  t('1: B подтвердил A', b.verifiedAsOther && b.callConvId === b.peerIdent, b);
  t('1: без предупреждений', !a.warning && !b.warning, [a.warning, b.warning]);
  t('1: добавлены в друзья', a.friendSaved && b.friendSaved);

  await run('2', ['A', 'M']);
  a = R(2, 'A');
  t('2: самозванец соединился (звонок как с незнакомцем)', a.connected, a.exception);
  t('2: A не принял чужой ID', a.peerIdent === null && a.callConvId === null, a);
  t('2: предупреждение «ключ не его»', /ключ не его/.test(a.warning || ''), a.warning);
  t('2: адреса B не заменены', a.friendsFileUnchanged && a.friendsBefore === a.friendsAfter, a);
  t('2: кнопки «В друзья» нет', a.addBtnShown === false);

  await run('3', ['A', 'M']);
  a = R(3, 'A');
  t('3: «старая версия» соединилась', a.connected, a.exception);
  t('3: A не принял ID без доказательства', a.peerIdent === null && a.callConvId === null, a);
  t('3: предупреждение «не подтвердил ключом»', /не подтвердил это ключом/.test(a.warning || ''), a.warning);
  t('3: адреса B не заменены', a.friendsFileUnchanged, a);

  await run('4', ['A', 'B']);
  a = R(4, 'A'); b = R(4, 'B');
  t('4: звонок из списка друзей соединился', a.connected && b.connected, { a: a.exception, b: b.exception });
  t('4: оба подтверждены, звонок привязан к другу', a.verifiedAsOther && b.verifiedAsOther && a.callConvId && b.callConvId, { a, b });
  t('4: без предупреждений', !a.warning && !b.warning, [a.warning, b.warning]);

  const errs = [1, 2, 3, 4].flatMap((p) => ['A', 'B', 'M'].flatMap((r) => (R(p, r).errors || []).map((e) => `${p}${r}: ${e}`)));
  if (errs.length) console.log('Ошибки в консоли окна:\n  ' + errs.slice(0, 15).join('\n  '));
  console.log(`${ok} ok, ${bad} fail · ${T}`);
  process.exit(bad ? 1 : 0);
})();
