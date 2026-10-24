// node tests/group/run.js [рабочая папка] — ТЕСТ группового звонка на трёх экземплярах (h-group.js).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..');
const T = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'alc-group-')));
const APP = path.join(T, 'app'); const SH = path.join(T, 'sh'); const UD = path.join(T, 'ud');
fs.rmSync(T, { recursive: true, force: true });
for (const d of [APP, SH, UD + '/A', UD + '/B', UD + '/C']) fs.mkdirSync(d, { recursive: true });
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
    const kill = setTimeout(() => p.kill(), 240000);
    p.on('exit', () => { clearTimeout(kill); done(); });
  }, i * 1000);
})));
const R = (role) => { try { return JSON.parse(fs.readFileSync(path.join(SH, `res${role}.json`), 'utf-8')); } catch { return {}; } };

(async () => {
  let ok = 0, bad = 0;
  const t = (name, cond, extra) => { console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || extra === undefined ? '' : '  → ' + JSON.stringify(extra))); cond ? ok++ : bad++; };
  await run(['A', 'B', 'C']);
  const a = R('A'), b = R('B'), c = R('C');
  t('друзья в сети', a.friendsOnline && b.friendsOnline && c.friendsOnline, [a.exception, b.exception, c.exception]);
  t('B и C получили приглашение', b.gotInvite && c.gotInvite);
  t('все трое соединены каждый с каждым', a.allConnected && b.allConnected && c.allConnected, [a.allConnected, b.allConnected, c.allConnected]);
  t('B и C не друзья — соединились через пересылку A', b.notFriends === 1 && c.notFriends === 1 && a.notFriends === 0, [a.notFriends, b.notFriends, c.notFriends]);
  t('звук идёт от обоих к каждому', [a, b, c].every((r) => Array.isArray(r.audioIn) && r.audioIn.length === 2 && r.audioIn.every((x) => x > 1000)), [a.audioIn, b.audioIn, c.audioIn]);
  t('чат доходит до всех', a.chatSeen && b.chatSeen && c.chatSeen, [a.chatSeen, b.chatSeen, c.chatSeen]);
  t('экран B видят A и C', a.seeShare && c.seeShare, [a.seeShare, c.seeShare]);
  t('экран B сам развернулся', a.autoFocus && c.autoFocus);
  t('A и B видят, что C выключил микрофон', a.seeMuteC && b.seeMuteC);
  t('C вышел — вернулся в лобби', c.leftOk);
  t('A и B увидели уход C и остались вдвоём', a.seeLeaveC && b.seeLeaveC && a.stillWithOther && b.stillWithOther, [a.seeLeaveC, b.seeLeaveC, a.stillWithOther, b.stillWithOther]);
  const errs = ['A', 'B', 'C'].flatMap((r) => (R(r).errors || []).map((e) => `${r}: ${e}`));
  if (errs.length) console.log('Ошибки в консоли окна:\n  ' + errs.slice(0, 15).join('\n  '));
  console.log(`${ok} ok, ${bad} fail · ${T}`);
  process.exit(bad ? 1 : 0);
})();
