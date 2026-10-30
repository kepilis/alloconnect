// 1.21: ник на любом языке доходит другу; стикеры (импорт папки, отправка, вид у получателя); свои уведомления;
// своя камера в углу не рисуется, пока выключена; поворот картинки на экране друга (pl.r).
// ALOCALLS_STK_PICK — папка со стикерами для импорта (подставляет run21.js).
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
  const W = BrowserWindow.getAllWindows().find((w) => !/alloconnect-(overlay|notify)/.test(w.getTitle()));
  W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errors.push(String(e.message ?? e.params?.message).slice(0, 300)); });
  const js = (c) => W.webContents.executeJavaScript(c);
  const shot = async (n, w = W) => fs.writeFileSync(path.join(SH, `${ROLE}_${n}.png`), (await w.webContents.capturePage()).toPNG());
  const step = async (name, fn) => { try { await fn(); } catch (e) { res[name + '_exception'] = String(e && e.stack || e).slice(0, 500); } };
  try {
    W.setSize(1280, 800);
    await js(`document.getElementById('nick').value='${ROLE === 'A' ? 'userA' : 'userB'}'; document.getElementById('nick').dispatchEvent(new Event('input')); true`);
    const LAN = Object.values(require('os').networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal).address;
    await js(`STUN_LISTS.primary = ['stun:${LAN}:3478']; STUN_LISTS.alt = ['stun:${LAN}:3480']; true`);
    await waitFor(W, `!!myIdent`, 15000);
    if (ROLE === 'A') { await waitFlag('ready'); await js(`document.getElementById('btnInvite').click(); true`); } else flag('ready');
    res.connected = await waitFor(W, `S.connected && document.getElementById('status').classList.contains('ok')`, 45000);
    await waitFor(W, `!document.getElementById('btnAddFriend').classList.contains('hidden')`, 10000);
    await js(`document.getElementById('btnAddFriend').click(); true`);
    res.friendSaved = await waitFor(W, `friendsList.length === 1`, 10000);
    await sync('friends');

    // 1) своя камера в углу не рисуется, пока выключена (B включает свою, у A своей нет)
    await step('camSelf', async () => {
      if (ROLE === 'B') await js(`camToggle(); true`);
      if (ROLE === 'A') {
        res.friendCamShown = await waitFor(W, `!document.getElementById('camWrap').classList.contains('hidden') && document.getElementById('camFriend').videoWidth > 0`, 20000);
        res.noEmptySelf = await js(`getComputedStyle(document.getElementById('camSelf')).display === 'none'`);
      }
    });
    await sync('camself');
    if (ROLE === 'B') await js(`camToggle(); true`);

    // 2) стикеры: B добавляет папку (две подпапки → два набора), шлёт стикер, у A он без плашки
    await step('stickers', async () => {
      if (ROLE === 'B') {
        await js(`stkImport('folder')`);
        res.stkPacks = await waitFor(W, `!!STK.data && STK.data.packs.length === 2 && STK.data.packs.every((p) => p.items.length === 12)`, 15000);
        await js(`stkOpen('call', document.querySelector('#chatForm .stk-btn')); true`);
        res.stkPickerImgs = await waitFor(W, `[...document.querySelectorAll('#stkGrid .stk-item img')].filter((i) => i.naturalWidth > 0).length >= 6`, 10000);
        await shot('picker');
        await js(`document.querySelector('#stkGrid .stk-item').click(); true`);
        res.stkSentMine = await waitFor(W, `!!document.querySelector('#messages .msg.me.sticker img')`, 15000);
      } else {
        res.stkReceived = await waitFor(W, `(() => { const i = document.querySelector('#messages .msg.sticker img'); return !!i && i.naturalWidth > 0 && getComputedStyle(i.closest('.bubble')).backgroundColor === 'rgba(0, 0, 0, 0)'; })()`, 20000);
        await js(`document.querySelector('#messages .msg.sticker .stk-take').click(); true`);
        res.stkTaken = await waitFor(W, `window.duo.stickersList().then((d) => d.packs.some((p) => p.name === 'Полученные' && p.items.length === 1))`, 8000);
        await shot('sticker_in');
      }
    });
    await sync('stk');

    // 3) свои уведомления: A не в фокусе, B шлёт картинку — у A окно уведомлений с аватаркой/картинкой
    await step('notify', async () => {
      if (ROLE === 'A') { W.minimize(); await sleep(500); flag('blurred'); }
      if (ROLE === 'B') {
        await waitFlag('blurred');
        await js(`(async () => { const c = document.createElement('canvas'); c.width = 200; c.height = 120; const g = c.getContext('2d'); g.fillStyle = '#e63946'; g.fillRect(0, 0, 200, 120);
          const b = await new Promise(r => c.toBlob(r, 'image/png')); queueFiles([new File([b], 'red.png', { type: 'image/png' })]); return true; })()`);
      }
      if (ROLE === 'A') {
        const t0 = Date.now(); let nw = null;
        while (Date.now() - t0 < 20000 && !nw) { nw = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'alloconnect-notify' && w.isVisible()); await sleep(250); }
        res.ntfShown = !!nw;
        if (nw) {
          await sleep(800);
          res.ntfCard = await nw.webContents.executeJavaScript(`[...document.querySelectorAll('.nt')].some((c) => c.querySelector('.nt-title').textContent === 'userB' && /картинка/.test(c.querySelector('.nt-body').textContent) && (c.querySelector('.nt-media')?.naturalWidth || 0) === 200)`);
          res.ntfNoFocus = !nw.isFocused();
          fs.writeFileSync(path.join(SH, 'A_notify.png'), (await nw.webContents.capturePage()).toPNG());
        }
        W.restore(); W.show();
      }
    });
    await sync('ntf');

    // 4) ник на русском доходит другу (в списке друзей), без звонка
    await step('nick', async () => {
      if (ROLE === 'A') { await js(`document.getElementById('nick').value = 'Колобок 日本'; document.getElementById('nick').dispatchEvent(new Event('input')); true`); res.nickStored = await js(`store.get('nick', '') === 'Колобок 日本'`); }
      if (ROLE === 'B') res.nickArrived = await waitFor(W, `friendsList[0] && friendsList[0].nick === 'Колобок 日本'`, 30000);
    });
    await sync('nick');

    // 5) поворот картинки на экране друга: A показывает экран, B кладёт картинку с поворотом 90° — у A в оверлей уходит r: 90
    await step('rot', async () => {
      if (ROLE === 'A') {
        await js(`store.set('settings', { ...settings(), ovlReact: true }); sendPerm(); true`);
        let ok = false;
        for (let i = 0; i < 3 && !ok; i++) {
          await js(`(async () => { const l = await window.duo.getSources(); pickedId = (l.find(s=>s.isScreen)||l[0]).id; document.getElementById('quality').value='720p30'; await beginShare(); return true })()`).catch(() => {});
          ok = await waitFor(W, `!!S.localScreen`, 8000);
        }
        flag('sharing');
        // картинка друга — в окне оверлея: повёрнута на 90°
        const t0 = Date.now(); res.rotArrived = false;
        while (Date.now() - t0 < 25000 && !res.rotArrived) {
          const ov = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'alloconnect-overlay');
          if (ov) res.rotArrived = await ov.webContents.executeJavaScript(`[...document.querySelectorAll('.img.placed')].some((b) => b.style.rotate === '90deg')`).catch(() => false);
          await sleep(300);
        }
      } else {
        await waitFlag('sharing');
        await waitFor(W, `!document.getElementById('remoteScreenWrap').classList.contains('hidden') && S.friendPerm && S.friendPerm.react`, 20000);
        await js(`(async () => { const c = document.createElement('canvas'); c.width = 160; c.height = 90; c.getContext('2d').fillRect(0, 0, 160, 90);
          const b = await new Promise(r => c.toBlob(r, 'image/png')); startPlacement(new File([b], 'r.png', { type: 'image/png' }), [0.5, 0.5]); return true; })()`);
        await sleep(600);
        await js(`document.querySelector('.placer .placer-rr').click(); true`);
        res.rotPreview = await js(`getComputedStyle(document.querySelector('.placer .placer-box')).rotate === '90deg'`);
        await js(`commitPlacement(); true`);
      }
    });
    await sync('end', 60000);
  } catch (e) { res.exception = String(e && e.stack || e).slice(0, 800); }
  save();
  await sleep(1500);
  app.exit(0);
});
