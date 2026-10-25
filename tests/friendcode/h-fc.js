// Код дружбы: три экземпляра с чистыми профилями. Запуск — tests/friendcode/run.js.
// 1) A даёт код, B вставляет, A принимает — оба друзья и в сети.
// 2) C вставляет код A с подменённым секретом — запрос у A не появляется.
// 3) C вставляет настоящий код, A отказывает — C узнаёт об отказе, дружбы нет.
// 4) C получает код A без адресов (как будто A не достучаться) — у C появляется ответный код,
//    A вставляет его — оба друзья.
// 5) Свой код и испорченный код — понятные подсказки.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ROLE = process.env.ROLE; const SH = process.env.SHARED;
require('./main.js');
const { encodeFriendCode, decodeFriendCode } = require('./net-friends.js');
for (const ch of ['clip-write', 'clip-read']) { ipcMain.removeHandler(ch); ipcMain.handle(ch, () => (ch === 'clip-read' ? '' : true)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { role: ROLE }; const errors = [];
const save = () => fs.writeFileSync(path.join(SH, `res${ROLE}.json`), JSON.stringify(res, null, 2));
const shf = (n) => path.join(SH, n);
const put = (n, v = '1') => fs.writeFileSync(shf(n), v);
const take = async (n, t = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(shf(n))) return fs.readFileSync(shf(n), 'utf-8'); await sleep(200); } return null; };
async function waitFor(win, expr, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await win.webContents.executeJavaScript(expr)) return true; } catch { /* */ } await sleep(250); } return false; }
const ALL = ['A', 'B', 'C'];

