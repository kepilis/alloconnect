// node tests/friendcode/run.js [рабочая папка] — код дружбы на трёх экземплярах (h-fc.js), ~2 мин.
// Снимки окна (fc-*.png) — в папке sh.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareApp, runRoles, readRes } = require('../lib/roles');

const T = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'alc-fc-')));
const ROLES = ['A', 'B', 'C'];
const dirs = prepareApp(T, { files: { 'h-fc.js': path.join(__dirname, 'h-fc.js') }, main: 'h-fc.js', roles: ROLES });

(async () => {
  let ok = 0, bad = 0;
  const t = (name, cond, extra) => { console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || extra === undefined ? '' : '  → ' + JSON.stringify(extra))); cond ? ok++ : bad++; };
  await runRoles(dirs, ROLES, { killAfter: 300000 });
  const [a, b, c] = ROLES.map((r) => readRes(dirs.SH, r));
  t('код короткий (меньше 200 знаков)', a.codeLen > 0 && a.codeLen < 200, a.codeLen);
  t('1: B вставил код — у A запрос «userB хочет в друзья»', b.addEnabled && a.gotRequestB, [b.addEnabled, a.gotRequestB, a.exception, b.exception]);
  t('1: B видит, что запрос дошёл', b.sawSeen);
  t('1: оба друзья и в сети, ники верные', a.friends1 && b.friends1 && a.nick1 === 'userB' && b.nick1 === 'userA', [a.friends1, b.friends1, a.nick1, b.nick1]);
  t('1: у B «в друзьях ✓»', /в друзьях/.test(b.status1 || ''), b.status1);
  t('2: подменённый секрет — запроса у A нет', c.forgedAccepted && !c.forgedSeen && a.noForgedRequest, [c.forgedAccepted, c.forgedSeen, a.noForgedRequest]);
  t('3: отказ — C узнал, дружбы нет ни у кого', a.gotRequestC && c.sawDecline && a.cNotFriend && c.aNotFriend, [a.gotRequestC, c.sawDecline, a.cNotFriend, c.aNotFriend]);
  t('4: A не достучаться — у C ответный код', c.replyShown);
  t('4: A вставил ответный код — оба друзья и в сети', a.replyAccepted && a.replyStatus && a.friends4 && c.friends4 && a.nick4 === 'userC' && c.nick4 === 'userA', [a.replyAccepted, a.replyStatus, a.friends4, c.friends4, a.nick4, c.nick4]);
  t('5: свой код — подсказка, «Добавить» выключена', b.ownHint);
  t('5: испорченный код — подсказка', b.badHint);
  t('запросы не висят', [a, b, c].every((r) => r.pending && !r.pending.incoming.length && !r.pending.outgoing.length), [a, b, c].map((r) => r.pending));
  const errs = ROLES.flatMap((r) => (readRes(dirs.SH, r).errors || []).map((e) => `${r}: ${e}`));
  if (errs.length) console.log('Ошибки в консоли окна:\n  ' + errs.slice(0, 15).join('\n  '));
  console.log(`${ok} ok, ${bad} fail · ${T}`);
  process.exit(bad ? 1 : 0);
})();
