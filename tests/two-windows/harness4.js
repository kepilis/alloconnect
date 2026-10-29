// 1.10: два процесса alloconnect. Код → друзья → чат без звонка (текст+файл) → аватарка →
// звонок из списка с историей → права оверлея → стрим + реакции/рисунок → управление (подставной помощник)
// → приглушение → обмен звуком → переподключение.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const ROLE = process.env.ROLE; const SH = process.env.SHARED;
require('./main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = {}; const errors = [];
const save = () => fs.writeFileSync(path.join(SH, `res${ROLE}.json`), JSON.stringify(res, null, 2));
setInterval(save, 1000);
const OTHER = ROLE === 'A' ? 'B' : 'A';
const flag = (n) => fs.writeFileSync(path.join(SH, `${ROLE}_${n}`), '1');
const waitFlag = async (n, t = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(path.join(SH, `${OTHER}_${n}`))) return true; await sleep(200); } return false; };
const sync = async (n, t) => { flag(n); return waitFlag(n, t); };
async function waitFor(win, expr, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await win.webContents.executeJavaScript(expr)) return true; } catch { /* */ } await sleep(250); } return false; }
const fakeLog = (mode) => { try { return fs.readFileSync(`${process.env.FAKE_LOG}-${mode}.log`, 'utf-8'); } catch { return ''; } };

