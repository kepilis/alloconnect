// 1.17: прокрутка чата с картинкой, «прочитано», настройки по разделам, горячие клавиши, новые темы,
// граница чата, фигуры при рисовании, звук в повторе, видео → звук саундпада, выход из управления (Ctrl+Shift+X).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const ROLE = process.env.ROLE; const SH = process.env.SHARED;
require('./main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = {}; const errors = [];
const save = () => fs.writeFileSync(path.join(SH, `res${ROLE}.json`), JSON.stringify({ ...res, errors }, null, 2));
setInterval(save, 1000);
const OTHER = ROLE === 'A' ? 'B' : 'A';
const flag = (n) => fs.writeFileSync(path.join(SH, `${ROLE}_${n}`), '1');
const waitFlag = async (n, t = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(path.join(SH, `${OTHER}_${n}`))) return true; await sleep(200); } return false; };
const sync = async (n, t) => { flag(n); return waitFlag(n, t); };
async function waitFor(win, expr, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await win.webContents.executeJavaScript(expr)) return true; } catch { /* */ } await sleep(250); } return false; }

app.whenReady().then(async () => {
  await sleep(2500);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errors.push(String(e.message ?? e.params?.message).slice(0, 300)); });
  const js = (c) => W.webContents.executeJavaScript(c);
  const shot = async (n) => fs.writeFileSync(path.join(SH, `${ROLE}_${n}.png`), (await W.webContents.capturePage()).toPNG());
  const step = async (name, fn) => { try { await fn(); } catch (e) { res[name + '_exception'] = String(e && e.stack || e).slice(0, 500); } };
  try {
    W.setSize(1280, 800);
    await js(`document.getElementById('nick').value='${ROLE === 'A' ? 'userA' : 'userB'}'; true`);
    const LAN = Object.values(require('os').networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal).address;
    await js(`STUN_LISTS.primary = ['stun:${LAN}:3478']; STUN_LISTS.alt = ['stun:${LAN}:3480']; true`);
    await waitFor(W, `!!myIdent`, 15000);

    // --- настройки (без звонка) ---
    await step('settings', async () => {
      await js(`openSettings(); true`);
      await sleep(800);
      res.settingsCats = await js(`document.querySelectorAll('#settings details.scat').length`);
      res.hotkeyRows = await js(`document.querySelectorAll('#hkList .hk-row').length`);
      res.themeCards = await js(`document.querySelectorAll('#themeGrid .theme-card').length`);
      // все id настроек на месте после перестановки
      res.settingsIdsOk = await js(`['micSelect','outSelect','optRnn','optDuck','optOvlDraw','optClip','optClipAudio','optStreamFrame','optPtt','pttKey','optActivity','optAutoUpd','appTray','appMinToTray','appMinTaskbar','netVerdict','optNoStun','turnUrl'].every((id) => document.getElementById(id))`);
      // горячая клавиша: поменять, прочитать, вернуть
      const set = await js(`window.duo.hotkeysSet('clear', 'CommandOrControl+Alt+F9')`);
      const got = await js(`window.duo.hotkeysGet()`);
      res.hotkeySet = !!set.ok && got.keys.clear === 'CommandOrControl+Alt+F9';
      await js(`window.duo.hotkeysSet('clear', 'CommandOrControl+Alt+End')`);
      // одно сочетание — одно действие
      await js(`window.duo.hotkeysSet('ns', 'CommandOrControl+Shift+M')`);
      const g2 = await js(`window.duo.hotkeysGet()`);
      res.hotkeyUnique = g2.keys.ns === 'CommandOrControl+Shift+M' && g2.keys.mute === '';
      await js(`window.duo.hotkeysSet('ns', 'CommandOrControl+Shift+N').then(() => window.duo.hotkeysSet('mute', 'CommandOrControl+Shift+M'))`);
      // раздел раскрывается и запоминается
      await js(`(() => { const d = document.querySelector('#settings details.scat[data-cat="keys"]'); d.open = true; return true; })()`);
      await sleep(300);
      res.catRemembered = await js(`store.get('settingsOpen', []).includes('keys')`);
      if (ROLE === 'B') {
        for (const t of ['blueprint', 'retro98', 'notebook', 'newspaper']) {
          await js(`applyTheme('${t}'); true`);
          await sleep(500);
          await shot('settings_' + t);
        }
        await js(`applyTheme(''); true`);
      }
      await js(`closeSettings(); true`);
    });

    // --- видео в саундпад: звук из видео ---
    if (ROLE === 'A') {
      await step('spVideo', async () => {
        res.spVideo = await js(`(async () => {
          const c = document.createElement('canvas'); c.width = 160; c.height = 120; const g = c.getContext('2d');
          const ac = audio(); const osc = ac.createOscillator(); const dst = ac.createMediaStreamDestination(); osc.connect(dst); osc.start();
          const st = new MediaStream([...c.captureStream(15).getVideoTracks(), ...dst.stream.getAudioTracks()]);
          const rec = new MediaRecorder(st, { mimeType: 'video/webm;codecs=vp8,opus' }); const parts = [];
          rec.ondataavailable = (e) => parts.push(e.data);
          let n = 0; const iv = setInterval(() => { g.fillStyle = n++ % 2 ? '#f00' : '#00f'; g.fillRect(0, 0, 160, 120); }, 60);
          rec.start(); await new Promise((r) => setTimeout(r, 2000)); rec.stop(); await new Promise((r) => rec.onstop = r); clearInterval(iv); osc.stop();
          const before = spList.length;
          await spAddFiles([new File([new Blob(parts, { type: 'video/webm' })], 'clip.webm', { type: 'video/webm' })]);
          const last = spList[spList.length - 1];
          return spList.length === before + 1 && /\\.wav$/.test(last.file || '') ? true : JSON.stringify(last || null);
        })()`);
      });
    }

    // --- звонок по коду ---
    if (ROLE === 'A') { await waitFlag('ready'); await js(`document.getElementById('btnInvite').click(); true`); } else flag('ready');
    res.connected = await waitFor(W, `S.connected && document.getElementById('status').classList.contains('ok')`, 45000);
    await sleep(1000);

    // --- прокрутка чата: высокая картинка догружается позже ---
    await step('scroll', async () => {
      if (ROLE === 'A') {
        await js(`(async () => { for (let i = 0; i < 25; i++) { document.getElementById('chatInput').value = 'строка ' + i; document.getElementById('chatForm').requestSubmit(); await new Promise(r => setTimeout(r, 40)); } return true; })()`);
        await sleep(1500);
        await js(`(async () => { const c = document.createElement('canvas'); c.width = 300; c.height = 900; const g = c.getContext('2d'); g.fillStyle = '#39f'; g.fillRect(0, 0, 300, 900);
          const b = await new Promise(r => c.toBlob(r, 'image/png')); queueFiles([new File([b], 'tall.png', { type: 'image/png' })]); return true; })()`);
      }
      const ok = await waitFor(W, `[...document.querySelectorAll('#messages img')].some(i => i.naturalHeight === 900 && i.complete)`, 30000);
      await sleep(800);
      res.tallImgLoaded = ok;
      res.scrolledToEnd = await js(`(() => { const s = document.getElementById('messages'); return s.scrollHeight - s.scrollTop - s.clientHeight < 6; })()`);
      // пролистал вверх — новое сообщение не дёргает ленту вниз
      await js(`document.getElementById('messages').scrollTop = 0; true`);
      await sleep(300);
      await sync('scrolledup');
      if (ROLE === 'B') { await js(`document.getElementById('chatInput').value = 'не дёргай'; document.getElementById('chatForm').requestSubmit(); true`); }
      await sleep(1500);
      if (ROLE === 'A') res.staysUpWhenScrolled = await js(`document.getElementById('messages').scrollTop < 50`);
      await sync('scrolldone');
    });

    // --- прочитано: B в фокусе видит сообщение → у A ✓✓ ---
    await step('read', async () => {
      if (ROLE === 'B') { W.show(); W.focus(); W.webContents.focus(); }
      await sync('focus');
      if (ROLE === 'A') {
        await js(`document.getElementById('chatInput').value = 'прочитай меня'; document.getElementById('chatForm').requestSubmit(); true`);
        res.tickSent = await waitFor(W, `[...document.querySelectorAll('#messages .msg.me')].pop()?.querySelector('.tick') != null`, 5000);
        res.tickRead = await waitFor(W, `[...document.querySelectorAll('#messages .msg.me')].pop()?.querySelector('.tick.read') != null`, 15000);
      } else res.bFocused = await js(`document.hasFocus()`);
      await sync('readdone');
    });

    // --- граница чата ---
    await step('split', async () => {
      await js(`setChatWidth(420); true`);
      await sleep(200);
      res.chatWidth = await js(`Math.round(document.querySelector('#call .chat').getBoundingClientRect().width)`);
      await js(`setChatWidth(null); true`);
    });

    // --- B показывает экран: фигуры, повтор со звуком, рамка ---
    if (ROLE === 'B') {
      await step('share', async () => {
        await js(`store.set('settings', { ...settings(), ovlReact: true, clip: true, clipAudio: true }); sendPerm(); true`);
        let ok = false;
        for (let i = 0; i < 3 && !ok; i++) {
          await js(`(async () => { const l = await window.duo.getSources(); pickedId = (l.find(s=>s.isScreen)||l[0]).id; document.getElementById('quality').value='720p30'; await beginShare(); return true })()`).catch(() => {});
          ok = await waitFor(W, `!!S.localScreen`, 8000);
        }
        res.sharing = ok;
        flag('sharing');
        res.clipRunning = await waitFor(W, `!!S.clip && S.clip.running`, 15000);
        await sleep(6000);
        res.clipAudio = await js(`({ chunks: S.clip ? S.clip.audio.length : -1, rate: S.clip?.aconf?.sampleRate || 0 })`);
        res.clipSaved = await js(`(async () => { const b = await S.clip.save(); return b ? b.size : 0; })()`);
      });
    } else {
      await waitFlag('sharing');
      await step('draw', async () => {
        res.remoteShown = await waitFor(W, `!document.getElementById('remoteScreenWrap').classList.contains('hidden')`, 15000);
        await sleep(1500);
        res.menusExist = await js(`!!document.getElementById('drawMenu') && document.querySelectorAll('#drawKinds button').length === 6 && document.querySelectorAll('#emojiMenu #reactBar button').length > 0`);
        await js(`tools.kind = 'rect'; setTool('draw'); true`);
        const r = await js(`(() => { const b = document.getElementById('remoteScreen').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 3), y: Math.round(b.top + b.height / 3) }; })()`);
        W.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
        W.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 8; i++) { W.webContents.sendInputEvent({ type: 'mouseMove', x: r.x + i * 12, y: r.y + i * 8, button: 'left' }); await sleep(30); }
        W.webContents.sendInputEvent({ type: 'mouseUp', x: r.x + 96, y: r.y + 64, button: 'left', clickCount: 1 });
        await sleep(300);
        res.rectPts = await js(`[...tools.local.values()].pop()?.pts.length || 0`);
        await js(`setTool('draw'); tools.kind = 'pen'; true`);
        // рамка вокруг стрима выключается
        await js(`store.set('settings', { ...settings(), streamFrame: false }); applyStreamFrame(); true`);
        res.frameOff = await js(`getComputedStyle(document.getElementById('remoteScreenWrap')).borderTopWidth === '0px'`);
        await js(`store.set('settings', { ...settings(), streamFrame: true }); applyStreamFrame(); true`);
        // видео-эхо у отправителя не тает через 6.5 с
        res.svidEchoNoFade = await js(`(() => { const d = document.createElement('div'); d.className = 'screenimg-echo placed svid-echo'; document.getElementById('remoteScreenWrap').appendChild(d); const a = getComputedStyle(d).animationName; d.remove(); return a === 'none'; })()`);
        for (const t of ['blueprint', 'retro98', 'notebook', 'newspaper']) { await js(`applyTheme('${t}'); true`); await sleep(500); await shot('call_' + t); }
        await js(`applyTheme(''); true`);
      });
    }
    await sync('drawn');

    // --- управление: A просит, B разрешает, A выходит сам по Ctrl+Shift+X ---
    await step('ctl', async () => {
      if (ROLE === 'A') {
        await js(`ctlRequest(); true`);
        res.ctlOn = await waitFor(W, `CV.state === 'on'`, 20000);
        W.webContents.focus();
        await js(`document.getElementById('inputLayer').focus(); true`);
        W.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'X', modifiers: ['control', 'shift'] });
        W.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'X', modifiers: ['control', 'shift'] });
        res.ctlExitByKey = await waitFor(W, `CV.state === 'off'`, 5000);
      } else {
        await waitFor(W, `!document.getElementById('ctlModal').classList.contains('hidden')`, 20000);
        await js(`document.getElementById('btnCtlAllow').click(); true`);
        res.ctlEndedOnStreamer = await waitFor(W, `!CS.on`, 20000);
        // Alt+Tab и Ctrl+Esc у показывающего не проходят
        res.comboBlocked = await js(`(() => { CS.mods.clear(); CS.mods.add('AltLeft'); const a = blockedCombo('Tab') && blockedCombo('F4'); CS.mods.clear(); CS.mods.add('ControlLeft'); const b = blockedCombo('Escape') && !blockedCombo('KeyA'); CS.mods.clear(); return a && b; })()`);
      }
    });
    await sync('ctldone');
  } catch (e) { res.exception = String(e && e.stack || e).slice(0, 800); }
  save();
  await sleep(1500);
  app.exit(0);
});
