// 1.20: мост в групповом звонке (B и C напрямую не соединяются — через A). Основа — h-gcam.js.
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
    if (ROLE === 'B' || ROLE === 'C') await js(`window.GRP_BLOCK = ${J(ids[ROLE === 'B' ? 'C' : 'B'])}; true`);
    res.connA = await waitFor(W, `[...G.peers.values()].filter((p) => p.connected).length >= 1`, 70000);
    await sync('conn');

    // B и C напрямую «не соединяются» — должен подняться мост через A
    // (запрет ставится сразу после входа; первая прямая попытка, если успела, обрывается)
    await step('fwd', async () => {
      if (ROLE === 'B' || ROLE === 'C') {
        const other = ids[ROLE === 'B' ? 'C' : 'B'];
        res.bridged = await waitFor(W, `!!G.vpeers.get(${J(other)})?.connected`, 90000);
        res.bridgeLabel = await js(`G.tiles.get(${J(other)}).querySelector('.badges').textContent.includes('через userA')`);
        await sleep(2500);
        res.bridgeVoiceIn = await js(`(async () => { const v = G.vpeers.get(${J(other)}); let b = 0; (await v.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') b += r.bytesReceived; }); return b; })()`);
      }
      if (ROLE === 'A') res.isBridge = await waitFor(W, `G.bridges.size === 1`, 90000);
    });
    await sync('bridged', 120000);
    await step('fwdChat', async () => {
      if (ROLE === 'C') await js(`document.getElementById('gChatInput').value='через мост от C'; document.getElementById('gChatForm').requestSubmit(); true`);
      if (ROLE === 'B') res.chatViaBridge = await waitFor(W, `document.getElementById('gMessages').textContent.includes('через мост от C')`, 15000);
    });
    await sync('fwdchat');
    await step('fwdShare', async () => {
      if (ROLE === 'C') {
        await js(`(() => { const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d'); let i = 0;
          setInterval(() => { g.fillStyle = 'hsl(' + (i++ * 7 % 360) + ',70%,50%)'; g.fillRect(0, 0, 1280, 720); }, 33);
          return grpShareStream(c.captureStream(30), { name: 'мост' }).then(() => true); })()`);
        await js(`camToggle(); true`);
      }
      if (ROLE === 'B') {
        res.screenViaBridge = await waitFor(W, `(() => { const t = G.tiles.get(${J(ids.C)}); return !!t && t.classList.contains('sharing') && t.querySelector('video:not(.gcam)').videoWidth > 0; })()`, 30000);
        res.camViaBridge = await waitFor(W, `(() => { const t = G.tiles.get(${J(ids.C)}); return !!t && t.classList.contains('cam') && t.querySelector('video.gcam').videoWidth > 0; })()`, 30000);
        await shot('bridge');
      }
    });
    await sync('fwdshare', 120000);
    // запрет снят — прямая связь поднимается, мост гаснет
    await step('direct', async () => {
      if (ROLE === 'B' || ROLE === 'C') {
        await js(`window.GRP_BLOCK = null; true`);
        await sleep(1000);
        const other = ids[ROLE === 'B' ? 'C' : 'B'];
        await js(`(() => { const o = ${J(other)}; const p = G.peers.get(o); if (p && !p.connected) grpClosePeer(p); if (grpMe() > o) grpConnect(o); return true; })()`);
        res.directUp = await waitFor(W, `!!G.peers.get(${J(other)})?.connected && !G.vpeers.has(${J(other)})`, 40000);
      }
      if (ROLE === 'A') res.bridgeClosed = await waitFor(W, `G.bridges.size === 0`, 50000);
    });
    await sync('end');
  } catch (e) { res.exception = String(e && e.stack || e).slice(0, 800); }
  save();
  await sleep(1500);
  app.exit(0);
});