app.whenReady().then(async () => {
  await sleep(2500);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error' || l === 'warning') errors.push(e.message ?? e.params?.message); });
  const js = (c) => W.webContents.executeJavaScript(c);
  const shot = async (n) => fs.writeFileSync(path.join(SH, `${ROLE}_${n}.png`), (await W.webContents.capturePage()).toPNG());
  const step = async (name, fn) => { try { await fn(); } catch (e) { res[name + '_exception'] = String(e && e.stack || e).slice(0, 500); } };
  try {
    res.title = W.getTitle();
    await js(`document.getElementById('nick').value='${ROLE === 'A' ? 'userA' : 'userB'}'; true`);
    // STUN: у A основной список «мёртвый» → должен сам перейти на альтернативный; у B основной работает
    const LAN = Object.values(require('os').networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal).address;
    if (ROLE === 'A') await js(`STUN_LISTS.primary = ['stun:${LAN}:3991', 'stun:${LAN}:3992']; STUN_LISTS.alt = ['stun:${LAN}:3480', 'stun:${LAN}:3993']; true`);
    else await js(`STUN_LISTS.primary = ['stun:${LAN}:3478', 'stun:${LAN}:3994']; STUN_LISTS.alt = ['stun:${LAN}:3482']; true`);
    res.ident = await waitFor(W, `!!myIdent`, 15000);

    // 1) звонок по коду и «в друзья»
    if (ROLE === 'A') { await waitFlag('ready'); await js(`document.getElementById('btnInvite').click(); true`); } else flag('ready');
    res.connected1 = await waitFor(W, `S.connected && document.getElementById('status').classList.contains('ok')`, 45000);
    res.stunUsed1 = await js(`S.stunUsed`);
    res.stunChatNote = await js(`document.getElementById('messages').textContent.includes('включены альтернативные')`);
    res.stunCodeHasSrflx = await js(`/typ srflx/.test(S.pc.localDescription.sdp)`);
    res.callConvAdopted = await waitFor(W, `!!(S.callConv && S.callConv.id)`, 10000);
    await waitFor(W, `!document.getElementById('btnAddFriend').classList.contains('hidden')`, 10000);
    await js(`document.getElementById('btnAddFriend').click(); true`);
    res.friendSaved = await waitFor(W, `friendsList.length === 1`, 10000);
    // сообщение в звонке → должно попасть в историю
    if (ROLE === 'A') await js(`document.getElementById('chatInput').value='привет из звонка'; document.getElementById('chatForm').requestSubmit(); true`);
    await sleep(1500);
    await sync('added');
    await js(`leaveCall(); true`);
    res.friendOnline = await waitFor(W, `friendsList[0] && friendsList[0].online`, 30000);
    await sync('lobby');

    // 2) аватарка (A ставит до звонка)
    if (ROLE === 'A') {
      await step('avatar', async () => {
        res.avatarSet = await js(`(async () => {
          const c = document.createElement('canvas'); c.width = 300; c.height = 200; const g = c.getContext('2d');
          g.fillStyle = '#ff8800'; g.fillRect(0, 0, 300, 200); g.fillStyle = '#0044ff'; g.fillRect(100, 50, 100, 100);
          const b = await new Promise(r => c.toBlob(r, 'image/png'));
          await pickAvatar(new File([b], 'me.png', { type: 'image/png' }));
          return !!(myAvatar && myAvatar.hash);
        })()`);
      });
    }

    // 3) чат без звонка: A → B текст, B видит счётчик, открывает, отвечает
    if (ROLE === 'A') {
      await js(`openDm(friendsList[0].id); true`);
      res.dmOpened = await waitFor(W, `!document.getElementById('dm').classList.contains('hidden')`, 3000);
      res.dmHasCallHistory = await waitFor(W, `document.getElementById('dmMessages').textContent.includes('привет из звонка')`, 5000);
      await js(`document.getElementById('dmInput').value='привет без звонка'; document.getElementById('dmForm').requestSubmit(); true`);
      res.dmSentNoFail = await waitFor(W, `!document.querySelector('#dmMessages .msg.me.sending') && !document.querySelector('#dmMessages .undel')`, 25000);
    } else {
      res.dmUnreadBadge = await waitFor(W, `!!document.querySelector('#friendsList .fchat .badge')`, 25000);
      await shot('lobby_unread');
      await js(`openDm(friendsList[0].id); true`);
      res.dmReceived = await waitFor(W, `document.getElementById('dmMessages').textContent.includes('привет без звонка')`, 5000);
      res.dmBadgeCleared = await waitFor(W, `!document.querySelector('#friendsList .fchat .badge')`, 3000);
      await js(`document.getElementById('dmInput').value='ответ без звонка'; document.getElementById('dmForm').requestSubmit(); true`);
    }
    if (ROLE === 'A') res.dmReply = await waitFor(W, `document.getElementById('dmMessages').textContent.includes('ответ без звонка')`, 25000);
    await sync('dmtext');

    // 4) файл без звонка (прямое соединение по требованию)
    if (ROLE === 'A') {
      await js(`(async () => {
        const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#3ddc84'; g.fillRect(0, 0, 320, 200);
        const png = await new Promise(r => c.toBlob(r, 'image/png'));
        const big = new Uint8Array(2 * 1024 * 1024); for (let i = 0; i < big.length; i += 4096) crypto.getRandomValues(big.subarray(i, i + 4096));
        dmSendFiles([new File([png], 'green.png', { type: 'image/png' }), new File([big], 'data.bin', { type: 'application/octet-stream' })]);
        return true; })()`);
      res.dmFilesSent = await waitFor(W, `document.querySelectorAll('#dmMessages .msg.me .fstat .btn').length >= 2`, 40000);
    } else {
      res.dmImgReceived = await waitFor(W, `[...document.querySelectorAll('#dmMessages img')].some(i => i.naturalWidth === 320)`, 40000);
      res.dmBinReceived = await waitFor(W, `[...document.querySelectorAll('#dmMessages .fname2')].some(e => e.textContent === 'data.bin') && document.querySelectorAll('#dmMessages .msg:not(.me) .fstat .btn').length >= 2`, 40000);
      res.avatarFromLink = await waitFor(W, `avCache.get(friendsList[0].id) && !!avCache.get(friendsList[0].id).hash`, 10000);
      await shot('dm');
    }
    await sync('dmfile');
    await js(`closeDm(); true`);
    await sleep(500);

    // 5) звонок из списка, история подтягивается
    if (ROLE === 'A') { await js(`callFriend(friendsList[0].id); true`); } else {
      await waitFor(W, `!document.getElementById('callModal').classList.contains('hidden') && document.getElementById('callTitle').textContent.includes('звонит')`, 30000);
      res.incomingAvatar = await waitFor(W, `document.getElementById('callAvatar').classList.contains('has-img')`, 3000);
      await sleep(800);
      await js(`document.getElementById('btnCallAccept').click(); true`);
    }
    res.connected2 = await waitFor(W, `S.connected && document.getElementById('status').classList.contains('ok')`, 45000);
    res.historyInCall = await waitFor(W, `document.getElementById('messages').textContent.includes('привет без звонка') && document.getElementById('messages').textContent.includes('привет из звонка')`, 10000);
    res.historyImage = await waitFor(W, `[...document.querySelectorAll('#messages img')].some(i => i.naturalWidth === 320)`, 8000);
    res.historyBinGone = await js(`[...document.querySelectorAll('#messages .fstat')].some(e => /не сохранено/.test(e.textContent))`);
    if (ROLE === 'B') res.friendCardAvatar = await waitFor(W, `document.querySelector('#friendCard .avatar').classList.contains('has-img')`, 8000);
    await sync('call2');

    // 6) права оверлея: B разрешает реакции
    if (ROLE === 'B') { await js(`store.set('settings', { ...settings(), ovlReact: true }); sendPerm(); true`); }
    if (ROLE === 'A') res.friendPermReact = await waitFor(W, `S.friendPerm && S.friendPerm.react === true && S.friendPerm.draw === true`, 8000);
    await sync('perm');

    // 7) B стримит экран; A шлёт реакцию, рисунок, указку и картинку
    if (ROLE === 'B') {
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        await js(`(async () => { const l = await window.duo.getSources(); pickedId = (l.find(s=>s.isScreen)||l[0]).id; document.getElementById('quality').value='720p30'; await beginShare(); return true })()`).catch(() => {});
        ok = await waitFor(W, `!!S.localScreen`, 8000);
      }
      res.sharing = ok;
      flag('sharing');
    } else {
      await waitFlag('sharing');
      res.remoteShown = await waitFor(W, `!document.getElementById('remoteScreenWrap').classList.contains('hidden')`, 15000);
      await sleep(1500);
      res.toolbarEnabled = await js(`!document.getElementById('toolDraw').disabled && !document.querySelector('#reactBar button').disabled && !document.getElementById('toolImg').disabled`);
      await js(`sendReaction('🔥'); true`);
      // рисуем мышью
      await js(`setTool('draw'); true`);
      const r = await js(`(() => { const b = document.getElementById('remoteScreen').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      W.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
      W.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 10; i++) { W.webContents.sendInputEvent({ type: 'mouseMove', x: r.x + i * 8, y: r.y + i * 4, button: 'left' }); await sleep(30); }
      W.webContents.sendInputEvent({ type: 'mouseUp', x: r.x + 80, y: r.y + 40, button: 'left', clickCount: 1 });
      await sleep(300);
      res.localStroke = await js(`tools.local.size > 0`);
      await js(`setTool('draw'); true`);
      await js(`(async () => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; c.getContext('2d').fillRect(0,0,64,64); const b = await new Promise(r => c.toBlob(r, 'image/png')); sendScreenImage(new File([b], 'x.png', { type: 'image/png' })); return true; })()`);
      await shot('viewer_tools');
    }
    if (ROLE === 'B') {
      const ovl = () => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'alloconnect-overlay');
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && !(ovl() && ovl().isVisible())) await sleep(250);
      res.overlayVisible = !!(ovl() && ovl().isVisible());
      if (ovl()) {
        res.overlayReact = await (async () => { const t1 = Date.now(); while (Date.now() - t1 < 8000) { const n = await ovl().webContents.executeJavaScript(`document.querySelectorAll('.react').length + document.querySelectorAll('.img img').length * 100`).catch(() => 0); if (n >= 100) return n; await sleep(200); } return 0; })();
        res.overlayStroke = await ovl().webContents.executeJavaScript(`typeof strokes !== 'undefined' && strokes.size`).catch((e) => String(e));
        fs.writeFileSync(path.join(SH, 'B_overlay.png'), (await ovl().webContents.capturePage()).toPNG());
      }
    }
    await sync('ovl');

    // 8) управление: A просит, B разрешает (подставной помощник пишет команды в файл)
    if (ROLE === 'A') {
      await js(`ctlRequest(); true`);
      res.ctlGranted = await waitFor(W, `CV.state === 'on'`, 15000);
      res.ctlCompact = await js(`document.getElementById('remoteScreenWrap').classList.contains('ctl-active') && getComputedStyle(document.getElementById('remoteStats')).display === 'none' && getComputedStyle(document.getElementById('btnFull')).display !== 'none' && document.getElementById('reactBar').offsetParent === null && getComputedStyle(document.getElementById('toolCtl')).display !== 'none'`);
      const r = await js(`(() => { const b = document.getElementById('remoteScreen').getBoundingClientRect(); return { x: Math.round(b.left + b.width * 0.25), y: Math.round(b.top + b.height * 0.25) }; })()`);
      W.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
      await sleep(100);
      W.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      W.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(200);
      W.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
      W.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
      await js(`ctlSend(['p', 4096, 0, 255, 1000, -1000, 0, 0], true); ctlSend(['k', 'MetaLeft', 1]); true`);
      await sleep(1500);
      await shot('controlling');
      flag('ctlsent');
      await waitFlag('ctlchecked');
      await js(`ctlViewStop(true); true`);
    } else {
      res.ctlModal = await waitFor(W, `!document.getElementById('ctlModal').classList.contains('hidden')`, 15000);
      await shot('ctl_modal');
      await js(`document.getElementById('btnCtlAllow').click(); true`);
      res.ctlOn = await waitFor(W, `CS.on === true`, 8000);
      res.ctlBadge = await js(`!document.getElementById('ctlBadge').classList.contains('hidden')`);
      await waitFlag('ctlsent');
      await sleep(800);
      const log = fakeLog('input');
      res.inputLog = { area: /^area(win)? /m.test(log), perm: /^perm 1 1 1$/m.test(log), move: /^m 0\.2\d* 0\.2\d*/m.test(log), btn: /^b 0 1$/m.test(log) && /^b 0 0$/m.test(log),
        key: /^k 30 0 1$/m.test(log) && /^k 30 0 0$/m.test(log), pad: /^pad 4096 0 255 1000 -1000 0 0$/m.test(log), noWin: !/^k 91 /m.test(log) };
      flag('ctlchecked');
      res.ctlEndedByViewer = await waitFor(W, `CS.on === false`, 8000);
      await sleep(500);
      res.inputHelperClosed = /EOF/.test(fakeLog('input'));
    }
    await sync('ctl');

    // 9) приглушение: у фейкового микрофона есть звук → у друга срабатывает
    res.duckLevel = await waitFor(W, `duck.level < 1`, 10000);
    await sleep(500);
    res.duckHelperGotLevel = /^level 0\.500$/m.test(fakeLog('duck'));

    // 10) звук саундпада другу
    if (ROLE === 'A') {
      await js(`(async () => {
        const sr = 48000, n = sr / 2; const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
        const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 10) * 8000, true);
        await spAddFiles([new File([buf], 'бип.wav', { type: 'audio/wav' })]);
        await spShare(spList[spList.length - 1].id);
        return true; })()`);
    } else {
      res.soundBubble = await waitFor(W, `[...document.querySelectorAll('#messages .fstat .btn')].some(b => b.textContent.includes('В саундпад'))`, 20000);
      if (res.soundBubble) {
        await js(`[...document.querySelectorAll('#messages .fstat .btn')].find(b => b.textContent.includes('В саундпад')).click(); true`);
        res.soundAdded = await waitFor(W, `spList.some(s => s.name === 'бип')`, 8000);
      }
    }
    await sync('sound');

    // 11) переподключение (перезапуск ICE через канал друзей) — запускает A
    if (ROLE === 'A') {
      await js(`startReconnect('test'); true`);
      res.reconnectStarted = await js(`!!S.reconnecting`);
    }
    res.reconnected = await waitFor(W, `!S.reconnecting && document.getElementById('messages').textContent.includes('Связь восстановлена')`, 40000);
    res.stillConnected = await js(`S.connected && S.pc && S.pc.connectionState === 'connected'`);
    await shot('after_reconnect');
    await sync('rc1');
    // 12) переподключение со стороны принявшего (B): ждёт 20 с, потом начинает сам
    if (ROLE === 'B') { await js(`startReconnect('test-guest'); true`); res.guestReconnectStarted = await js(`!!S.reconnecting`); }
    await sleep(1000);
    if (ROLE === 'B') { res.guestWaitsFirst = await js(`!!S.reconnecting && S.reconnecting.attempts === 0`); }
    res.guestReconnected = await waitFor(W, `!S.reconnecting && S.connected && S.pc.connectionState === 'connected'`, 45000);
    res.rcState = await js(`({ rc: S.reconnecting && { attempts: S.reconnecting.attempts, applied: S.reconnecting.applied, nextAt: S.reconnecting.nextAt }, sig: S.pc && S.pc.signalingState, ice: S.pc && S.pc.iceConnectionState, conn: S.pc && S.pc.connectionState })`).catch((e) => String(e));
    if (ROLE === 'B') res.guestRcMsgs = await js(`(document.getElementById('messages').textContent.match(/Связь восстановлена/g) || []).length`);
    await sync('grc', 60000);
    if (ROLE === 'A') res.hostStillConnectedAfterGuestRc = await js(`S.connected && S.pc.connectionState === 'connected'`);
    // 13) выход: у друга звонок завершается, приглушение и оверлей закрыты
    if (ROLE === 'A') { await sleep(1500); await js(`leaveCall(); true`); }
    else {
      res.peerLeftHandled = await waitFor(W, `!S.connected`, 15000);
      await sleep(1000);
      res.overlayClosed = !BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'alloconnect-overlay');
      res.duckEof = /EOF/.test(fakeLog('duck'));
    }
    const lg = fs.readdirSync(process.env.ALOCALLS_USERDATA + '/logs').map((f) => fs.readFileSync(process.env.ALOCALLS_USERDATA + '/logs/' + f, 'utf-8')).join('');
    res.stunLog = lg.split('\n').filter((l) => /\[stun\]/.test(l) && /"for":"(invite|answer|link)"/.test(l)).slice(0, 5).map((l) => l.slice(24, 200));
    res.inviteGatherMs = (lg.match(/"gatherMs":(\d+)/g) || []).slice(0, 3);
    await sync('done', 60000);
  } catch (e) { res.exception = String(e && e.stack || e); }
  res.errors = errors.filter((e) => !/Security Warning|Autofill/.test(e)).slice(0, 20);
  save();
  app.exit(0);
});
