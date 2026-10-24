const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
require('./main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROLE = process.env.ROLE, SH = process.env.SHARED;
const flag = (n) => fs.writeFileSync(`${SH}/${ROLE}_${n}`, '1');
const waitFlag = async (n, t = 60000) => { const o = ROLE === 'A' ? 'B' : 'A'; const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(`${SH}/${o}_${n}`)) return true; await sleep(150); } return false; };
const res = {};
app.whenReady().then(async () => {
  await sleep(3000);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  const js = (c) => W.webContents.executeJavaScript(c);
  const waitFor = async (expr, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if (await js(expr)) return true; } catch { } await sleep(200); } return false; };
  const SIZES = (process.env.SIZES || '1180x760,1000x640,800x540').split(',').map((s) => s.split('x').map(Number));
  const probe = `(() => { const vis = (id) => { const e = document.getElementById(id); if (!e) return 'none'; const r = e.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 ? 'ok' : 'OUT(' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + innerWidth + ')'; };
    const ppl = document.querySelector('.people').getBoundingClientRect(), chat = document.querySelector('aside.chat').getBoundingClientRect();
    return { inner: innerWidth + 'x' + innerHeight, leave: vis('btnLeave'), share: vis('btnShare'), mute: vis('btnMute'), send: vis('chatInput'), peopleOverChat: Math.round(ppl.right - chat.left), docScrollW: document.documentElement.scrollWidth }; })()`;
  try {
    await waitFor(`friendsList[0] && friendsList[0].online`, 30000);
    if (ROLE === 'A') { W.setMinimumSize(300, 200); W.setSize(640, 480); await sleep(600); fs.writeFileSync(`${SH}/A_lobby640.png`, (await W.webContents.capturePage()).toPNG()); await js(`openSettings(); true`); await sleep(500); fs.writeFileSync(`${SH}/A_settings640.png`, (await W.webContents.capturePage()).toPNG()); await js(`document.querySelector('#settings [data-close]').click(); openDm(friendsList[0].id)`); await sleep(600); fs.writeFileSync(`${SH}/A_dm640.png`, (await W.webContents.capturePage()).toPNG()); await js(`closeDm(); true`); W.setSize(1180, 760); }
    flag('ready'); await waitFlag('ready');
    if (ROLE === 'A') await js(`callFriend(friendsList[0].id); true`);
    else { await waitFor(`!document.getElementById('callModal').classList.contains('hidden')`, 30000); await sleep(400); await js(`document.getElementById('btnCallAccept').click(); true`); }
    res.connected = await waitFor(`S.connected`, 40000);
    if (ROLE === 'A') {
      for (const [w, h] of SIZES) { W.setMinimumSize(300, 200); W.setSize(w, h); await sleep(600); res['call_' + w] = await js(probe); fs.writeFileSync(`${SH}/A_${w}x${h}.png`, (await W.webContents.capturePage()).toPNG()); }
      flag('shots1');
      await waitFlag('sharing', 30000); await sleep(2500);
      for (const [w, h] of SIZES) { W.setSize(w, h); await sleep(600); res['stream_' + w] = await js(probe); fs.writeFileSync(`${SH}/A_s_${w}x${h}.png`, (await W.webContents.capturePage()).toPNG()); }
    } else {
      await waitFlag('shots1', 60000);
      for (let i = 0; i < 3 && !(await js(`!!S.localScreen`)); i++) { await js(`(async () => { const l = await window.duo.getSources(); pickedId = (l.find(s=>s.isScreen)||l[0]).id; document.getElementById('quality').value='720p30'; await beginShare(); return true })()`).catch(() => {}); await sleep(3000); }
      flag('sharing');
      await sleep(2500); W.setMinimumSize(300, 200); W.setSize(640, 480); await sleep(800); fs.writeFileSync(`${SH}/B_share640.png`, (await W.webContents.capturePage()).toPNG());
    }
    await sleep(1000); flag('done'); await waitFlag('done', 90000);
  } catch (e) { res.exception = String(e.stack || e); }
  console.log(ROLE, 'RESULT', JSON.stringify(res, null, 1));
  app.exit(0);
});
