// Возврат в звонок: три экземпляра, A и B — друзья, C — нет. Запуск — tests/rejoin/run.js.
// 1) A звонит B, B выходит — у A ожидание и громкий звук, у B в лобби «Вернуться».
// 2) B жмёт «Вернуться» — снова в звонке без звонка-«дзынь» у A, история чата на месте.
// 3) B выходит, A жмёт «Позвонить снова» — у B обычный входящий, принял — в звонке.
// 4) A выходит, B ждёт, потом B тоже выходит — у A «Вернуться» пропадает.
// 5) Звонок по коду A–C (не друзья): C вышел — у A «вернуться нельзя», у C нет «Вернуться».
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const ROLE = process.env.ROLE; const SH = process.env.SHARED;
require('./main.js');
for (const ch of ['clip-write', 'clip-read']) { ipcMain.removeHandler(ch); ipcMain.handle(ch, () => (ch === 'clip-read' ? '' : true)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { role: ROLE }; const errors = [];
const save = () => fs.writeFileSync(path.join(SH, `res${ROLE}.json`), JSON.stringify(res, null, 2));
const shf = (n) => path.join(SH, n);
const put = (n, v = '1') => fs.writeFileSync(shf(n), v);
const take = async (n, t = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(shf(n))) return fs.readFileSync(shf(n), 'utf-8'); await sleep(200); } return null; };
async function waitFor(win, expr, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await win.webContents.executeJavaScript(expr)) return true; } catch { /* */ } await sleep(250); } return false; }
const FRIENDS = { A: ['B'], B: ['A'], C: [] };
const ALL = ['A', 'B', 'C'];

