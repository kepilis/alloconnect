// node tests/group/run.js [рабочая папка] — ТЕСТ группового звонка на четырёх экземплярах (h-group.js).
// SHOT=1 — снимок окна C во время показа экрана.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..');
const T = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'alc-group-')));
const APP = path.join(T, 'app'); const SH = path.join(T, 'sh'); const UD = path.join(T, 'ud');
const ROLES = ['A', 'B', 'C', 'D'];
fs.rmSync(T, { recursive: true, force: true });
for (const d of [APP, SH, ...ROLES.map((r) => path.join(UD, r))]) fs.mkdirSync(d, { recursive: true });
const skip = new Set(['node_modules', 'tests', 'dist', '.git']);
for (const n of fs.readdirSync(SRC)) if (!skip.has(n)) fs.cpSync(path.join(SRC, n), path.join(APP, n), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'h-group.js'), path.join(APP, 'h-group.js'));
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: 'alloconnect-it', version: require(path.join(SRC, 'package.json')).version, main: 'h-group.js' }));
const E = require(path.join(SRC, 'node_modules', 'electron'));

const run = (roles) => Promise.all(roles.map((r, i) => new Promise((done) => {
  setTimeout(() => {
    const p = spawn(E, ['--no-sandbox', APP], {
      env: { ...process.env, ROLE: r, SHARED: SH, ALOCALLS_USERDATA: path.join(UD, r) },
      stdio: ['ignore', fs.openSync(path.join(SH, `out${r}.log`), 'w'), fs.openSync(path.join(SH, `err${r}.log`), 'w')],
    });
    const kill = setTimeout(() => p.kill(), 600000);
    p.on('exit', () => { clearTimeout(kill); done(); });
  }, i * 1000);
})));
const R = (role) => { try { return JSON.parse(fs.readFileSync(path.join(SH, `res${role}.json`), 'utf-8')); } catch { return {}; } };

(async () => {
  let ok = 0, bad = 0;
  const t = (name, cond, extra) => { console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || extra === undefined ? '' : '  → ' + JSON.stringify(extra))); cond ? ok++ : bad++; };
  await run(ROLES);
  const [a, b, c, d] = ROLES.map(R);
  const abc = [a, b, c];
  t('друзья в сети', [a, b, c, d].every((r) => r.friendsOnline), [a, b, c, d].map((r) => r.exception));
  t('B и C получили приглашение', b.gotInvite && c.gotInvite);
  t('A, B, C соединены каждый с каждым (B–C через A)', abc.every((r) => r.conn3), abc.map((r) => r.conn3));
  t('голос идёт от обоих к каждому', abc.every((r) => Array.isArray(r.audioIn) && r.audioIn.length === 2 && r.audioIn.every((x) => x > 1000)), abc.map((r) => r.audioIn));
  t('чат и ответ с цитатой дошли', abc.every((r) => r.chat?.hasReply && /userA/.test(r.chat.quote)), abc.map((r) => r.chat || r.chatError));
  t('реакция B видна у всех', abc.every((r) => r.chat?.chip === '👍'), abc.map((r) => r.chat?.chip));
  t('правка A видна у всех', abc.every((r) => r.chat?.text === 'edited by A'), abc.map((r) => r.chat?.text));
  t('C не смог удалить чужое', abc.every((r) => r.chat && !r.chat.deleted));
  t('экран B видят A и C', a.seeShare && c.seeShare, [a.seeShare, c.seeShare, a.shareError, b.shareError, c.shareError]);
  t('экран B сам развернулся', a.autoFocus && c.autoFocus);
  t('звук экрана B доходит', a.shareAudioIn > 1000 && c.shareAudioIn > 1000, [a.shareAudioIn, c.shareAudioIn]);
  t('файл от A дошёл до всех', abc.every((r) => r.fileOk) && /userA/.test(b.fileFrom || '') && /userA/.test(c.fileFrom || ''), abc.map((r) => [r.fileOk, r.fileFrom, r.fileError]));
  t('A и B видят, что C выключил микрофон', a.seeMuteC && b.seeMuteC);
  t('B (не создатель) позвал D — все четверо соединены', [a, b, c, d].every((r) => r.conn4) && d.gotInvite, [a, b, c, d].map((r) => r.conn4));
  t('обрыв B–C: переподключились сами', b.reconnected && c.reconnected && b.backMsg && c.backMsg, [b.reconnected, c.reconnected, b.backMsg, c.backMsg]);
  t('создатель A ушёл — B, C, D продолжают', a.leftOk && b.afterHostLeft && c.afterHostLeft && d.afterHostLeft, [a.leftOk, b.afterHostLeft, c.afterHostLeft, d.afterHostLeft]);
  t('C ушёл — B и D вдвоём', b.lastTwo && d.lastTwo);
  t('группа сохранилась у всех', [a, b, c, d].every((r) => r.savedGroup), [a, b, c, d].map((r) => r.savedGroup));
  t('B собрал группу снова, A позвал C — все четверо', [a, b, c, d].every((r) => r.conn4again && r.sameGid), [a, b, c, d].map((r) => [r.conn4again, r.sameGid]));
  t('история чата группы на месте', [a, b, c].every((r) => /edited by A/.test(r.history || '') && /reply from C/.test(r.history || '')), [a, b, c].map((r) => (r.history || '').slice(0, 300)));
  t('самозванец отвергнут, остальные на связи', b.rejectedD && b.othersStay, [b.rejectedD, b.othersStay]);
  const errs = ROLES.flatMap((r) => (R(r).errors || []).map((e) => `${r}: ${e}`));
  if (errs.length) console.log('Ошибки в консоли окна:\n  ' + errs.slice(0, 15).join('\n  '));
  console.log(`${ok} ok, ${bad} fail · ${T}`);
  process.exit(bad ? 1 : 0);
})();
