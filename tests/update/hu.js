const { app, BrowserWindow } = require('electron');
const fs = require('fs');
require('./main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROLE = process.env.ROLE, SH = process.env.SHARED;
const flag = (n) => fs.writeFileSync(`${SH}/${ROLE}_${n}`, '1');
const waitFlag = async (n, t=90000) => { const o=ROLE==='A'?'B':'A'; const s=Date.now(); while(Date.now()-s<t){ if(fs.existsSync(`${SH}/${o}_${n}`)) return true; await sleep(200);} return false; };
const res = {};
app.whenReady().then(async () => {
  await sleep(3000);
  const W = BrowserWindow.getAllWindows()[0];
  const js = (c) => W.webContents.executeJavaScript(c);
  const errs=[]; W.webContents.on('console-message',(e)=>{const l=e.level??e.params?.level; if(l==='error') errs.push(e.message??e.params?.message);});
  const waitFor=async(e,t=20000)=>{const s=Date.now();while(Date.now()-s<t){try{if(await js(e))return true;}catch{}await sleep(250);}return false;};
  try {
    await js(`store.set('settings',{...settings(),noStun:true}); window.duo.netConfig({noStun:true}); true`);
    res.myVer = await js(`myUpd && myUpd.v`).catch(()=>null);
    res.ownOffer = (await js(`(async()=>!!(await window.duo.updOffer()))()`));
    await waitFor(`friendsList[0] && friendsList[0].online`, 30000);
    await sleep(2000); // дать пингам донести версию
    if (ROLE === 'A') {
      res.friendVer = await js(`friendsList[0] && friendsList[0].ver`);
      res.updButton = await waitFor(`!!document.querySelector('#friendsList .fupd')`, 10000);
      flag('ready'); await waitFlag('ready');
      // запустить обновление
      await js(`startUpdatePull(friendsList[0].id, friendsList[0].nick, friendsList[0].ver); true`);
      res.staged = await waitFor(`!document.getElementById('updApply').classList.contains('hidden')`, 40000);
      res.updText = await js(`document.getElementById('updText').textContent`);
      if (res.staged) {
        await js(`doUpdateApply(); true`);
        // fake helper apply пишет result.txt в stagingDir (userData/update-staging)
        const sdir = process.env.ALOCALLS_USERDATA + '/update-staging';
        for (let i=0;i<40 && !fs.existsSync(sdir+'/result.txt'); i++) await sleep(250);
        res.applyResult = (()=>{try{return fs.readFileSync(sdir+'/result.txt','utf-8')}catch{return 'no-result'}})();
        // проверим, что файлы «установились» в resDir (updA)
        const f="require" ;
        res.installedAsarMatches = (()=>{try{const crypto=require('crypto');const ofs=require('original-fs');const a=crypto.createHash('sha256').update(ofs.readFileSync(process.env.ALOCALLS_UPDATE_DIR+'/app.asar')).digest('hex');const stg=crypto.createHash('sha256').update(ofs.readFileSync(sdir+'/1.12.1/app.asar')).digest('hex');return a===stg;}catch(e){return String(e.message)}})();
      }
      flag('done');
    } else {
      flag('ready'); await waitFlag('ready');
      await waitFlag('done', 60000);
    }
  } catch(e){ res.exception=String(e.stack||e); }
  res.errors=errs.slice(0,6);
  console.log(ROLE,'RESULT',JSON.stringify(res));
  app.exit(0);
});