app.whenReady().then(async () => {
  await sleep(2500);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errors.push(e.message ?? e.params?.message); });
  const js = (c) => W.webContents.executeJavaScript(c);
  const J = (x) => JSON.stringify(x);
  const sync = async (name, roles = ALL, t = 120000) => { put(`${name}${ROLE}`); for (const r of roles) if (r !== ROLE) await take(`${name}${r}`, t); };
  const shot = async (name) => { try { fs.writeFileSync(shf(`${name}.png`), (await W.webContents.capturePage()).toPNG()); } catch { /* */ } };
  const visible = (id) => `!document.getElementById(${J(id)}).classList.contains('hidden')`;
  const click = (id) => js(`document.getElementById(${J(id)}).click(); true`);
  const connected = `S.connected === true`;
  try {
    await js(`document.getElementById('nick').value='user${ROLE}'; true`);
    res.ident = await waitFor(W, `!!myIdent`, 15000);
    put(`id${ROLE}`, JSON.stringify(await js(`window.duo.friendsInfo().then((i) => ({ id: i.id, addrs: i.addrs }))`)));
    const ids = {};
    for (const r of ALL) ids[r] = JSON.parse(await take(`id${r}`)).id;
    for (const r of FRIENDS[ROLE]) {
      const o = JSON.parse(await take(`id${r}`));
      await js(`window.duo.friendsAdd(${J({ id: o.id, nick: 'user' + r, addrs: o.addrs })})`);
    }
    if (FRIENDS[ROLE].length) res.friendsOnline = await waitFor(W, `friendsList.every((f) => f.online) && friendsList.length === 1`, 40000);
    // счётчики: звуки и звонок-«дзынь»
    await js(`window.__snd = []; { const o = sound; sound = (k) => { __snd.push(k); return o(k); }; } window.__ring = 0; { const r = startRing; startRing = (...a) => { __ring++; return r(...a); }; } true`);
    await sync('s0');

    // 1. A звонит B, B выходит
    if (ROLE === 'A') { await js(`callFriend(${J(ids.B)}); true`); }
    if (ROLE === 'B') {
      await waitFor(W, `${visible('callModal')} && ${visible('btnCallAccept')}`, 40000);
      await sleep(500);
      await click('btnCallAccept');
    }
    if (ROLE !== 'C') {
      res.conn1 = await waitFor(W, connected, 40000);
      await waitFor(W, `!!S.peerIdent`, 10000);
      if (ROLE === 'A') { await js(`document.getElementById('chatInput').value = 'before-leave'; document.getElementById('chatForm').requestSubmit(); true`); await sleep(1500); }
    }
    await sync('s1');
    if (ROLE === 'B') { await js(`leaveCall(); true`); }
    if (ROLE === 'A') {
      res.waiting1 = await waitFor(W, `${visible('waitBar')} && ${visible('btnCallAgain')} && /Ждём/.test(document.getElementById('status').textContent)`, 15000);
      res.goneSound = await js(`__snd.includes('gone')`);
      await shot('rj-wait-A');
      res.ringBefore = await js(`__ring`);
    }
    if (ROLE === 'B') {
      res.rejoinBar = await waitFor(W, `${visible('rejoinBar')} && /userA/.test(document.getElementById('rejoinText').textContent)`, 15000);
      await shot('rj-lobby-B');
    }
    await sync('s2');

    // 2. B возвращается
    if (ROLE === 'B') {
      const st = `({ busy: S.busy, pc: !!S.pc, fc: !!S.friendCall, inCall: S.inCall, rejoin: !!S.rejoin, bound: !!document.getElementById('btnRejoin').onclick })`;
      res.beforeRejoin = await js(st);
      await click('btnRejoin');
      await sleep(300);
      res.afterRejoin = await js(st);
    }
    if (ROLE !== 'C') {
      res.conn2 = await waitFor(W, connected, 40000);
      await sleep(2000);
      res.waitBarGone2 = await js(`document.getElementById('waitBar').classList.contains('hidden')`);
    }
    if (ROLE === 'A') res.noRing2 = (await js(`__ring`)) === res.ringBefore;
    if (ROLE === 'B') {
      await waitFor(W, `/before-leave/.test(document.getElementById('messages').textContent)`, 10000);
      res.history2 = await js(`/before-leave/.test(document.getElementById('messages').textContent)`);
    }
    await sync('s3');

    // 3. B выходит, A звонит снова
    if (ROLE === 'B') await js(`leaveCall(); true`);
    if (ROLE === 'A') { await waitFor(W, visible('btnCallAgain'), 15000); await sleep(800); await click('btnCallAgain'); }
    if (ROLE === 'B') {
      res.ring3 = await waitFor(W, `${visible('callModal')} && ${visible('btnCallAccept')}`, 40000);
      await sleep(500);
      await click('btnCallAccept');
    }
    if (ROLE !== 'C') res.conn3 = await waitFor(W, connected, 40000);
    await sync('s4');

    // 4. A выходит, B ждёт, потом B тоже выходит
    if (ROLE === 'A') {
      await js(`leaveCall(); true`);
      res.rejoinBar4 = await waitFor(W, visible('rejoinBar'), 15000);
      put('aSawBar');
      res.rejoinBarGone4 = await waitFor(W, `document.getElementById('rejoinBar').classList.contains('hidden')`, 20000);
    }
    if (ROLE === 'B') {
      res.waiting4 = await waitFor(W, visible('waitBar'), 15000);
      await take('aSawBar', 30000);
      await click('btnLeave');
    }
    await sync('s5');

    // 5. звонок по коду A–C (не друзья)
    if (ROLE === 'A') {
      await js(`startInvite(); true`);
      await waitFor(W, `document.getElementById('offerOut').value.length > 100`, 30000);
      put('offer', await js(`document.getElementById('offerOut').value`));
      const ans = await take('answer', 60000);
      await js(`applyAnswer(${J(ans)}); true`);
    }
    if (ROLE === 'C') {
      const offer = await take('offer', 60000);
      await js(`makeAnswer(${J(offer)}); true`);
      await waitFor(W, `document.getElementById('answerOut').value.length > 100`, 30000);
      put('answer', await js(`document.getElementById('answerOut').value`));
    }
    if (ROLE !== 'B') res.conn5 = await waitFor(W, connected, 40000);
    await sync('s6');
    if (ROLE === 'C') { await sleep(1000); await js(`leaveCall(); true`); await sleep(5000); res.noRejoinBar5 = await js(`document.getElementById('rejoinBar').classList.contains('hidden')`); }
    if (ROLE === 'A') {
      res.waiting5 = await waitFor(W, `${visible('waitBar')} && document.getElementById('btnCallAgain').classList.contains('hidden') && /нельзя/.test(document.getElementById('waitText').textContent)`, 15000);
      await shot('rj-nofriend-A');
      await js(`leaveCall(); true`);
    }
    await sync('s7');
  } catch (e) { res.exception = String(e && e.stack || e); }
  res.errors = errors.slice(0, 10);
  save();
  app.exit(0);
});
