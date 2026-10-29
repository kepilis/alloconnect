// 1.19: камера и окна в групповом звонке. Три экземпляра: A↔B, A↔C друзья, B–C — через A.
// Камеры B и C видят все (в плитке вместо аватарки), камера при показе экрана — маленькой в углу,
// «свернуть» чат, свободное расположение (за край не уходит), свёрнутые «Участники» — без звука экранов, чат в отдельном окне.
// Запуск — tests/group/run-gcam.js.
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
const save = () => fs.writeFileSync(path.join(SH, `res${ROLE}.json`), JSON.stringify({ ...res, errors }, null, 2));
setInterval(save, 1000);
const shf = (n) => path.join(SH, n);
const put = (n, v = '1') => fs.writeFileSync(shf(n), v);
const take = async (n, t = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(shf(n))) return fs.readFileSync(shf(n), 'utf-8'); await sleep(200); } return null; };
async function waitFor(win, expr, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await win.webContents.executeJavaScript(expr)) return true; } catch { /* */ } await sleep(250); } return false; }
const FRIENDS = { A: ['B', 'C'], B: ['A'], C: ['A'] };
const ALL = ['A', 'B', 'C'];

app.whenReady().then(async () => {
  await sleep(2500);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errors.push(String(e.message ?? e.params?.message).slice(0, 300)); });
  const js = (c) => W.webContents.executeJavaScript(c);
  const sync = async (name, t = 90000) => { put(`${name}${ROLE}`); for (const r of ALL) if (r !== ROLE) await take(`${name}${r}`, t); };
  const step = async (name, fn) => { try { await fn(); } catch (e) { res[name + 'Error'] = String(e && e.stack || e).slice(0, 400); } };
  const shot = async (n) => fs.writeFileSync(shf(`${ROLE}_${n}.png`), (await W.webContents.capturePage()).toPNG());
  const J = (x) => JSON.stringify(x);
  try {
    W.setSize(1280, 800);
    await js(`document.getElementById('nick').value='user${ROLE}'; store.set('settings', { ...settings(), winFree: false }); winSetMode(); true`);
    await waitFor(W, `!!myIdent`, 15000);
    put(`id${ROLE}`, JSON.stringify(await js(`window.duo.friendsInfo().then((i) => ({ id: i.id, addrs: i.addrs }))`)));
    const ids = {};
    for (const r of ALL) ids[r] = JSON.parse(await take(`id${r}`)).id;
    for (const r of FRIENDS[ROLE]) {
      const o = JSON.parse(await take(`id${r}`));
      await js(`window.duo.friendsAdd(${J({ id: o.id, nick: 'user' + r, addrs: o.addrs })})`);
    }
    res.friendsOnline = await waitFor(W, `${J(FRIENDS[ROLE].map((r) => ids[r]))}.every((id) => friendsList.find((f) => f.id === id)?.online)`, 40000);
    if (ROLE === 'A') await js(`grpStart().then((ok) => { if (ok) grpInvite(${J([ids.B, ids.C])}); return ok; })`);
    else { await waitFor(W, `!!G.invite`, 40000); await sleep(500); await js(`grpAcceptInvite(); true`); }
    res.conn = await waitFor(W, `[...G.peers.values()].filter((p) => p.connected).length === 2`, 70000);
    await sleep(1500);
    await sync('conn');

    const camSeen = (r) => `(() => { const t = G.tiles.get(${J(ids[r])}); return !!t && t.classList.contains('cam') && t.querySelector('video.gcam').videoWidth > 0; })()`;
    // B включает камеру — видят A и C
    await step('camB', async () => {
      if (ROLE === 'B') { await js(`camToggle(); true`); res.ownCamTile = await waitFor(W, camSeen('B'), 10000); }
      else res.seeCamB = await waitFor(W, camSeen('B'), 25000);
    });
    await sync('camB');
    // C тоже — видят A и B (B–C идёт без дружбы)
    await step('camC', async () => {
      if (ROLE === 'C') await js(`camToggle(); true`);
      else res.seeCamC = await waitFor(W, camSeen('C'), 25000);
    });
    await sync('camC');
    await shot('cams');

    // A показывает экран и включает камеру: у B и C — экран и камера в углу
    await step('shareA', async () => {
      if (ROLE === 'A') {
        await js(`(() => { const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d'); let i = 0;
          setInterval(() => { g.fillStyle = 'hsl(' + (i++ * 7 % 360) + ',70%,50%)'; g.fillRect(0, 0, 1280, 720); }, 33);
          const ac = audio(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
          return grpShareStream(c.captureStream(30), { name: 'тест', atrack: d.stream.getAudioTracks()[0] }).then(() => true); })()`);
        await js(`camToggle(); true`);
      } else {
        res.seeShareCamA = await waitFor(W, `(() => { const t = G.tiles.get(${J(ids.A)}); if (!t) return false; const v = t.querySelector('video:not(.gcam)'), c = t.querySelector('video.gcam');
          return t.classList.contains('sharing') && t.classList.contains('cam') && v.videoWidth > 0 && c.videoWidth > 0 && c.getBoundingClientRect().width < t.getBoundingClientRect().width / 2; })()`, 30000);
      }
    });
    await sync('shareA');
    if (ROLE === 'B') await shot('share_cam');

    // окна — у B
    if (ROLE === 'B') {
      await step('win', async () => {
        await js(`document.querySelector('#gChat .wbtn[data-a="min"]').click(); true`);
        res.chatMin = await js(`document.getElementById('gChat').offsetParent === null && !!document.querySelector('#group .wchip')`);
        await js(`document.querySelector('#group .wchip').click(); true`);
        res.chatBack = await js(`document.getElementById('gChat').offsetParent !== null`);
        await js(`store.set('settings', { ...settings(), winFree: true }); store.set('winLayoutG', null); winSetMode(); true`);
        await sleep(400);
        res.freeHead = await js(`!!document.querySelector('#gView > .whead').offsetParent && document.querySelectorAll('#gView .wbtn').length === 4`);
        const st = await js(`(() => { const r = document.querySelector('#group .stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
        const h = await js(`(() => { const r = document.querySelector('#gView > .whead').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()`);
        const x = h[0] + 60, y = h[1] + 12;
        W.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        W.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 10; i++) { W.webContents.sendInputEvent({ type: 'mouseMove', x: x + 300 * i, y: y + 200 * i, button: 'left' }); await sleep(25); }
        W.webContents.sendInputEvent({ type: 'mouseUp', x: x + 3000, y: y + 2000, button: 'left', clickCount: 1 });
        await sleep(300);
        res.gviewInside = await js(`(() => { const s = document.querySelector('#group .stage').getBoundingClientRect(), r = document.getElementById('gView').getBoundingClientRect(); return r.left >= s.left - 1 && r.top >= s.top - 1 && r.right <= s.right + 1 && r.bottom <= s.bottom + 1; })()`);
        // свёрнутые «Участники» — звук экрана A молчит, голос остаётся
        await js(`document.querySelector('#gView .wbtn[data-a="min"]').click(); true`);
        res.gviewMinMuted = await js(`(() => { const p = G.peers.get(${J(ids.A)}); return p.aud.gsvol.gain.gain.value === 0 && p.aud.gvol.gain.gain.value > 0; })()`);
        await js(`document.querySelector('#group .wchip').click(); true`);
        res.gviewSoundBack = await js(`G.peers.get(${J(ids.A)}).aud.gsvol.gain.gain.value > 0`);
        res.gviewBack = await js(`document.getElementById('gView').offsetParent !== null && !document.querySelector('#group .wchip')`);
        await shot('free');
        // чат — в отдельное окно и обратно
        await js(`document.querySelector('#gChat .wbtn[data-a="pop"]').click(); true`);
        await sleep(1200);
        res.popFound = await js(`!document.getElementById('gChat') && !!$('gChatInput') && !!WING.pops.gchat`);
        const pw = BrowserWindow.getAllWindows().find((w) => w !== W && w.getTitle().includes('Чат'));
        res.popWindow = !!pw;
        pw?.close();
        await sleep(800);
        res.popReturned = await js(`!!document.getElementById('gChat') && !WING.pops.gchat`);
        await js(`store.set('settings', { ...settings(), winFree: false }); winSetMode(); true`);
      });
    }
    await sync('win', 120000);
    // C выключил камеру — у A пропала
    await step('camOff', async () => {
      if (ROLE === 'C') await js(`camToggle(); true`);
      if (ROLE === 'A') res.camOffSeen = await waitFor(W, `!G.tiles.get(${J(ids.C)}).classList.contains('cam')`, 15000);
    });
    await sync('end');
  } catch (e) { res.exception = String(e && e.stack || e).slice(0, 800); }
  save();
  await sleep(1500);
  app.exit(0);
});
