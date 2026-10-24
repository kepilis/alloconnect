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
    // байты, пришедшие по трансиверу участника (atx — голос, satx — звук экрана)
    const inBytes = (pExpr, tx) => `(async (p) => { let b = 0; (await p.pc.getStats(p.${tx}.receiver.track)).forEach((r) => { if (r.type === 'inbound-rtp') b += r.bytesReceived; }); return b; })(${pExpr})`;
    const seesShare = (r) => `(() => { const t = ${tileOf(r)}; return !!t && t.classList.contains('sharing') && t.querySelector('video').videoWidth > 0; })()`;
    const acceptInvite = async (key, t = 40000) => { res[key] = await waitFor(W, `!!G.invite`, t); await sleep(500); await js(`grpAcceptInvite(); true`); };
    const ABC = ['A', 'B', 'C'];

    // 1. A собирает группу, зовёт B и C
    if (ROLE === 'A') await js(`grpStart().then((ok) => { if (ok) grpInvite(${J([ids.B, ids.C])}); return ok; })`);
    if (ROLE === 'B' || ROLE === 'C') {
      res.gotInvite = await waitFor(W, `!!G.invite && !document.getElementById('gInvModal').classList.contains('hidden')`, 40000);
      await sleep(500);
      await js(`document.getElementById('gInvAccept').click(); true`); // здесь — через кнопку окна
    }
    if (ROLE !== 'D') {
      res.conn3 = await waitFor(W, `${nConnected} === 2`, 70000);
      await sleep(3000);
      res.audioIn = await js(`Promise.all([...G.peers.values()].map((p) => ${inBytes('p', 'atx')}))`);
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
        await js(`GT.ovlLog = []; true`); // что уходит в оверлей — для проверки рисунков ниже
        await js(`(() => { const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d'); let i = 0;
          setInterval(() => { g.fillStyle = 'hsl(' + (i++ * 7 % 360) + ',70%,50%)'; g.fillRect(0, 0, 1280, 720); }, 33);
          const ac = audio(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
          return grpShareStream(c.captureStream(30), { name: 'тест', atrack: d.stream.getAudioTracks()[0] }).then(() => true); })()`);
        put('shareB');
      } else {
        await take('shareB');
        res.seeShare = await waitFor(W, seesShare('B'), 20000);
        res.autoFocus = await js(`G.focus === ${J(ids.B)}`);
        await sleep(2500);
        res.shareAudioIn = await js(inBytes(`G.peers.get(${J(ids.B)})`, 'satx'));
        // SHOT=1: снимки экрана группы во всех темах, в обычном и в самом маленьком окне
        if (process.env.SHOT && ROLE === 'C') {
          for (const [w, h] of [[1280, 800], [640, 480]]) {
            W.setSize(w, h);
            for (const th of await js(`THEMES.map((t) => t.id)`)) {
              await js(`applyTheme(${J(th)}); true`);
              await sleep(700);
              fs.writeFileSync(shf(`shot-${th || 'std'}-${w}.png`), (await W.webContents.capturePage()).toPNG());
            }
          }
          await js(`applyTheme(''); true`);
        }
      }
    });
    await sync('c5', ABC);

    // 3б. качество по тому, как смотрят; рисунок, указка и реакция A на экране B; саундпад A
    if (ROLE !== 'D') await step('tools', async () => {
      const pB = `G.peers.get(${J(ids.B)})`, pC = `G.peers.get(${J(ids.C)})`;
      const enc = (pp) => `${pp}.vtx.sender.getParameters().encodings[0]`;
      if (ROLE === 'C') { await js(`G.focus = null; grpRender(); true`); put('unfocusC'); await take('thumbOk'); await js(`G.focus = ${J(ids.B)}; grpRender(); true`); put('refocusC'); }
      if (ROLE === 'B') {
        await take('unfocusC');
        res.thumbC = await waitFor(W, `${pC}.view === 'thumb' && ${enc(pC)}.scaleResolutionDownBy > 1 && ${enc(pC)}.maxBitrate === 600000`, 10000);
        put('thumbOk');
        await take('refocusC');
        res.fullC = await waitFor(W, `${pC}.view === 'full' && ${enc(pC)}.scaleResolutionDownBy === 1 && ${enc(pC)}.maxBitrate > 600000`, 10000);
        await js(`store.set('settings', { ...settings(), ovlReact: true }); grpPermChanged(); true`);
        put('permB');
      }
      await take('permB');
      if (ROLE === 'A') {
        res.permSeen = await waitFor(W, `!!${pB}?.perm?.react && !!${pB}?.perm?.draw`, 10000);
        res.toolsShown = await js(`G.tiles.get(${J(ids.B)}).classList.contains('tools')`);
        await js(`(() => { const el = G.tiles.get(${J(ids.B)}); const inp = el.querySelector('.ginput');
          grpSetTool('draw'); const r = inp.getBoundingClientRect();
          const ev = (t, k) => inp.dispatchEvent(new PointerEvent(t, { clientX: r.left + r.width * k, clientY: r.top + r.height / 2, pointerId: 1, bubbles: true }));
          ev('pointerdown', 0.3); ev('pointermove', 0.4); GT.flushAt = 0; ev('pointermove', 0.5); ev('pointerup', 0.5);
          grpSetTool('ptr'); GT.ptrAt = 0; ev('pointermove', 0.6);
          grpReact(${J(ids.B)}, '🔥'); return true; })()`);
        put('drawA');
      }
      if (ROLE === 'B') {
        await take('drawA');
        await waitFor(W, `['stroke', 'ptr', 'react'].every((t) => GT.ovlLog.some((m) => m.t === t))`, 10000);
        res.ovl = await js(`({ types: [...new Set(GT.ovlLog.map((m) => m.t))], strokeColor: GT.ovlLog.find((m) => m.t === 'stroke')?.c, wantColor: grpColor(${J(ids.A)}), ptrNick: GT.ovlLog.find((m) => m.t === 'ptr')?.nick })`);
      }
      if (ROLE === 'C') {
        await take('drawA');
        res.seeStrokeA = await waitFor(W, `[...GT.strokes.keys()].some((k) => k.startsWith(${J(ids.A.slice(0, 12))}))`, 10000);
        res.seeReactA = await waitFor(W, `!!G.tiles.get(${J(ids.B)}).querySelector('.react-float')`, 5000);
      }
      // саундпад: пока звучит — голос шире у всех
      if (ROLE === 'A') {
        await js(`(async () => { const sr = 48000, n = sr * 3; const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
          const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
          w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
          v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
          for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / sr * 2 * Math.PI * 440) * 8000, true);
          await spAddFiles([new File([buf], 'beep.wav', { type: 'audio/wav' })]);
          await spPlay(spList[spList.length - 1].id); return true; })()`);
        res.spWide = await waitFor(W, `[...G.peers.values()].every((p) => p.atx.sender.getParameters().encodings[0].maxBitrate === 128000)`, 5000);
        await js(`spStopAll(); true`);
        res.spNarrow = await waitFor(W, `[...G.peers.values()].every((p) => p.atx.sender.getParameters().encodings[0].maxBitrate === 64000)`, 5000);
      }
    });
    await sync('c5b', ABC);

    // 4. A шлёт файл всем
    if (ROLE !== 'D') await step('file', async () => {
      if (ROLE === 'A') await js(`grpQueueFiles([new File([new Uint8Array(300000).fill(65)], 'test.txt', { type: 'text/plain' })]); true`);
      res.fileOk = await waitFor(W, `[...G.conv.box.querySelectorAll('.msg')].some((m) => m.textContent.includes('test.txt') && [...m.querySelectorAll('button')].some((b) => b.textContent === 'Сохранить'))`, 20000);
      if (ROLE !== 'A') res.fileFrom = await js(`[...G.conv.box.querySelectorAll('.msg')].find((m) => m.textContent.includes('test.txt'))?.querySelector('.meta')?.textContent || ''`);
    });
    // 5. C выключает микрофон
    if (ROLE === 'C') { await js(`setMuted(true); true`); put('muteC'); }
    else if (ROLE !== 'D') { await take('muteC'); res.seeMuteC = await waitFor(W, `!!G.peers.get(${J(ids.C)})?.muted`, 10000); }
    await sync('c6', ALL);

    // 6. B (не создатель) зовёт своего друга D; D не друг A и C — записки через участников
    if (ROLE === 'B') await js(`grpInvite([${J(ids.D)}]); true`);
    if (ROLE === 'D') {
      await acceptInvite('gotInvite', 40000);
    }
    res.conn4 = await waitFor(W, `${nConnected} === 3`, 80000);
    await sync('c7', ALL);

    // 6б. D показывает настоящий экран со звуком компьютера (как через окно выбора)
    await step('real', async () => {
      if (ROLE === 'D') {
        res.realShare = await js(`(async () => { pickerSources = await window.duo.getSources(); pickedId = pickerSources.find((s) => s.isScreen)?.id || null;
          if (!pickedId) return { src: false };
          document.getElementById('quality').value = '720p30'; document.getElementById('sysAudio').checked = true;
          await grpBeginShare(); return { src: true, on: !!G.share, audio: !!G.share?.atrack, helper: !!pcmNode }; })()`);
        put('realD');
        await take('realSeenA'); await take('realSeenB'); await take('realSeenC');
        // управление: A просит — разрешаю (мышь и клавиатура, без геймпада)
        res.ctlModal = await waitFor(W, `!document.getElementById('ctlModal').classList.contains('hidden') && CS.link?.id === ${J(ids.A)}`, 20000);
        await js(`document.getElementById('ctlPad').checked = false; document.getElementById('btnCtlAllow').click(); true`);
        res.ctlOn = await waitFor(W, `CS.on && CS.link?.id === ${J(ids.A)} && !G.tiles.get(myIdent.id).querySelector('.gctl').classList.contains('hidden')`, 15000);
        put('ctlOnD');
        res.ctlInput = await waitFor(W, `Date.now() - CS.lastMsg < 3000 && CS.released === false`, 15000);
        await take('ctlStopA');
        res.ctlOff = await waitFor(W, `!CS.on && !CS.link`, 10000);
        await js(`grpStopShare(); true`);
        // окно приложения: свернули — заглушка, развернули — снова окно; «развернуть сразу» при старте
        const tw = new BrowserWindow({ width: 640, height: 400, title: 'grp-test-win' });
        await tw.loadURL('data:text/html;charset=utf-8,<title>grp-test-win</title><body style="background:%233a7;font:40px sans-serif">окно для теста</body>');
        await sleep(1500);
        const pickWin = `pickerSources = await window.duo.getSources(); pickedId = pickerSources.find((x) => x.name === 'grp-test-win')?.id || null;
          document.getElementById('quality').value = '720p30'; document.getElementById('sysAudio').checked = false;`;
        res.winShare = await js(`(async () => { ${pickWin} if (!pickedId) return { src: false };
          window.__winSrc = pickedId; document.getElementById('autoRestore').checked = false; await grpBeginShare();
          return { src: true, on: !!G.share, real: !!G.share?.win?.real && G.share.track === G.share.win.real.getVideoTracks()[0] }; })()`);
        put('winOnD');
        tw.minimize();
        res.winPh = await waitFor(W, `!!G.share?.win?.ph && G.share.track === G.share.win.ph.track`, 15000);
        put('winMinD');
        await take('winMinSeenA');
        tw.restore();
        res.winBack = await waitFor(W, `!!G.share?.win?.real && G.share.track === G.share.win.real.getVideoTracks()[0] && G.share.track.readyState === 'live'`, 15000);
        await js(`grpStopShare(); true`);
        tw.minimize();
        await sleep(1200);
        // своё свёрнутое окно система в список не отдаёт — берём номер, запомненный при первом показе
        res.winAuto = await js(`(async () => { pickedId = window.__winSrc; if (!pickedId) return false;
          document.getElementById('autoRestore').checked = true; await grpBeginShare();
          return !!G.share && !G.share.win.ph && !!G.share.win.real; })()`);
        await js(`grpStopShare(); true`);
        tw.destroy();
      } else {
        await take('realD');
        res.seeRealD = await waitFor(W, seesShare('D'), 25000);
        await sleep(2500);
        res.realAudioIn = await js(inBytes(`G.peers.get(${J(ids.D)})`, 'satx'));
        put('realSeen' + ROLE);
        if (ROLE === 'A') {
          await waitFor(W, `!!G.peers.get(${J(ids.D)})?.perm?.ctl`, 10000);
          await js(`G.focus = ${J(ids.D)}; grpRender(); grpCtlClick(${J(ids.D)}); true`);
          res.ctlViewOn = await waitFor(W, `CV.state === 'on' && CV.link?.id === ${J(ids.D)} && G.tiles.get(${J(ids.D)}).classList.contains('ctl-active')`, 30000);
          await take('ctlOnD');
          for (let i = 0; i < 5; i++) { await js(`ctlSend(['r', 0, 0], true); true`); await sleep(300); } // сдвиг на 0 — курсор на месте
          put('ctlBusyA');
          await take('ctlDeniedC');
          await js(`grpCtlClick(${J(ids.D)}); true`); // отдать управление
          res.ctlViewOff = await waitFor(W, `CV.state === 'off' && !CV.link`, 10000);
          put('ctlStopA');
          // D свернул показываемое окно — у меня его плитка по-прежнему показывает экран (заглушку)
          await take('winOnD');
          await take('winMinD');
          res.winMinSeen = await waitFor(W, seesShare('D'), 15000);
          put('winMinSeenA');
        }
        if (ROLE === 'C') {
          await take('ctlBusyA');
          await js(`G.focus = ${J(ids.D)}; grpRender(); grpCtlClick(${J(ids.D)}); true`);
          res.ctlDenied = await waitFor(W, `CV.state === 'off' && !CV.link`, 15000);
          put('ctlDeniedC');
        }
      }
    });
    await sync('c7b', ALL);

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
      await acceptInvite('gotInvite2', 40000);
    }
    if (ROLE === 'A') { await waitFor(W, `G.active && [...G.peers.values()].some((p) => p.connected)`, 40000); await js(`grpInvite([${J(ids.C)}]); true`); }
    if (ROLE === 'C') {
      await acceptInvite('gotInvite2', 60000);
    }
    res.conn4again = await waitFor(W, `${nConnected} === 3`, 80000);
    await sleep(1500);
    res.history = await js(`G.conv.box.textContent`);
    res.sameGid = await js(`G.gid === grpSaved()[0]?.gid`);
    await sync('c12', ALL);

    // 11. самозванец: у D «ломается» ключ, B переподключается к нему — B должен его отвергнуть
    if (ROLE === 'D') { await js(`window.__okCh = grpOnCh; grpOnCh = async (p) => grpSend(p, { t: 'proof', mac: 'AAAA' }); true`); put('badD'); }
    if (ROLE === 'B') {
      await take('badD');
      await js(`G.peers.get(${J(ids.D)}).pc.close(); true`);
      res.rejectedD = await waitFor(W, `G.left.has(${J(ids.D)}) && !G.members.has(${J(ids.D)}) && /ключ не его|не подтвердил свой ID/.test(G.conv.box.textContent)`, 60000);
      res.othersStay = await js(`${nConnected} === 2`);
    }
    await sync('c13', ALL);
    await js(`grpLeave(); true`).catch(() => {});
    if (ROLE === 'D') await js(`grpOnCh = window.__okCh; true`); // снова честный
    await sleep(1500);
    await sync('c14', ALL);

    // 12. встречная сборка: A и B одновременно собирают ту же сохранённую группу — половины соединяются
    if (ROLE === 'A' || ROLE === 'B') await js(`grpCallSaved(grpSaved()[0].gid); true`);
    else {
      await acceptInvite('gotInvite3', 60000);
    }
    res.merged = await waitFor(W, `${nConnected} === 3`, 90000);
    res.mergedGid = await js(`G.gid === grpSaved()[0]?.gid`);
    await sync('c15', ALL);
    await js(`grpLeave(); true`).catch(() => {});
    await sleep(1000);
  } catch (e) { res.exception = String(e && e.stack || e); }
  res.errors = errors.slice(0, 10);
  save();
  app.exit(0);
});
