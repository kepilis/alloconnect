// ТЕСТ группового звонка: четыре экземпляра. Дружба: A↔B, A↔C, B↔D (остальные пары — не друзья,
// их записки идут через участников). A собирает группу и зовёт B и C; потом B (не создатель) зовёт D.
// Запуск — tests/group/run.js.
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
const FRIENDS = { A: ['B', 'C'], B: ['A', 'D'], C: ['A'], D: ['B'] };
const ALL = ['A', 'B', 'C', 'D'];

app.whenReady().then(async () => {
  await sleep(2500);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errors.push(e.message ?? e.params?.message); });
  const js = (c) => W.webContents.executeJavaScript(c);
  // барьер: все из списка дошли до точки name
  const sync = async (name, roles, t = 90000) => { put(`${name}${ROLE}`); for (const r of roles) if (r !== ROLE) await take(`${name}${r}`, t); };
  const step = async (name, fn) => { try { await fn(); } catch (e) { res[name + 'Error'] = String(e && e.message || e); } };
  try {
    await js(`document.getElementById('nick').value='user${ROLE}'; true`);
    res.ident = await waitFor(W, `!!myIdent`, 15000);
    put(`id${ROLE}`, JSON.stringify(await js(`window.duo.friendsInfo().then((i) => ({ id: i.id, addrs: i.addrs }))`)));
    const ids = {};
    for (const r of ALL) ids[r] = JSON.parse(await take(`id${r}`)).id;
    for (const r of FRIENDS[ROLE]) {
      const o = JSON.parse(await take(`id${r}`));
      await js(`window.duo.friendsAdd(${JSON.stringify({ id: o.id, nick: 'user' + r, addrs: o.addrs })})`);
    }
    res.friendsOnline = await waitFor(W, `${JSON.stringify(FRIENDS[ROLE].map((r) => ids[r]))}.every((id) => friendsList.find((f) => f.id === id)?.online)`, 40000);
    const J = (x) => JSON.stringify(x);
    const nConnected = `[...G.peers.values()].filter((p) => p.connected).length`;
    const tileOf = (r) => `G.tiles.get(${J(ids[r])})`;
    const ABC = ['A', 'B', 'C'];

    // 1. A собирает группу, зовёт B и C
    if (ROLE === 'A') await js(`grpStart().then((ok) => { if (ok) grpInvite(${J([ids.B, ids.C])}); return ok; })`);
    if (ROLE === 'B' || ROLE === 'C') {
      res.gotInvite = await waitFor(W, `!!G.invite && !document.getElementById('gInvModal').classList.contains('hidden')`, 40000);
      await sleep(500);
      await js(`document.getElementById('gInvAccept').click(); true`);
    }
    if (ROLE !== 'D') {
      res.conn3 = await waitFor(W, `${nConnected} === 2`, 70000);
      await sleep(3000);
      res.audioIn = await js(`Promise.all([...G.peers.values()].map(async (p) => { let b = 0; (await p.pc.getStats(p.atx.receiver.track)).forEach((r) => { if (r.type === 'inbound-rtp') b += r.bytesReceived; }); return b; }))`);
    }
    await sync('c3', ALL);

    // 2. чат, ответ с цитатой, реакция, правка, чужое удаление не проходит
    if (ROLE !== 'D') await step('chat', async () => {
      if (ROLE === 'A') {
        await js(`document.getElementById('gChatInput').value='hello from A'; document.getElementById('gChatForm').requestSubmit(); true`);
        put('midA', await js(`[...G.conv.msgs.keys()].pop()`));
      }
      const midA = await take('midA');
      await waitFor(W, `G.conv.msgs.has(${J(midA)})`, 10000);
      if (ROLE === 'C') {
        await js(`setCompose(composers.grp, 'reply', G.conv.msgs.get(${J(midA)})); document.getElementById('gChatInput').value='reply from C'; document.getElementById('gChatForm').requestSubmit(); true`);
        await js(`sendMsgOp(G.conv, { op: 'del', ref: ${J(midA)} })`); // чужое — не должно удалиться
        put('chatC');
      }
      if (ROLE === 'B') { await js(`sendMsgOp(G.conv, { op: 'react', ref: ${J(midA)}, e: '👍' })`); put('reactB'); }
      await take('chatC'); await take('reactB');
      if (ROLE === 'A') { await sleep(800); await js(`sendMsgOp(G.conv, { op: 'edit', ref: ${J(midA)}, text: 'edited by A' })`); put('editA'); }
      await take('editA');
      await sleep(1500);
      res.chat = await js(`(() => { const it = G.conv.msgs.get(${J(midA)}); const q = [...G.conv.box.querySelectorAll('.msg .quote')].map((x) => x.textContent);
        return { text: it.el.querySelector('.btext')?.textContent, deleted: !!it.e.deleted, chip: it.el.querySelector('.react-chip')?.textContent || '', quote: q.join('|'), hasReply: G.conv.box.textContent.includes('reply from C') }; })()`);
    });
    await sync('c4', ABC);

    // 3. B показывает экран со звуком (canvas + генератор)
    if (ROLE !== 'D') await step('share', async () => {
      if (ROLE === 'B') {
        await js(`(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d'); let i = 0;
          setInterval(() => { g.fillStyle = 'hsl(' + (i++ * 7 % 360) + ',70%,50%)'; g.fillRect(0, 0, 640, 360); }, 33);
          const ac = audio(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
          return grpShareStream(c.captureStream(30), { name: 'тест', atrack: d.stream.getAudioTracks()[0] }).then(() => true); })()`);
        put('shareB');
      } else {
        await take('shareB');
        res.seeShare = await waitFor(W, `(() => { const t = ${tileOf('B')}; return !!t && t.classList.contains('sharing') && t.querySelector('video').videoWidth > 0; })()`, 20000);
        res.autoFocus = await js(`G.focus === ${J(ids.B)}`);
        await sleep(2500);
        res.shareAudioIn = await js(`(async () => { const p = G.peers.get(${J(ids.B)}); let b = 0; (await p.pc.getStats(p.satx.receiver.track)).forEach((r) => { if (r.type === 'inbound-rtp') b += r.bytesReceived; }); return b; })()`);
        if (process.env.SHOT && ROLE === 'C') { W.setSize(1280, 800); await sleep(1200); fs.writeFileSync(shf('shotC.png'), (await W.webContents.capturePage()).toPNG()); }
      }
    });
    await sync('c5', ABC);

    // 4. A шлёт файл всем
    if (ROLE !== 'D') await step('file', async () => {
      if (ROLE === 'A') await js(`grpQueueFiles([new File([new Uint8Array(300000).fill(65)], 'test.txt', { type: 'text/plain' })]); true`);
      res.fileOk = await waitFor(W, `[...G.conv.box.querySelectorAll('.msg')].some((m) => m.textContent.includes('test.txt') && [...m.querySelectorAll('button')].some((b) => b.textContent === 'Сохранить'))`, 20000);
      if (ROLE !== 'A') res.fileFrom = await js(`[...G.conv.box.querySelectorAll('.msg')].find((m) => m.textContent.includes('test.txt'))?.querySelector('.meta')?.textContent || ''`);
    });
    // 5. C выключает микрофон
    if (ROLE === 'C') { await js(`grpSetMuted(true); true`); put('muteC'); }
    else if (ROLE !== 'D') { await take('muteC'); res.seeMuteC = await waitFor(W, `!!G.peers.get(${J(ids.C)})?.muted`, 10000); }
    await sync('c6', ALL);

    // 6. B (не создатель) зовёт своего друга D; D не друг A и C — записки через участников
    if (ROLE === 'B') await js(`grpInvite([${J(ids.D)}]); true`);
    if (ROLE === 'D') {
      res.gotInvite = await waitFor(W, `!!G.invite`, 40000);
      await sleep(500);
      await js(`grpAcceptInvite(); true`);
    }
    res.conn4 = await waitFor(W, `${nConnected} === 3`, 80000);
    await sync('c7', ALL);

    // 7. обрыв: B рвёт соединение с C — оба переподключаются сами
    if (ROLE === 'B') await js(`G.peers.get(${J(ids.C)}).pc.close(); true`);
    if (ROLE === 'B' || ROLE === 'C') {
      const other = ROLE === 'B' ? 'C' : 'B';
      await sleep(1000);
      res.reconnected = await waitFor(W, `!!G.peers.get(${J(ids[other])})?.connected && ${nConnected} === 3`, 60000);
      res.backMsg = await js(`G.conv.box.textContent.includes('снова на связи')`);
    }
    await sync('c8', ALL);

    // 8. создатель A уходит — остальные продолжают втроём
    if (ROLE === 'A') { await js(`grpLeave(); true`); res.leftOk = await js(`!G.active`); }
    else res.afterHostLeft = await waitFor(W, `!G.members.has(${J(ids.A)}) && ${nConnected} === 2`, 20000);
    await sync('c9', ALL);
    // 9. C уходит — B и D остаются вдвоём
    if (ROLE === 'C') await js(`grpLeave(); true`);
    if (ROLE === 'B' || ROLE === 'D') res.lastTwo = await waitFor(W, `!G.members.has(${J(ids.C)}) && ${nConnected} === 1`, 20000);
    await sync('c10', ALL);
    await js(`grpLeave(); true`).catch(() => {});
    await sleep(1500);
    await sync('c11', ALL);

    // 10. группа сохранилась: B собирает её снова — зовёт своих друзей A и D, а C (не друг B) зовёт его друг A
    res.savedGroup = await js(`grpSaved().length === 1 && !document.getElementById('groupsBox').classList.contains('hidden')`);
    if (ROLE === 'B') { await js(`grpCallSaved(grpSaved()[0].gid); true`); }
    if (ROLE === 'A' || ROLE === 'D') {
      res.gotInvite2 = await waitFor(W, `!!G.invite`, 40000);
      await sleep(500);
      await js(`grpAcceptInvite(); true`);
    }
    if (ROLE === 'A') { await waitFor(W, `G.active && [...G.peers.values()].some((p) => p.connected)`, 40000); await js(`grpInvite([${J(ids.C)}]); true`); }
    if (ROLE === 'C') {
      res.gotInvite2 = await waitFor(W, `!!G.invite`, 60000);
      await sleep(500);
      await js(`grpAcceptInvite(); true`);
    }
    res.conn4again = await waitFor(W, `${nConnected} === 3`, 80000);
    await sleep(1500);
    res.history = await js(`G.conv.box.textContent`);
    res.sameGid = await js(`G.gid === grpSaved()[0]?.gid`);
    await sync('c12', ALL);

    // 11. самозванец: у D «ломается» ключ, B переподключается к нему — B должен его отвергнуть
    if (ROLE === 'D') { await js(`grpOnCh = async (p) => grpSend(p, { t: 'proof', mac: 'AAAA' }); true`); put('badD'); }
    if (ROLE === 'B') {
      await take('badD');
      await js(`G.peers.get(${J(ids.D)}).pc.close(); true`);
      res.rejectedD = await waitFor(W, `G.left.has(${J(ids.D)}) && !G.members.has(${J(ids.D)}) && /ключ не его|не подтвердил свой ID/.test(G.conv.box.textContent)`, 60000);
      res.othersStay = await js(`${nConnected} === 2`);
    }
    await sync('c13', ALL);
    await js(`grpLeave(); true`).catch(() => {});
    await sleep(1000);
  } catch (e) { res.exception = String(e && e.stack || e); }
  res.errors = errors.slice(0, 10);
  save();
  app.exit(0);
});
