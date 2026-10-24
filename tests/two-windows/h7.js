const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
require('./main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROLE = process.env.ROLE, SH = process.env.SHARED, VD = process.env.VIDS;
const flag = (n) => fs.writeFileSync(`${SH}/${ROLE}_${n}`, '1');
const waitFlag = async (n, t = 60000) => { const o = ROLE === 'A' ? 'B' : 'A'; const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(`${SH}/${o}_${n}`)) return true; await sleep(200); } return false; };
const b64 = (f) => fs.readFileSync(`${VD}/${f}`).toString('base64');
const res = {};
app.whenReady().then(async () => {
  await sleep(3000);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  const js = (c) => W.webContents.executeJavaScript(c);
  const errs = []; W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errs.push(e.message ?? e.params?.message); });
  const waitFor = async (expr, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if (await js(expr)) return true; } catch { } await sleep(250); } return false; };
  const ovlWin = () => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'alloconnect-overlay');
  const ovlVid = async () => { const o = ovlWin(); if (!o) return 'no overlay'; return o.webContents.executeJavaScript(`(() => { const b = document.querySelector('.vid:not(.out)'); if (!b) return null; const v = b.querySelector('video'); const r = b.getBoundingClientRect(); return { cx: (r.left + r.width / 2) / innerWidth, cy: (r.top + r.height / 2) / innerHeight, w: r.width / innerWidth, vol: v.volume, muted: v.muted, t: v.currentTime, paused: v.paused, nick: b.textContent, vis: b.style.visibility }; })()`); };
  const mkFile = (f, mime) => `new File([Uint8Array.from(atob('${b64(f)}'), c => c.charCodeAt(0))], '${f}', { type: '${mime}' })`;
  const toasts = `document.getElementById('toast').textContent`;
  try {
    await waitFor(`friendsList[0] && friendsList[0].online`, 30000);
    if (ROLE === 'B') await js(`store.set('settings', { ...settings(), ovlReact: true, svidInSound: true, svidInVol: 50 }); true`);
    flag('ready'); await waitFlag('ready');
    if (ROLE === 'A') await js(`callFriend(friendsList[0].id); true`);
    else { await waitFor(`!document.getElementById('callModal').classList.contains('hidden')`, 30000); await sleep(500); await js(`document.getElementById('btnCallAccept').click(); true`); }
    res.connected = await waitFor(`S.connected`, 40000);
    if (ROLE === 'B') {
      for (let i = 0; i < 3 && !(await js(`!!S.localScreen`)); i++) { await js(`(async () => { const l = await window.duo.getSources(); pickedId = (l.find(s=>s.isScreen)||l[0]).id; document.getElementById('quality').value='720p30'; await beginShare(); return true })()`).catch(() => {}); await sleep(3000); }
      res.sharing = await js(`!!S.localScreen`);
      flag('sharing');
      // 1) mp4 со звуком 60% → у меня 60% × 50% = 30%
      await waitFlag('sent1', 90000);
      let v1 = null; for (let i = 0; i < 40 && !(v1 = await ovlVid())?.t; i++) await sleep(250);
      await sleep(1000);
      res.ovl1 = await ovlVid();
      res.ovlVisible1 = ovlWin()?.isVisible();
      if (ovlWin()) fs.writeFileSync(`${SH}/B_vid1.png`, (await ovlWin().webContents.capturePage()).toPNG());
      await sleep(5000);
      res.ovl1AfterEnd = await ovlVid();
      flag('seen1');
      // 2) webm без звука
      await waitFlag('sent2', 60000);
      for (let i = 0; i < 40 && !(await ovlVid())?.t; i++) await sleep(250);
      res.ovl2 = await ovlVid();
      flag('seen2');
      // 3) у меня звук видео выключен в настройках
      await js(`store.set('settings', { ...settings(), svidInSound: false }); true`);
      flag('mute-set');
      await waitFlag('sent3', 60000);
      for (let i = 0; i < 40 && !(await ovlVid())?.t; i++) await sleep(250);
      res.ovl3 = await ovlVid();
      // 4) выключил картинки/видео — отправитель получает отказ
      await js(`store.set('settings', { ...settings(), ovlReact: false }); sendPerm(); true`);
      flag('off-set');
      res.settingsUi = await js(`(() => { openSettings && openSettings(); const r = { snd: !!document.getElementById('optSvidSound'), vol: document.getElementById('svidInVol')?.value, upd: document.getElementById('optAutoUpd')?.checked, gh: !!document.getElementById('btnGhCheck') }; return r; })()`).catch((e) => String(e));
    } else {
      await waitFlag('sharing');
      res.remote = await waitFor(`!document.getElementById('remoteScreenWrap').classList.contains('hidden') && S.friendPerm && S.friendPerm.react && S.friendPerm.vid`, 20000);
      await sleep(1500);
      // a) длинное видео — отказ без размещения
      await js(`startPlacement(${mkFile('long.mp4', 'video/mp4')}); true`);
      await sleep(1500);
      res.longRejected = await js(`({ placer: !!placer, toast: ${toasts} })`);
      // b) больше 100 МБ — отказ (проверка до чтения)
      res.bigRejected = await js(`(async () => { const f = new File([new Uint8Array(1)], 'big.mp4', { type: 'video/mp4' }); Object.defineProperty(f, 'size', { value: 101 * 1048576 }); startPlacement(f); await new Promise(r => setTimeout(r, 300)); return { placer: !!placer, toast: ${toasts} }; })()`);
      // c) перетаскивание mp4 на стрим в точку (30%, 60%)
      res.drop = await js(`(async () => {
        const dt = new DataTransfer(); dt.items.add(${mkFile('short.mp4', 'video/mp4')});
        const r = videoRect(); const x = r.x + r.w * 0.3, y = r.y + r.h * 0.6;
        const target = document.elementFromPoint(x, y);
        target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true }));
        const overlayText = document.getElementById('dropOverlay').textContent;
        target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true }));
        for (let i = 0; i < 30 && !placer; i++) await new Promise(r => setTimeout(r, 100));
        await new Promise(r => setTimeout(r, 600));
        const v = document.querySelector('.placer video');
        return { placer: !!placer, vid: placer && placer.vid, x: placer && placer.x, y: placer && placer.y, aspect: placer && placer.aspect, overlayText, previewPlaying: v && !v.paused, previewVol: v && v.volume, hasVol: !!document.querySelector('.placer-vol'), hasSnd: !!document.querySelector('.placer-sound') };
      })()`);
      await js(`(() => { const r = document.querySelector('.placer-vol'); r.value = 60; r.dispatchEvent(new Event('input')); return true; })()`);
      res.volLabel = await js(`document.querySelector('.placer-volval').textContent`);
      // размер ползунком
      await js(`(() => { const r = document.querySelector('.placer-size'); r.value = 40; r.dispatchEvent(new Event('input')); return true; })()`);
      fs.writeFileSync(`${SH}/A_vplacer.png`, (await W.webContents.capturePage()).toPNG());
      res.beforeSend1 = await js(`({ x: placer.x, y: placer.y, w: placer.w, vid: placer.vid })`);
      W.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); W.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await sleep(200);
      res.statusShown = await js(`!!document.querySelector('.svid-status')`);
      res.echo1 = await waitFor(`!!document.querySelector('.svid-echo video') && document.querySelector('.svid-echo video').currentTime > 0`, 20000);
      res.echo1Info = await js(`(() => { const v = document.querySelector('.svid-echo video'); return v && { vol: v.volume, muted: v.muted, status: !!document.querySelector('.svid-status') }; })()`);
      fs.writeFileSync(`${SH}/A_vecho.png`, (await W.webContents.capturePage()).toPNG());
      res.savedPrefs = await js(`({ v: settings().svidVol, s: settings().svidSound })`);
      flag('sent1');
      await sleep(6500);
      res.echoGone = await js(`!document.querySelector('.svid-echo') && !svidOut`);
      await waitFlag('seen1', 30000);
      await sleep(3200);
      // 2) webm кнопкой, звук выключен галочкой
      await js(`sendScreenImage(${mkFile('clip.webm', 'video/webm')}); true`);
      res.webmPlacer = await waitFor(`!!placer && !!placer.vid`, 8000);
      res.prefRemembered = await js(`placer && placer.vid.vol`);
      await js(`(() => { const c = document.querySelector('.placer-sound'); c.checked = false; c.dispatchEvent(new Event('change')); return true; })()`);
      res.noSoundUi = await js(`({ label: document.querySelector('.placer-volval').textContent, disabled: document.querySelector('.placer-vol').disabled, muted: document.querySelector('.placer video').muted })`);
      await js(`document.querySelector('.placer-send').click(); true`);
      flag('sent2');
      await waitFlag('seen2', 30000);
      await sleep(4500);
      // 3) получатель выключил звук видео у себя; я шлю со звуком
      await waitFlag('mute-set', 30000);
      await js(`store.set('settings', { ...settings(), svidSound: true }); sendScreenImage(${mkFile('short.mp4', 'video/mp4')}); true`);
      await waitFor(`!!placer && !!placer.vid`, 8000);
      await js(`commitPlacement(); true`);
      flag('sent3');
      await sleep(6500);
      // 4) друг выключил разрешение
      await waitFlag('off-set', 30000);
      await sleep(1000);
      await js(`sendScreenImage(${mkFile('short.mp4', 'video/mp4')}); true`);
      await sleep(800);
      res.offRejected = await js(`({ placer: !!placer, toast: ${toasts} })`);
    }
    await sleep(1500);
    flag('done'); await waitFlag('done', 90000);
  } catch (e) { res.exception = String(e.stack || e); }
  res.errors = errs.slice(0, 5);
  console.log(ROLE, 'RESULT', JSON.stringify(res, null, 1));
  app.exit(0);
});
