const { app, BrowserWindow } = require('electron');
const fs = require('fs');
require('./main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MF = process.env.MODEFILE;
const res = {};
app.whenReady().then(async () => {
  await sleep(3000);
  const W = BrowserWindow.getAllWindows()[0];
  const js = (c) => W.webContents.executeJavaScript(c);
  const errs = []; W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errs.push(e.message ?? e.params?.message); });
  const check = async () => { await js(`ghCheckNow(true)`); return js(`({ status: document.getElementById('ghStatus').textContent, modal: !document.getElementById('updModal').classList.contains('hidden'), apply: !document.getElementById('updApply').classList.contains('hidden'), text: document.getElementById('updText').textContent })`); };
  try {
    res.myVer = await js(`myUpd && myUpd.v`);
    fs.writeFileSync(MF, 'badsig'); res.badsig = await check();
    fs.writeFileSync(MF, 'badfile'); res.badfile = await check();
    res.stagedAfterBad = await js(`window.duo.updStaged()`);
    fs.writeFileSync(MF, 'ok'); res.good = await check();
    if (res.good.apply) {
      await js(`doUpdateApply(); true`);
      const sdir = process.env.ALOCALLS_USERDATA + '/update-staging';
      for (let i = 0; i < 40 && !fs.existsSync(sdir + '/result.txt'); i++) await sleep(250);
      res.applyResult = (() => { try { return fs.readFileSync(sdir + '/result.txt', 'utf-8'); } catch { return 'no-result'; } })();
      const crypto = require('crypto'), ofs = require('original-fs');
      const h = (f) => crypto.createHash('sha256').update(ofs.readFileSync(f)).digest('hex');
      res.installedIs1131 = h(process.env.ALOCALLS_UPDATE_DIR + '/app.asar') === h(process.env.RELDIR + '/app.asar');
    }
  } catch (e) { res.exception = String(e.stack || e); }
  res.errors = errs.slice(0, 5);
  console.log('RESULT', JSON.stringify(res, null, 1));
  app.exit(0);
});
