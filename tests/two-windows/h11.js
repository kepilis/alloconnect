const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
require('./main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROLE = process.env.ROLE, SH = process.env.SHARED;
const flag = (n) => fs.writeFileSync(`${SH}/${ROLE}_${n}`, '1');
const waitFlag = async (n, t = 60000) => { const o = ROLE === 'A' ? 'B' : 'A'; const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(`${SH}/${o}_${n}`)) return true; await sleep(150); } return false; };
const THEMES = ['', 'neon', 'terminal', 'glass', 'pixel', 'manga', 'space'];
const res = {};
app.whenReady().then(async () => {
  await sleep(3000);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  const js = (c) => W.webContents.executeJavaScript(c);
  const errs = []; W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errs.push(e.message ?? e.params?.message); });
  const waitFor = async (expr, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if (await js(expr)) return true; } catch { } await sleep(200); } return false; };
  const shot = async (n) => fs.writeFileSync(`${SH}/${n}.png`, (await W.webContents.capturePage()).toPNG());
  const each = async (name, prep) => { for (const t of THEMES) { await js(`applyTheme('${t}'); true`); if (prep) await prep(); await sleep(450); await shot(`${name}_${t || 'standard'}`); } await js(`applyTheme(''); true`); };
  try {
    await waitFor(`friendsList[0] && friendsList[0].online`, 30000);
    W.setSize(1180, 760);
    if (ROLE === 'A') {
      // выбор темы в настройках: клик сохраняет
      await js(`openSettings(); true`); await sleep(600);
      await js(`document.querySelector('#themeGrid [data-id="space"]').click(); true`);
      res.themeSaved = await js(`settings().theme === 'space' && document.documentElement.dataset.theme === 'space' && document.querySelector('#themeGrid .selected').dataset.id === 'space'`);
      await js(`document.querySelector('#themeGrid [data-id=""]').click(); true`);
      res.themeStd = await js(`settings().theme === '' && !document.documentElement.dataset.theme`);
      await each('settings');
      await js(`document.querySelector('#settings [data-close]').click(); openDm(friendsList[0].id)`); await sleep(600);
      await each('dm');
      await js(`closeDm(); true`);
    }
    flag('ready'); await waitFlag('ready');
    if (ROLE === 'B') { await js(`callFriend(friendsList[0].id); true`); }
    else {
      await waitFor(`!document.getElementById('callModal').classList.contains('hidden')`, 30000); await sleep(500);
      await each('incoming');
      await js(`document.getElementById('btnCallAccept').click(); true`);
    }
    await waitFor(`S.connected`, 40000);
    await sleep(1200);
    if (ROLE === 'A') {
      await js(`document.getElementById('btnSoundpad').click(); true`); await sleep(400);
      await each('soundpad');
      await js(`document.getElementById('btnSoundpad').click(); true`);
      await js(`document.getElementById('btnShare').click(); true`); await sleep(1500);
      await each('picker');
      await js(`document.querySelector('#picker [data-close]').click(); true`);
      flag('wantshare');
      await waitFlag('sharing', 40000); await sleep(2500);
      const r = await js(`(() => { const b = document.getElementById('remoteScreenWrap').getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; })()`);
      await each('stream', async () => { W.webContents.sendInputEvent({ type: 'mouseMove', x: r[0] + Math.round(Math.random() * 10), y: r[1] }); });
      // перезапуск окна: тема применяется сразу при загрузке
      await js(`store.set('settings', { ...settings(), theme: 'manga' }); true`);
      W.webContents.reload(); await sleep(2500);
      res.themeAfterReload = await js(`document.documentElement.dataset.theme`);
      await js(`store.set('settings', { ...settings(), theme: '' }); true`);
    } else {
      await waitFlag('wantshare', 60000);
      for (let i = 0; i < 3 && !(await js(`!!S.localScreen`)); i++) { await js(`(async () => { const l = await window.duo.getSources(); pickedId = (l.find(s=>s.isScreen)||l[0]).id; document.getElementById('quality').value='720p30'; await beginShare(); return true })()`).catch(() => {}); await sleep(3000); }
      flag('sharing');
    }
    await sleep(800); flag('done'); await waitFlag('done', 120000);
  } catch (e) { res.exception = String(e.stack || e); }
  res.errors = errs.slice(0, 5);
  console.log(ROLE, 'RESULT', JSON.stringify(res));
  app.exit(0);
});
