// 1.15.1: подтверждение ID в звонке по коду. Запуск — tests/ident/run.js (Windows/Linux, без Xvfb на Windows).
// PHASE 1: A↔B по коду — оба подтверждены, звонок привязан к другу, «в друзья».
// PHASE 2: M по коду выдаёт себя за B (вызов есть, ключа нет) — у A звонок не привязан, адреса B не тронуты, предупреждение.
// PHASE 3: M как «старая версия» (ident без вызова) с ID B — то же самое.
// PHASE 4: A звонит B из списка друзей — подтверждено без вызова (SDP шёл по каналу друзей).
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const ROLE = process.env.ROLE; const SH = process.env.SHARED; const PHASE = process.env.PHASE;
require('./main.js');
// буфер обмена системы не трогаем: коды передаются файлами
for (const ch of ['clip-write', 'clip-read']) { ipcMain.removeHandler(ch); ipcMain.handle(ch, () => (ch === 'clip-read' ? '' : true)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { role: ROLE, phase: PHASE }; const errors = [];
const save = () => fs.writeFileSync(path.join(SH, `res${PHASE}${ROLE}.json`), JSON.stringify(res, null, 2));
const shf = (n) => path.join(SH, `p${PHASE}_${n}`);
const put = (n, v) => fs.writeFileSync(shf(n), v);
const take = async (n, t = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(shf(n))) return fs.readFileSync(shf(n), 'utf-8'); await sleep(200); } return null; };
async function waitFor(win, expr, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await win.webContents.executeJavaScript(expr)) return true; } catch { /* */ } await sleep(250); } return false; }

app.whenReady().then(async () => {
  await sleep(2500);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errors.push(e.message ?? e.params?.message); });
  const js = (c) => W.webContents.executeJavaScript(c);
  const msgs = () => js(`document.getElementById('messages').textContent`);
  try {
    await js(`document.getElementById('nick').value='user${ROLE}'; true`);
    res.ident = await waitFor(W, `!!myIdent`, 15000);
    const me = await js(`myIdent.id`);
    put(`id${ROLE}`, me);
    const host = ROLE === 'A';

    if (ROLE === 'M') {
      const victim = fs.readFileSync(path.join(SH, 'p1_idB'), 'utf-8');
      // самозванец заявляет чужой ID; в режиме old — как старая версия, без вызова
      await js(`sendIdent = async function () {
        const info = await window.duo.friendsInfo();
        const ch = ${PHASE === '3' ? 'undefined' : `b64uBytes(crypto.getRandomValues(new Uint8Array(18)))`};
        S.identCh = ch || null;
        send({ t: 'ident', id: ${JSON.stringify(victim)}, addrs: [{ kind: 'public', ip: '203.0.113.66', port: 40000 }], av: '', ch });
      }; true`);
    }
    if (host) res.friendsBefore = await js(`JSON.stringify(friendsList.map((f) => ({ id: f.id, nick: f.nick })))`);
    const addrsBefore = host ? fs.existsSync(path.join(process.env.ALOCALLS_USERDATA, 'friends.json')) && fs.readFileSync(path.join(process.env.ALOCALLS_USERDATA, 'friends.json'), 'utf-8') : null;

    if (PHASE === '4') {
      if (host) await js(`callFriend(friendsList[0].id); true`);
      else {
        await waitFor(W, `!document.getElementById('callModal').classList.contains('hidden')`, 30000);
        await sleep(800);
        await js(`document.getElementById('btnCallAccept').click(); true`);
      }
    } else if (host) {
      await js(`startInvite(); true`);
      await waitFor(W, `document.getElementById('offerOut').value.length > 100`, 30000);
      put('offer', await js(`document.getElementById('offerOut').value`));
      const ans = await take('answer');
      res.gotAnswer = !!ans;
      await js(`applyAnswer(${JSON.stringify(ans)}); true`);
    } else {
      const offer = await take('offer');
      res.gotOffer = !!offer;
      await js(`showStep('stepGuest'); makeAnswer(${JSON.stringify(offer)}); true`);
      await waitFor(W, `document.getElementById('answerOut').value.length > 100`, 30000);
      put('answer', await js(`document.getElementById('answerOut').value`));
    }
    res.connected = await waitFor(W, `S.connected`, 45000);
    await sleep(4000); // обмен ident / ident-proof

    const other = await take(`id${ROLE === 'A' ? (PHASE === '2' || PHASE === '3' ? 'M' : 'B') : 'A'}`, 5000);
    res.peerIdent = await js(`S.peerIdent ? S.peerIdent.id : null`);
    res.verifiedAsOther = res.peerIdent === other;
    res.callConvId = await js(`S.callConv ? S.callConv.id : null`);
    res.signaledBy = await js(`S.signaledBy || null`);
    res.addBtnShown = await js(`!document.getElementById('btnAddFriend').classList.contains('hidden')`);
    res.warning = ((await msgs()).match(/⚠[^⚠]{0,160}/) || [null])[0];

    if (PHASE === '1') {
      await waitFor(W, `!document.getElementById('btnAddFriend').classList.contains('hidden')`, 5000);
      await js(`document.getElementById('btnAddFriend').click(); true`);
      res.friendSaved = await waitFor(W, `friendsList.length === 1`, 10000);
      await sleep(1500);
    }
    if (host && (PHASE === '2' || PHASE === '3')) {
      const addrsAfter = fs.readFileSync(path.join(process.env.ALOCALLS_USERDATA, 'friends.json'), 'utf-8');
      res.friendsFileUnchanged = !addrsAfter.includes('203.0.113.66');
      res.friendsAfter = await js(`JSON.stringify(friendsList.map((f) => ({ id: f.id, nick: f.nick })))`);
      res.addrsBeforeHadFake = !!(addrsBefore && addrsBefore.includes('203.0.113.66'));
    }
    put(`done${ROLE}`, '1');
    await take(`done${host ? (PHASE === '2' || PHASE === '3' ? 'M' : 'B') : 'A'}`, 30000);
    await js(`leaveCall(); true`).catch(() => {});
    await sleep(1500);
  } catch (e) { res.exception = String(e && e.stack || e); }
  res.errors = errors.slice(0, 10);
  save();
  app.exit(0);
});
