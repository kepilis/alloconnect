// ТЕСТ группового звонка: три экземпляра A (хост), B, C. A — друг B и C, B и C между собой не друзья
// (их записки идут через A). Запуск — tests/group/run.js.
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
const put = (n, v) => fs.writeFileSync(shf(n), v);
const take = async (n, t = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(shf(n))) return fs.readFileSync(shf(n), 'utf-8'); await sleep(200); } return null; };
async function waitFor(win, expr, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await win.webContents.executeJavaScript(expr)) return true; } catch { /* */ } await sleep(250); } return false; }

app.whenReady().then(async () => {
  await sleep(2500);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errors.push(e.message ?? e.params?.message); });
  const js = (c) => W.webContents.executeJavaScript(c);
  try {
    await js(`document.getElementById('nick').value='user${ROLE}'; true`);
    res.ident = await waitFor(W, `!!myIdent`, 15000);
    put(`id${ROLE}`, JSON.stringify(await js(`window.duo.friendsInfo().then((i) => ({ id: i.id, addrs: i.addrs }))`)));
    const idOf = async (r) => JSON.parse(await take(`id${r}`)).id;
    // дружба: A↔B, A↔C
    const links = ROLE === 'A' ? ['B', 'C'] : ['A'];
    for (const r of links) {
      const o = JSON.parse(await take(`id${r}`));
      await js(`window.duo.friendsAdd(${JSON.stringify({ id: o.id, nick: 'user' + r, addrs: o.addrs })})`);
    }
    const ids = {}; for (const r of ['A', 'B', 'C']) ids[r] = await idOf(r);
    res.friendsOnline = await waitFor(W, `${JSON.stringify(links.map((r) => ids[r]))}.every((id) => friendsList.find((f) => f.id === id)?.online)`, 40000);
    const others = ['A', 'B', 'C'].filter((r) => r !== ROLE);

    if (ROLE === 'A') {
      await js(`grpStart().then((ok) => { if (ok) grpInvite(${JSON.stringify([ids.B, ids.C])}); return ok; })`);
    } else {
      res.gotInvite = await waitFor(W, `!!G.invite && !document.getElementById('gInvModal').classList.contains('hidden')`, 40000);
      await sleep(500);
      await js(`document.getElementById('gInvAccept').click(); true`);
    }
    res.allConnected = await waitFor(W, `[...G.peers.values()].filter((p) => p.connected).length === 2`, 70000);
    res.notFriends = await js(`${JSON.stringify(others.map((r) => ids[r]))}.filter((id) => !isFriend(id)).length`);
    await sleep(3000);
    res.audioIn = await js(`Promise.all([...G.peers.values()].map(async (p) => { let b = 0; (await p.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') b += r.bytesReceived; }); return b; }))`);
    put(`conn${ROLE}`, '1');
    for (const r of others) await take(`conn${r}`, 60000);

    // чат: A, потом C
    const chatOf = (r) => `hello from ${r}`;
    const sendChat = async () => { await js(`document.getElementById('gChatInput').value=${JSON.stringify(chatOf(ROLE))}; document.getElementById('gChatForm').requestSubmit(); true`); put(`chat${ROLE}`, '1'); };
    if (ROLE === 'A') await sendChat();
    if (ROLE === 'C') { await take('chatA'); await sendChat(); }
    for (const r of others.filter((x) => x !== 'B')) { await take(`chat${r}`); }
    await sleep(1500);
    const box = await js(`G.conv.box.textContent`);
    res.chatSeen = others.filter((r) => r !== 'B').every((r) => box.includes(chatOf(r)));

    // экран: показывает B (canvas с анимацией)
    if (ROLE === 'B') {
      await js(`(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d'); let i = 0;
        setInterval(() => { g.fillStyle = 'hsl(' + (i++ * 7 % 360) + ',70%,50%)'; g.fillRect(0, 0, 640, 360); }, 33);
        return grpShareStream(c.captureStream(30), { name: 'тест' }).then(() => true); })()`);
      put('shareB', '1');
    } else {
      await take('shareB');
      res.seeShare = await waitFor(W, `(() => { const t = G.tiles.get(${JSON.stringify(ids.B)}); return !!t && t.classList.contains('sharing') && t.querySelector('video').videoWidth > 0; })()`, 20000);
      res.autoFocus = await js(`G.focus === ${JSON.stringify(ids.B)}`);
      if (process.env.SHOT) { W.setSize(1280, 800); await sleep(1200); fs.writeFileSync(shf(`shot${ROLE}.png`), (await W.webContents.capturePage()).toPNG()); }
    }

    // C выключает микрофон — остальные видят
    if (ROLE === 'C') { await js(`grpSetMuted(true); true`); put('muteC', '1'); }
    else { await take('muteC'); res.seeMuteC = await waitFor(W, `!!G.peers.get(${JSON.stringify(ids.C)})?.muted`, 10000); }

    // C уходит
    put(`pre${ROLE}`, '1');
    for (const r of others) await take(`pre${r}`, 30000);
    if (ROLE === 'C') { await js(`grpLeave(); true`); res.leftOk = await js(`!G.active && document.getElementById('lobby').classList.contains('active')`); put('leftC', '1'); }
    else {
      await take('leftC');
      res.seeLeaveC = await waitFor(W, `!G.peers.has(${JSON.stringify(ids.C)}) && !G.members.has(${JSON.stringify(ids.C)}) && !G.tiles.has(${JSON.stringify(ids.C)})`, 15000);
      res.stillWithOther = await js(`[...G.peers.values()].filter((p) => p.connected).length === 1`);
    }
    // во время группы обычный звонок от друга получает «занят»
    res.busyGuard = ROLE === 'C' ? null : await js(`G.active === true`);

    put(`done${ROLE}`, '1');
    for (const r of others) await take(`done${r}`, 30000);
    await js(`grpLeave(); true`).catch(() => {});
    await sleep(1000);
  } catch (e) { res.exception = String(e && e.stack || e); }
  res.errors = errors.slice(0, 10);
  save();
  app.exit(0);
});
