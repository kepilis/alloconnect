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

    await js(`store.set('settings', { ...settings(), winFree: true }); winSetMode(); true`);
    const geo = async (n) => { res[n] = await js(`(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; return { win: [innerWidth, innerHeight], stage: r('#call .stage'), controls: r('#call .controls'), top: r('#call .topbar'), screen: r('#remoteScreenWrap'), local: r('#localScreenWrap'), chat: r('#callChat'), cam: r('#camWrap'), scrollY: document.scrollingElement.scrollTop, callScroll: document.getElementById('call').scrollTop }; })()`); await shot(n); };
    await geo('g_before');
    if (ROLE === 'B') {
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        await js(`(async () => { const l = await window.duo.getSources(); pickedId = (l.find(s=>s.isScreen)||l[0]).id; document.getElementById('quality').value='720p30'; await beginShare(); return true })()`).catch(() => {});
        ok = await waitFor(W, `!!S.localScreen`, 8000);
      }
      flag('sharing');
    } else { await waitFlag('sharing'); await waitFor(W, `!document.getElementById('remoteScreenWrap').classList.contains('hidden')`, 15000); }
    await sleep(2500);
    await geo('g_share');
    for (const [w, h] of [[1920, 1040], [1000, 680]]) { W.setSize(w, h); await sleep(1200); await geo('g_' + w); }
    await sync('end', 60000);
  } catch (e) { res.exception = String(e && e.stack || e).slice(0, 800); }
  save();
  await sleep(1500);
  app.exit(0);
});
