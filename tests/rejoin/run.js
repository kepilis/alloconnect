// node tests/rejoin/run.js [рабочая папка] — возврат в звонок на трёх экземплярах (h-rejoin.js), ~3 мин.
// Снимки окна (rj-*.png) — в папке sh.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareApp, runRoles, readRes } = require('../lib/roles');

const T = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'alc-rejoin-')));
const ROLES = ['A', 'B', 'C'];
const dirs = prepareApp(T, { files: { 'h-rejoin.js': path.join(__dirname, 'h-rejoin.js') }, main: 'h-rejoin.js', roles: ROLES });

(async () => {
  let ok = 0, bad = 0;
  const t = (name, cond, extra) => { console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || extra === undefined ? '' : '  → ' + JSON.stringify(extra))); cond ? ok++ : bad++; };
  await runRoles(dirs, ROLES, { killAfter: 420000 });
  const [a, b, c] = ROLES.map((r) => readRes(dirs.SH, r));
  t('A и B друзья, в сети', a.friendsOnline && b.friendsOnline, [a.exception, b.exception, c.exception]);
  t('1: звонок из списка соединился', a.conn1 && b.conn1);
  t('1: B вышел — у A ожидание и «Позвонить снова»', a.waiting1);
  t('1: у A громкий звук «вышел»', a.goneSound);
  t('1: у B в лобби «Вернуться»', b.rejoinBar);
  t('2: B вернулся — оба в звонке', a.conn2 && b.conn2, [a.conn2, b.conn2, b.beforeRejoin, b.afterRejoin]);
  t('2: у A ничего не звонило', a.noRing2);
  t('2: плашка ожидания убрана', a.waitBarGone2 && b.waitBarGone2);
  t('2: история чата на месте', b.history2);
  t('3: A позвонил снова — у B входящий, принял — в звонке', b.ring3 && a.conn3 && b.conn3, [b.ring3, a.conn3, b.conn3]);
  t('4: A вышел — у B ожидание, у A «Вернуться»', b.waiting4 && a.rejoinBar4);
  t('4: B тоже вышел — у A «Вернуться» пропало', a.rejoinBarGone4);
  t('5: по коду с не-другом — соединились', a.conn5 && c.conn5);
  t('5: C вышел — у A «вернуться нельзя», без «Позвонить снова»', a.waiting5);
  t('5: у C нет «Вернуться»', c.noRejoinBar5);
  const errs = ROLES.flatMap((r) => (readRes(dirs.SH, r).errors || []).map((e) => `${r}: ${e}`));
  if (errs.length) console.log('Ошибки в консоли окна:\n  ' + errs.slice(0, 15).join('\n  '));
  console.log(`${ok} ok, ${bad} fail · ${T}`);
  process.exit(bad ? 1 : 0);
})();
