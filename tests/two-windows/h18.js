// 1.18: вебкамера в звонке на двоих (добавляется в идущий звонок), окна демонстрации/камеры/чата:
// базовые места и «свернуть», свободное расположение (за край не уходит, сцепка едет вместе), отдельное окно.
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
  const rect = (sel) => js(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  const drag = async (x, y, dx, dy) => {
    W.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    W.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 10; i++) { W.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x + dx * i / 10), y: Math.round(y + dy * i / 10), button: 'left' }); await sleep(25); }
    W.webContents.sendInputEvent({ type: 'mouseUp', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
    await sleep(200);
  };
  try {
    W.setSize(1280, 800);
    await js(`document.getElementById('nick').value='${ROLE === 'A' ? 'userA' : 'userB'}'; store.set('settings', { ...settings(), winFree: false }); winSetMode(); true`);
    const LAN = Object.values(require('os').networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal).address;
    await js(`STUN_LISTS.primary = ['stun:${LAN}:3478']; STUN_LISTS.alt = ['stun:${LAN}:3480']; true`);
    await waitFor(W, `!!myIdent`, 15000);
    if (ROLE === 'A') { await waitFlag('ready'); await js(`document.getElementById('btnInvite').click(); true`); } else flag('ready');
    res.connected = await waitFor(W, `S.connected && document.getElementById('status').classList.contains('ok')`, 45000);
    res.peerCam = await waitFor(W, `S.peerCam === true`, 8000);

    // --- камера: включает гость (B) — трансивер добавляет звонивший (A) ---
    await step('cam', async () => {
      if (ROLE === 'B') await js(`camToggle(); true`);
      res.camTx = await waitFor(W, `!!(S.tx && S.tx.cam)`, 20000);
      if (ROLE === 'A') {
        res.camFriendPlays = await waitFor(W, `!document.getElementById('camWrap').classList.contains('hidden') && document.getElementById('camFriend').videoWidth > 0`, 20000);
        await js(`camToggle(); true`); // и A включает свою
      }
      await sync('camboth');
      res.camBothSelf = await waitFor(W, `CAM.on && CAM.peerOn && document.getElementById('camSelf').videoWidth > 0 && document.getElementById('camFriend').videoWidth > 0`, 20000);
      res.camConnStable = await js(`S.pc.connectionState === 'connected' && S.pc.signalingState === 'stable'`);
      await shot('cam_base');
    });
    await sync('camdone');

    // --- B показывает экран; A сворачивает/разворачивает и двигает окна ---
    if (ROLE === 'B') {
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        await js(`(async () => { const l = await window.duo.getSources(); pickedId = (l.find(s=>s.isScreen)||l[0]).id; document.getElementById('quality').value='720p30'; await beginShare(); return true })()`).catch(() => {});
        ok = await waitFor(W, `!!S.localScreen`, 8000);
      }
      res.sharing = ok;
      flag('sharing');
      await waitFlag('windone', 240000);
    } else {
      await waitFlag('sharing');
      await step('base', async () => {
        res.remoteShown = await waitFor(W, `!document.getElementById('remoteScreenWrap').classList.contains('hidden')`, 15000);
        await sleep(1000);
        // базовый режим: значков, кроме «свернуть», не видно
        res.baseOnlyMin = await js(`[...document.querySelectorAll('#call .wbtn')].filter((b) => b.offsetParent).every((b) => b.dataset.a === 'min')`);
        res.camOverScreen = await js(`(() => { const s = document.getElementById('remoteScreenWrap').getBoundingClientRect(), c = document.getElementById('camWrap').getBoundingClientRect(); return c.left >= s.left && c.right <= s.right && c.top >= s.top && c.bottom <= s.bottom; })()`);
        await js(`document.getElementById('btnScreenMin').click(); true`);
        res.screenMinMuted = await js(`document.getElementById('remoteScreen').muted && document.getElementById('remoteScreenWrap').offsetParent === null && document.querySelectorAll('#winDock .wchip').length >= 1`);
        await shot('minimized');
        await js(`document.querySelector('#winDock .wchip').click(); true`);
        res.screenRestored = await js(`!document.getElementById('remoteScreen').muted && document.getElementById('remoteScreenWrap').offsetParent !== null`);
        await js(`document.querySelector('#callChat .wbtn[data-a="min"]').click(); true`);
        res.chatMin = await js(`document.getElementById('callChat').offsetParent === null`);
        await js(`[...document.querySelectorAll('#winDock .wchip')].find((b) => b.textContent.includes('Чат')).click(); true`);
      });
      await step('free', async () => {
        await js(`store.set('settings', { ...settings(), winFree: true }); store.set('winLayout', null); winSetMode(); true`);
        await sleep(400);
        res.freeIcons = await js(`document.querySelectorAll('#remoteScreenWrap .wbtn').length === 4 && !!document.querySelector('#remoteScreenWrap > .whead').offsetParent`);
        const stage = await rect('#call .stage');
        const h = await rect('#remoteScreenWrap > .whead');
        const cam0 = await rect('#camWrap');
        // тащим демонстрацию далеко за левый-верхний край → окно остаётся внутри, камера едет следом
        await drag(h.x + 60, h.y + 12, -900, -600);
        const s1 = await rect('#remoteScreenWrap');
        const cam1 = await rect('#camWrap');
        res.clampedInside = s1.x >= stage.x && s1.y >= stage.y;
        res.camFollows = Math.abs((cam1.x - cam0.x) - (s1.x - (h.x - 1))) < 40; // примерно на тот же сдвиг
        res.camMoved = cam1.x !== cam0.x || cam1.y !== cam0.y;
        res.camAboveScreen = await js(`Number(getComputedStyle(document.getElementById('camWrap')).zIndex) > Number(getComputedStyle(document.getElementById('remoteScreenWrap')).zIndex)`);
        // тащим чат за правый-нижний край
        const ch = await rect('#callChat .chat-head');
        await drag(ch.x + 30, ch.y + 15, 2000, 2000);
        const c1 = await rect('#callChat');
        res.chatInside = c1.x + c1.w <= stage.x + stage.w + 1 && c1.y + c1.h <= stage.y + stage.h + 1;
        // размер за угол — не больше приложения
        const rz = await rect('#remoteScreenWrap .wresize');
        await drag(rz.x + 8, rz.y + 8, 3000, 3000);
        const s2 = await rect('#remoteScreenWrap');
        res.resizeInside = s2.x + s2.w <= stage.x + stage.w + 1 && s2.y + s2.h <= stage.y + stage.h + 1;
        // закрепить: больше не двигается
        await js(`document.querySelector('#remoteScreenWrap .wbtn[data-a="pin"]').click(); true`);
        const h2 = await rect('#remoteScreenWrap > .whead');
        await drag(h2.x + 60, h2.y + 12, 150, 100);
        const s3 = await rect('#remoteScreenWrap');
        res.pinnedStays = s3.x === s2.x && s3.y === s2.y;
        await js(`document.querySelector('#remoteScreenWrap .wbtn[data-a="pin"]').click(); true`);
        res.layoutSaved = await js(`!!store.get('winLayout', null)`);
        await shot('free');
      });
      await step('pop', async () => {
        await js(`document.querySelector('#callChat .wbtn[data-a="pop"]').click(); true`);
        await sleep(1200);
        const wins = BrowserWindow.getAllWindows().filter((w) => w !== W && w.getTitle() !== 'alloconnect-overlay');
        res.popWindow = wins.length >= 1;
        res.popFound = await js(`!document.getElementById('callChat') && !!$('chatInput') && !!WIN.pops.chat`);
        // сообщение из вынесенного чата уходит
        await js(`$('chatInput').value = 'из отдельного окна'; $('chatForm').requestSubmit(); true`);
        res.popSend = await waitFor(W, `!!$('messages') && $('messages').textContent.includes('из отдельного окна')`, 5000);
        const pw = wins[0];
        if (pw) pw.close();
        await sleep(800);
        res.popReturned = await js(`!!document.getElementById('callChat') && !WIN.pops.chat`);
        await js(`store.set('settings', { ...settings(), winFree: false }); winSetMode(); true`);
        res.baseBack = await js(`document.getElementById('remoteScreenWrap').style.left === '' && !document.querySelector('#call .stage').classList.contains('free')`);
      });
      flag('windone');
    }
    await sync('end', 60000);
  } catch (e) { res.exception = String(e && e.stack || e).slice(0, 800); }
  save();
  await sleep(1500);
  app.exit(0);
});