app.whenReady().then(async () => {
  await sleep(2500);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errors.push(e.message ?? e.params?.message); });
  const js = (c) => W.webContents.executeJavaScript(c);
  const J = (x) => JSON.stringify(x);
  const sync = async (name, roles = ALL, t = 90000) => { put(`${name}${ROLE}`); for (const r of roles) if (r !== ROLE) await take(`${name}${r}`, t); };
  const shot = async (name) => { try { fs.writeFileSync(shf(`${name}.png`), (await W.webContents.capturePage()).toPNG()); } catch { /* */ } };
  const visible = (id) => `!document.getElementById(${J(id)}).classList.contains('hidden')`;
  const status = () => js(`document.getElementById('fcStatus').textContent`);
  const isFriendOnline = (id) => `!!friendsList.find((f) => f.id === ${J(id)} && f.online)`;
  // открыть «Добавить друга» и взять свой код
  const myCode = async () => {
    await js(`document.getElementById('btnAddFriendCode').click(); true`);
    await waitFor(W, `document.getElementById('fcMine').value.startsWith('ALOF.')`, 15000);
    return js(`document.getElementById('fcMine').value`);
  };
  // вставить код в поле и нажать «Добавить»
  const useCode = async (code) => {
    await js(`document.getElementById('btnAddFriendCode').click(); document.getElementById('fcIn').value = ${J(code)}; fcCheckInput(); true`);
    const ok = await waitFor(W, `!document.getElementById('fcAdd').disabled`, 8000);
    if (ok) await js(`document.getElementById('fcAdd').click(); true`);
    return ok;
  };
  try {
    await js(`document.getElementById('nick').value='user${ROLE}'; true`);
    res.ident = await waitFor(W, `!!myIdent`, 15000);
    const me = await js(`myIdent.id`);
    put(`id${ROLE}`, me);
    const ids = {};
    for (const r of ALL) ids[r] = await take(`id${r}`);

    // 1. A → B
    if (ROLE === 'A') {
      await shot('fc-lobby-A');
      const code = await myCode();
      res.codeLen = code.length;
      await shot('fc-modal-A');
      put('codeA1', code);
      res.gotRequestB = await waitFor(W, `${visible('fcReqModal')} && /userB/.test(document.getElementById('fcReqTitle').textContent)`, 30000);
      await shot('fc-request-A');
      await js(`document.getElementById('fcReqAccept').click(); true`);
    }
    if (ROLE === 'B') {
      res.addEnabled = await useCode(await take('codeA1'));
      res.sawSeen = await waitFor(W, `/Запрос дошёл|в друзьях/.test(document.getElementById('fcStatus').textContent)`, 20000);
    }
    if (ROLE !== 'C') {
      const other = ROLE === 'A' ? ids.B : ids.A;
      res.friends1 = await waitFor(W, isFriendOnline(other), 40000);
      res.nick1 = await js(`friendsList.find((f) => f.id === ${J(other)})?.nick || null`);
      if (ROLE === 'B') { await sleep(500); res.status1 = await status(); await shot('fc-done-B'); }
      await js(`document.getElementById('fcModal').classList.add('hidden'); true`);
    }
    await sync('s1');

    // 2. подменённый секрет
    if (ROLE === 'A') { put('codeA2', await myCode()); await js(`document.getElementById('fcModal').classList.add('hidden'); true`); }
    if (ROLE === 'C') {
      const c = decodeFriendCode(await take('codeA2'));
      const forged = encodeFriendCode({ ...c, tok: 'ab'.repeat(12) });
      res.forgedAccepted = await useCode(forged);
      await sleep(7000);
      res.forgedSeen = /Запрос дошёл/.test(await status());
      await js(`window.duo.fcCancel(${J(ids.A)}); FC.wait = null; document.getElementById('fcModal').classList.add('hidden'); true`);
      put('forgedDone');
    }
    if (ROLE === 'A') { await take('forgedDone', 40000); res.noForgedRequest = await js(`document.getElementById('fcReqModal').classList.contains('hidden') && !FC.cur`); }
    await sync('s2');

    // 3. отказ
    if (ROLE === 'A') {
      put('codeA3', await myCode());
      await js(`document.getElementById('fcModal').classList.add('hidden'); true`);
      res.gotRequestC = await waitFor(W, `${visible('fcReqModal')} && /userC/.test(document.getElementById('fcReqTitle').textContent)`, 30000);
      await js(`document.getElementById('fcReqDecline').click(); true`);
      await sleep(3000);
      res.cNotFriend = await js(`!isFriend(${J(ids.C)})`);
    }
    if (ROLE === 'C') {
      await useCode(await take('codeA3'));
      res.sawDecline = await waitFor(W, `/отклонил/.test(document.getElementById('fcStatus').textContent)`, 30000);
      res.aNotFriend = await js(`!isFriend(${J(ids.A)})`);
      await js(`document.getElementById('fcModal').classList.add('hidden'); true`);
    }
    await sync('s3');

    // 4. A не достучаться: код без адресов → ответный код
    if (ROLE === 'A') { put('codeA4', await myCode()); await js(`document.getElementById('fcModal').classList.add('hidden'); true`); }
    if (ROLE === 'C') {
      const c = decodeFriendCode(await take('codeA4'));
      await useCode(encodeFriendCode({ ...c, addrs: [] }));
      res.replyShown = await waitFor(W, visible('fcReplyBlock'), 20000);
      await shot('fc-reply-C');
      put('replyC', await js(`document.getElementById('fcReply').value`));
    }
    if (ROLE === 'A') {
      const reply = await take('replyC', 60000);
      res.replyAccepted = await useCode(reply);
      res.replyStatus = await waitFor(W, `/в друзьях/.test(document.getElementById('fcStatus').textContent)`, 10000);
    }
    if (ROLE === 'A' || ROLE === 'C') {
      const other = ROLE === 'A' ? ids.C : ids.A;
      res.friends4 = await waitFor(W, isFriendOnline(other), 40000);
      res.nick4 = await js(`friendsList.find((f) => f.id === ${J(other)})?.nick || null`);
      await js(`document.getElementById('fcModal').classList.add('hidden'); true`);
    }
    await sync('s4');

    // 5. свой код, испорченный код
    if (ROLE === 'B') {
      const own = await myCode();
      await js(`document.getElementById('fcIn').value = ${J(own)}; fcCheckInput(); true`);
      res.ownHint = await waitFor(W, `/собственный/.test(document.getElementById('fcStatus').textContent) && document.getElementById('fcAdd').disabled`, 5000);
      const bad = own.slice(0, 40) + (own[40] === 'A' ? 'B' : 'A') + own.slice(41);
      await js(`document.getElementById('fcIn').value = ${J(bad)}; fcCheckInput(); true`);
      res.badHint = await waitFor(W, `/не читается/.test(document.getElementById('fcStatus').textContent) && document.getElementById('fcAdd').disabled`, 5000);
    }
    // запросы не остались висеть
    res.pending = await js(`window.duo.fcPending()`);
    await sync('s5');
  } catch (e) { res.exception = String(e && e.stack || e); }
  res.errors = errors.slice(0, 10);
  save();
  app.exit(0);
});
